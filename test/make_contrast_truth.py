"""Reference values for the ImageJ contrast algorithms.

Run this after make_fixtures.py (``npm run fixtures`` does both); it reads the
fixture pixels, so it goes stale the moment they are regenerated.

The functions below are a direct transcription of the Java quoted in
docs/IMAGEJ_ANALYSIS.md (ContrastAdjuster.autoAdjust and
ContrastEnhancer.stretchHistogram). They are written independently of the
TypeScript port so that the Node tests are a real cross-check of the port,
not a restatement of it.
"""
import json, os
import numpy as np
import tifffile

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, 'fixtures')
N_BINS = 256
AUTO_THRESHOLD = 5000


def statistics(a):
    """ij.process.ImageStatistics: 256 bins over the data range.

    8-bit images are pinned to their full type range with a bin size of 1,
    which is what ImageJ's ByteStatistics does.
    """
    flat = np.asarray(a).ravel()
    finite = flat[np.isfinite(flat)] if flat.dtype.kind == 'f' else flat
    count = int(finite.size)
    dmin = float(finite.min())
    dmax = float(finite.max())

    # 8-bit: the histogram is a direct value count (ByteProcessor.getHistogram).
    # Other integers: 256 bins over min..max *inclusive* (ShortStatistics).
    # Float: 256 bins over min..max (FloatStatistics).
    eight_bit = flat.dtype in (np.uint8, np.int8)
    integer = flat.dtype.kind in 'iu'
    if eight_bit:
        hist_min = -128.0 if flat.dtype == np.int8 else 0.0
        hist_max = hist_min + 255.0
        bin_size = 1.0
        scale = 1.0
    elif integer:
        hist_min, hist_max = dmin, dmax
        span = hist_max - hist_min + 1.0
        bin_size = span / N_BINS
        scale = N_BINS / span
    else:
        hist_min, hist_max = dmin, dmax
        span = hist_max - hist_min
        bin_size = span / N_BINS
        scale = N_BINS / span if span > 0 else 0.0

    hist = np.zeros(N_BINS, dtype=np.int64)
    vals = finite.astype(np.float64)
    if eight_bit:
        idx = (vals - hist_min).astype(np.int64)
    elif scale > 0:
        idx = np.floor(scale * (vals - hist_min)).astype(np.int64)
    else:
        idx = np.zeros(vals.size, dtype=np.int64)
    np.clip(idx, 0, N_BINS - 1, out=idx)
    np.add.at(hist, idx, 1)

    mean = float(np.float64(finite).mean())
    sd = float(np.float64(finite).std(ddof=1)) if count > 1 else 0.0
    return {
        'pixelCount': count, 'min': dmin, 'max': dmax, 'mean': mean, 'stdDev': sd,
        'histMin': hist_min, 'histMax': hist_max, 'binSize': bin_size,
        'histogram': hist.tolist(),
        'nonFiniteCount': int(flat.size - count),
    }


def auto_adjust(st, auto_threshold):
    """ContrastAdjuster.autoAdjust."""
    if auto_threshold < 10:
        auto_threshold = AUTO_THRESHOLD
    else:
        auto_threshold = auto_threshold // 2
    hist = st['histogram']
    pixel_count = st['pixelCount']
    limit = pixel_count // 10
    threshold = pixel_count // auto_threshold

    i = -1
    found = False
    while not found and i < 255:
        i += 1
        c = hist[i]
        if c > limit:
            c = 0
        found = c > threshold
    hmin = i

    i = 256
    found = False
    while not found and i > 0:
        i -= 1
        c = hist[i]
        if c > limit:
            c = 0
        found = c > threshold
    hmax = i

    if hmax >= hmin:
        lo = st['histMin'] + hmin * st['binSize']
        hi = st['histMin'] + hmax * st['binSize']
        if lo == hi:
            lo, hi = st['min'], st['max']
        return {'min': lo, 'max': hi}, auto_threshold
    return {'min': st['min'], 'max': st['max']}, auto_threshold


def stretch_histogram(st, saturated=0.35):
    """ContrastEnhancer.stretchHistogram."""
    hist = st['histogram']
    pixel_count = st['pixelCount']
    threshold = int(pixel_count * saturated / 200.0) if saturated > 0 else 0

    i, count, found = -1, 0, False
    while not found and i < 255:
        i += 1
        count += hist[i]
        found = count > threshold
    hmin = i

    i, count, found = 256, 0, False
    while not found and i > 0:
        i -= 1
        count += hist[i]
        found = count > threshold
    hmax = i

    if hmax > hmin:
        lo = st['histMin'] + hmin * st['binSize']
        hi = st['histMin'] + hmax * st['binSize']
        if lo != hi:
            return {'min': lo, 'max': hi}
    return {'min': st['min'], 'max': st['max']}


def map8(a, lo, hi):
    """ij.process.FloatProcessor.create8BitImage.

    Note the exact rounding: clamp the low end to zero first, then truncate
    value*scale + 0.5, then clamp the high end to 255.
    """
    a = np.asarray(a)
    finite = np.isfinite(a) if a.dtype.kind == 'f' else np.ones(a.shape, bool)
    v = a.astype(np.float64) - lo
    np.clip(v, 0, None, out=v)
    scale = 255.0 / (hi - lo)
    iv = np.trunc(v * scale + 0.5)
    np.clip(iv, 0, 255, out=iv)
    iv[~finite] = 0
    return iv.astype(np.uint8)


def render_probe(a, lo, hi):
    out = map8(a, lo, hi).ravel()
    counts = np.bincount(out, minlength=256).tolist()
    idx = [0, 1, 2, 3, out.size // 7, out.size // 3, out.size // 2, out.size - 1]
    return {
        'range': {'min': float(lo), 'max': float(hi)},
        'counts': counts,
        'samples': [[int(i), int(out[i])] for i in idx],
    }


CASES = [
    'f32_ct_like', 'f32_none', 'u16_none', 'i16_none', 'u8_none', 'i8_none',
    'u32_none', 'i32_none', 'f64', 'f32_nan_inf', 'big_f32_lzw', 'stack_f32',
    'f32_odd',
]

out = {}
for name in CASES:
    path = os.path.join(FIX, name + '.tif')
    with tifffile.TiffFile(path) as t:
        a = t.pages[0].asarray()
    st = statistics(a)
    autos = []
    at = 0
    for _ in range(6):
        rng_, at = auto_adjust(st, at)
        autos.append({'range': rng_, 'autoThreshold': at})
    ranges = [
        (st['min'], st['max']),
        (autos[0]['range']['min'], autos[0]['range']['max']),
        (st['min'] + 0.25 * (st['max'] - st['min']), st['min'] + 0.6 * (st['max'] - st['min'])),
    ]
    out[name] = {
        'stats': st,
        'auto': autos,
        'stretch': {str(s): stretch_histogram(st, s) for s in (0.35, 0.0, 0.1, 1.0, 5.0, 35.0)},
        'render': [render_probe(a, lo, hi) for lo, hi in ranges if hi > lo],
    }
    print(f'{name:16s} min={st["min"]:.6g} max={st["max"]:.6g} '
          f'auto1=[{autos[0]["range"]["min"]:.6g}, {autos[0]["range"]["max"]:.6g}]')

# The user's own image, if present - the case that motivated the project.
real = os.path.join(HERE, '..', 'sample.tif')
if os.path.exists(real):
    with tifffile.TiffFile(real) as t:
        a = t.pages[0].asarray()
    st = statistics(a)
    autos = []
    at = 0
    for _ in range(6):
        rng_, at = auto_adjust(st, at)
        autos.append({'range': rng_, 'autoThreshold': at})
    out['__real__'] = {
        'stats': st, 'auto': autos,
        'stretch': {str(s): stretch_histogram(st, s) for s in (0.35, 0.0, 0.1, 1.0, 5.0, 35.0)},
        'render': [
            render_probe(a, st['min'], st['max']),
            render_probe(a, autos[0]['range']['min'], autos[0]['range']['max']),
        ],
    }
    print(f'\nsample.tif: data [{st["min"]:.6g}, {st["max"]:.6g}]')
    print(f'  ImageJ Auto     -> [{autos[0]["range"]["min"]:.6g}, {autos[0]["range"]["max"]:.6g}]')
    print(f'  Enhance 0.35%   -> [{out["__real__"]["stretch"]["0.35"]["min"]:.6g}, '
          f'{out["__real__"]["stretch"]["0.35"]["max"]:.6g}]')

with open(os.path.join(FIX, 'contrast_truth.json'), 'w') as f:
    json.dump(out, f, indent=1, allow_nan=False)
print(f'\n{len(out)} contrast references written')

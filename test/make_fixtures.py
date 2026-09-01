"""Generate TIFF fixtures with tifffile, plus a JSON of ground-truth values.

The JSON is what the Node tests assert against, so the reference implementation
for our decoder is literally tifffile/numpy.

Every fixture draws from one shared generator, so adding or reordering a fixture
changes the pixels of the ones after it. That is fine, but it means the two
truth files must always be rebuilt together:

    npm run fixtures

which runs this script and then make_contrast_truth.py.
"""
import json, os
import numpy as np
import tifffile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')
os.makedirs(OUT, exist_ok=True)

rng = np.random.default_rng(1234)
truth = {}

def enc(x):
    """JSON has no NaN/Inf literals; encode them as tagged strings."""
    x = float(x)
    if x != x: return 'NaN'
    if x == float('inf'): return 'Infinity'
    if x == float('-inf'): return '-Infinity'
    return x


def canonical(page):
    """Page pixels in our interleaved (y, x, sample) order.

    tifffile hands back planar pages sample-first as (S, Y, X); the decoder
    always produces interleaved samples, so normalise before fingerprinting.
    """
    a = page.asarray()
    if page.samplesperpixel > 1 and int(page.planarconfig) == 2:
        a = np.moveaxis(a, 0, -1)
    return np.ascontiguousarray(a)


def page_probe(page):
    pr = probe(canonical(page))
    pr['width'] = int(page.imagewidth)
    pr['height'] = int(page.imagelength)
    pr['spp'] = int(page.samplesperpixel)
    pr['planar'] = int(page.planarconfig)
    return pr


def probe(a):
    """A compact fingerprint: shape, dtype, extremes, and scattered samples."""
    flat = np.asarray(a).ravel()
    idx = list(range(0, min(8, flat.size)))
    if flat.size > 8:
        idx += [flat.size // 3, flat.size // 2, (2 * flat.size) // 3, flat.size - 1]
    finite = flat[np.isfinite(flat)] if flat.dtype.kind == 'f' else flat
    return {
        'shape': list(np.asarray(a).shape),
        'dtype': str(np.asarray(a).dtype),
        'min': float(finite.min()) if finite.size else None,
        'max': float(finite.max()) if finite.size else None,
        'sum': float(np.float64(finite).sum()) if finite.size else 0.0,
        'samples': [[int(i), enc(flat[i])] for i in idx],
    }

def emit(name, array, pages=None, **kw):
    path = os.path.join(OUT, name + '.tif')
    tifffile.imwrite(path, array, **kw)
    with tifffile.TiffFile(path) as t:
        back = t.asarray()
        page_probes = [page_probe(p) for p in t.pages]
        info = {
            'file': name + '.tif',
            'pageCount': len(t.pages),
            'bigtiff': t.is_bigtiff,
            'byteorder': t.byteorder,
            'whole': probe(back),
            'pages': page_probes,
            'description': t.pages[0].description,
        }
    truth[name] = info
    print(f'{name:28s} {info["whole"]["dtype"]:>8s} {str(info["whole"]["shape"]):>18s} '
          f'pages={info["pageCount"]}')

# --- the shapes real CT work produces -------------------------------------
h, w = 64, 96
ramp = (np.arange(h * w, dtype=np.float32).reshape(h, w) / (h * w)).astype(np.float32)
noise = rng.normal(0, 1, (h, w)).astype(np.float32)

# Mimic the user's file: normalised CT slice, large constant background.
ct = np.full((h, w), -1.0, dtype=np.float32)
ct[16:48, 24:72] = rng.uniform(-0.6, 0.98, (32, 48)).astype(np.float32)

emit('f32_none', ct)
emit('f32_ct_like', ct * 1.0)
emit('f32_deflate', ct, compression='zlib')
emit('f32_lzw', ct, compression='lzw')
emit('f32_packbits', ct, compression='packbits')
emit('f32_lzw_pred3', ct, compression='lzw', predictor=True)
emit('f32_deflate_pred3', ct, compression='zlib', predictor=True)
emit('f64', (ct.astype(np.float64) * 1e6))
emit('f32_bigendian', ct, byteorder='>')
emit('f32_bigtiff', ct, bigtiff=True)
emit('f32_tiled', np.ascontiguousarray(ct), tile=(32, 32))
emit('f32_tiled_lzw', np.ascontiguousarray(ct), tile=(32, 32), compression='lzw')
emit('f32_strips', ct, rowsperstrip=8)
emit('f32_strips_lzw', ct, rowsperstrip=8, compression='lzw')

u16 = (rng.integers(0, 65535, (h, w))).astype(np.uint16)
emit('u16_none', u16)
emit('u16_lzw', u16, compression='lzw')
emit('u16_lzw_pred2', u16, compression='lzw', predictor=2)
emit('u16_deflate_pred2', u16, compression='zlib', predictor=2)
emit('u16_bigendian', u16, byteorder='>')

i16 = (rng.integers(-32768, 32767, (h, w))).astype(np.int16)
emit('i16_none', i16)
emit('i16_lzw_pred2', i16, compression='lzw', predictor=2)

emit('u8_none', rng.integers(0, 255, (h, w)).astype(np.uint8))
emit('i8_none', rng.integers(-128, 127, (h, w)).astype(np.int8))
emit('u32_none', rng.integers(0, 2**32 - 1, (h, w)).astype(np.uint32))
emit('i32_none', rng.integers(-(2**31), 2**31 - 1, (h, w)).astype(np.int32))

# RGB
rgb = rng.integers(0, 255, (h, w, 3)).astype(np.uint8)
emit('rgb_u8', rgb, photometric='rgb')
emit('rgb_u8_lzw', rgb, photometric='rgb', compression='lzw')
emit('rgb_u8_planar', np.ascontiguousarray(rgb.transpose(2, 0, 1)), photometric='rgb', planarconfig='separate')
emit('rgb_u16', rng.integers(0, 65535, (h, w, 3)).astype(np.uint16), photometric='rgb')
emit('rgb_u16_planar',
     np.ascontiguousarray(rng.integers(0, 65535, (h, w, 3)).astype(np.uint16).transpose(2, 0, 1)),
     photometric='rgb', planarconfig='separate')
emit('rgb_f32_planar_lzw',
     np.ascontiguousarray(rng.random((h, w, 3)).astype(np.float32).transpose(2, 0, 1)),
     photometric='rgb', planarconfig='separate', compression='lzw')

# Stacks - the multi-page case
stack = np.stack([ct + i * 0.05 for i in range(7)]).astype(np.float32)
emit('stack_f32', stack)
emit('stack_f32_lzw', stack, compression='lzw')
emit('stack_u16', (rng.integers(0, 4095, (5, h, w))).astype(np.uint16))
emit('stack_4d', rng.random((3, 4, h, w)).astype(np.float32))

# ImageJ-flavoured metadata, including a saved display range
tifffile.imwrite(
    os.path.join(OUT, 'imagej_stack.tif'),
    (rng.random((6, h, w)) * 1000).astype(np.float32),
    imagej=True, metadata={'axes': 'ZYX', 'min': 12.5, 'max': 987.5, 'unit': 'micron', 'spacing': 2.0},
)
with tifffile.TiffFile(os.path.join(OUT, 'imagej_stack.tif')) as t:
    truth['imagej_stack'] = {
        'file': 'imagej_stack.tif', 'pageCount': len(t.pages), 'bigtiff': t.is_bigtiff,
        'byteorder': t.byteorder, 'whole': probe(t.asarray()),
        'pages': [page_probe(p) for p in t.pages],
        'description': t.pages[0].description,
    }
print('imagej_stack                 written')

# A genuine ImageJ hyperstack: 2 channels x 3 slices x 2 frames = 12 pages.
hyper = (rng.random((2, 3, 2, h, w)) * np.array([100, 5000])[None, None, :, None, None]).astype(np.float32)
tifffile.imwrite(
    os.path.join(OUT, 'imagej_hyperstack.tif'), hyper,
    imagej=True, metadata={'axes': 'TZCYX'},
)
with tifffile.TiffFile(os.path.join(OUT, 'imagej_hyperstack.tif')) as t:
    truth['imagej_hyperstack'] = {
        'file': 'imagej_hyperstack.tif', 'pageCount': len(t.pages), 'bigtiff': t.is_bigtiff,
        'byteorder': t.byteorder, 'whole': probe(t.asarray()),
        'pages': [page_probe(p) for p in t.pages],
        'description': t.pages[0].description,
    }
print('imagej_hyperstack           written',
      truth['imagej_hyperstack']['pageCount'], 'pages')

# NaN / Inf handling
nanimg = ramp.copy()
nanimg[0, 0] = np.nan
nanimg[0, 1] = np.inf
nanimg[0, 2] = -np.inf
emit('f32_nan_inf', nanimg)

# Non-square and odd dimensions catch stride bugs
emit('f32_odd', rng.random((37, 53)).astype(np.float32))
emit('f32_odd_tiled', np.ascontiguousarray(rng.random((37, 53)).astype(np.float32)), tile=(16, 16))
emit('u16_odd_lzw_pred2', rng.integers(0, 4095, (37, 53)).astype(np.uint16), compression='lzw', predictor=2)

# --- stress cases -----------------------------------------------------------
# Big enough that LZW fills and resets its 4096-entry dictionary many times,
# which is where code-width bumps and the KwKwK case actually get exercised.
big = np.zeros((512, 640), dtype=np.float32)
big[100:400, 120:500] = rng.random((300, 380)).astype(np.float32)
big[:, :60] = 0.5  # long runs -> long dictionary entries
emit('big_f32_lzw', big, compression='lzw')
emit('big_f32_lzw_pred3', big, compression='lzw', predictor=True)
emit('big_u16_lzw_pred2', (big * 60000).astype(np.uint16), compression='lzw', predictor=2)
emit('big_f32_packbits', big, compression='packbits')
emit('big_u8_lzw', (big * 255).astype(np.uint8), compression='lzw')
emit('f64_lzw_pred3', big.astype(np.float64), compression='lzw', predictor=True)
emit('f64_deflate_pred3', big.astype(np.float64), compression='zlib', predictor=True)
emit('big_f32_tiled_lzw_pred3', np.ascontiguousarray(big), tile=(128, 128), compression='lzw', predictor=True)
emit('u32_lzw_pred2', (rng.integers(0, 2**32 - 1, (h, w))).astype(np.uint32), compression='lzw', predictor=2)

with open(os.path.join(OUT, 'truth.json'), 'w') as f:
    json.dump(truth, f, indent=1, allow_nan=False)
print(f'\n{len(truth)} fixtures -> {OUT}')

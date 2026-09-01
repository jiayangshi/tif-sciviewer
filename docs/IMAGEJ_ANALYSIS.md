# How ImageJ Displays a Scientific TIFF

Source-level analysis of the ImageJ 1.x pipeline that we replicate.

## 1. The core insight: data vs. display are decoupled

Everything hinges on one design decision in `ij.process.ImageProcessor`:

```java
public abstract class ImageProcessor {
    protected double minThreshold, maxThreshold;   // display range
    ...
    public abstract void setMinAndMax(double min, double max);
}
```

The *pixel data* (float/16-bit/signed) is never modified. A separate pair
`(min, max)` — the **display range** — defines the affine map to 8-bit screen
values. `FloatProcessor.create8BitImage()` is literally:

```java
double value;
int ivalue;
double min2 = getMin(), max2 = getMax();
double scale = 255.0/(max2-min2);
for (int i=0; i<size; i++) {
    value = pixels[i]-min2;
    if (value<0.0) value = 0.0;
    ivalue = (int)(value*scale + 0.5);
    if (ivalue>255) ivalue = 255;
    pixels8[i] = (byte)ivalue;
}
```

Note the exact rounding: `(int)(value*scale + 0.5)` after clamping the low end
at 0, and a separate clamp at 255. `ShortProcessor` does the same. This is why
a float image with range [-1, 0.98] renders as a black rectangle in a naive
viewer (which assumes [0,1] or [0,255]) but looks correct in ImageJ.

**Requirement: our viewer must keep the decoded numeric data and apply
`(v - min) * 255/(max - min)` at draw time, never bake it into the file.**

## 2. Statistics and the 256-bin histogram

`ij.process.ImageStatistics` / `FloatStatistics` builds a **256-bin histogram**
for 16/32-bit images, spanning the *actual data range*:

```java
histMin = ip.getMin();          // real data minimum
histMax = ip.getMax();          // real data maximum
binSize = (histMax-histMin)/nBins;   // nBins = 256
...
int index = (int)(scale*(v-histMin));   // scale = nBins/(histMax-histMin)
if (index>=nBins) index = nBins-1;
histogram[index]++;
```

All auto-contrast logic operates on this 256-bin summary, not the raw pixels.
That is what makes ImageJ's Auto instantaneous on huge images, and we copy it.

## 3. `Auto` in Brightness/Contrast (`ij.plugin.frame.ContrastAdjuster.autoAdjust`)

This is the button people actually press. The algorithm:

```java
static final int AUTO_THRESHOLD = 5000;
int autoThreshold;   // instance state, persists between clicks

void autoAdjust(ImagePlus imp, ImageProcessor ip) {
    ImageStatistics stats = imp.getRawStatistics();
    int limit = stats.pixelCount/10;
    int[] histogram = stats.histogram;
    if (autoThreshold<10) autoThreshold = AUTO_THRESHOLD;
    else autoThreshold /= 2;
    int threshold = stats.pixelCount/autoThreshold;
    int i = -1; boolean found = false; int count;
    do {
        i++;
        count = histogram[i];
        if (count>limit) count = 0;      // <-- ignore dominant bins
        found = count > threshold;
    } while (!found && i<255);
    int hmin = i;
    i = 256;
    do {
        i--;
        count = histogram[i];
        if (count>limit) count = 0;      // <-- ignore dominant bins
        found = count > threshold;
    } while (!found && i>0);
    int hmax = i;
    if (hmax>=hmin) {
        min = stats.histMin + hmin*stats.binSize;
        max = stats.histMin + hmax*stats.binSize;
        if (min==max) { min=stats.min; max=stats.max; }
        ip.setMinAndMax(min, max);
    }
}
```

Two subtleties that matter enormously for CT data and that naive
percentile-stretch implementations miss:

1. **`limit = pixelCount/10`** — any histogram bin holding more than 10% of the
   image is treated as empty. A CT slice padded with a constant air/background
   value has a single enormous bin; without this rule the stretch would latch
   onto it and nothing would improve. Our `debug_single_gt.tif` is exactly this
   case: a large plateau at -1.0.
2. **`autoThreshold` is stateful** — repeated clicks on Auto halve the
   threshold, progressively widening... in effect making the test stricter and
   the range tighter. After it drops below 10 it resets to 5000. So Auto cycles
   through a series of increasingly aggressive stretches. This must be
   reproduced or repeated clicks feel dead.

## 4. `Enhance Contrast` (`ij.plugin.ContrastEnhancer.stretchHistogram`)

A *different*, simpler algorithm exposed as Process > Enhance Contrast, with a
"saturated" percentage (default **0.35%**):

```java
threshold = (int)(stats.pixelCount*saturated/200.0);   // /200: split both ends
int i = -1; int count = 0; boolean found;
do { i++; count += histogram[i]; found = count>threshold; } while (!found && i<255);
hmin = i;
i = 256; count = 0;
do { i--; count += histogram[i]; found = count>threshold; } while (!found && i>0);
hmax = i;
```

Cumulative, not per-bin, and with no `limit` rule — so it *does* respect a
dominant background peak. Having both is valuable: `Auto` for "show me the
structure", `Enhance Contrast` for "clip exactly 0.35% of pixels".

## 5. `Reset` and `Set`

- **Reset** restores the display range to the full data range (`stats.min`,
  `stats.max`); for 8-bit/RGB it is fixed at 0-255.
- **Set** opens a dialog for typing exact min/max — essential for comparing two
  images on an identical scale, a very common scientific need.

## 6. Brightness / Contrast sliders

The B&C window has four sliders. Brightness and Contrast are derived views over
the same `(min,max)` pair, not independent state:

```java
void updateMinAndMax() {   // from brightness/contrast slider values
    double mid = (defaultMin+defaultMax)/2 ... 
}
// brightness: slides the window's center, keeping width
// contrast:   changes the window's width, keeping center
```
Concretely, with `range = defaultMax-defaultMin`:
- brightness value `b` in [0,1] → center = defaultMax - b*range ... window
  re-centred, width preserved.
- contrast value `c` in [0,1] → width = range * (1-c) scaled exponentially;
  ImageJ uses `slope = c<=0.5 ? c*2 : 1/((1-c)*2)` style mapping about the
  centre.

We expose min/max as primary (that is what scientists reason about) and
brightness/contrast as derived sliders.

## 7. TIFF reading (`ij.io.TiffDecoder` + `ij.io.ImageReader`)

`TiffDecoder` is a from-scratch IFD walker, deliberately not using ImageIO
(which is baseline-8-bit-centric). Relevant capabilities:

- Both byte orders (`II`/`MM`); ImageJ also handles BigTIFF in later versions.
- `SampleFormat` (339): 1 = unsigned int, 2 = **signed int**, 3 = **IEEE float**.
  Combined with `BitsPerSample` (258) this yields ImageJ's file types
  `GRAY8, GRAY16_SIGNED, GRAY16_UNSIGNED, GRAY32_INT, GRAY32_UNSIGNED,
   GRAY32_FLOAT, GRAY64_FLOAT, RGB, RGB_PLANAR, ...`.
- Compression (259): none, LZW (+ **horizontal differencing predictor**, tag
  317), PackBits, Deflate/ZIP.
- Strips (273/279) **and** tiles (322/323/324/325).
- `PlanarConfiguration` (284) 1 = chunky, 2 = planar.
- **Signed 16-bit is stored offset by 32768** on read
  (`ij.io.ImageReader`: ImageJ adds 32768 and records a calibration function),
  a detail worth knowing since we instead keep true signed values.
- ImageJ writes and parses its own `ImageDescription` (270) block:
  `ImageJ=1.53t\nimages=120\nchannels=2\nslices=60\nhyperstack=true\nmin=...\nmax=...`
  — including the **saved display range** (`min=`/`max=`). We honour that.
- `tifffile` (what this project writes with) puts JSON in the same tag:
  `{"shape": [512, 512]}`, and for real stacks a fuller record. We parse it to
  recover the logical shape.

## 8. Multi-dimensional data

`ImagePlus` holds an `ImageStack`; a **hyperstack** adds c/z/t axes with
independent sliders. Crucially the display range in ImageJ is *per-channel*, and
by default a new slice keeps the current range — you can also choose to
recompute per slice. Both behaviours are needed.

## 9. LUTs

`ij.process.LUT` extends `IndexColorModel`: a 256-entry RGB table applied after
the min/max mapping. Grays is the default; Fire, Ice, Spectrum, and the
single-channel Red/Green/Blue are the commonly used ones. `Invert LUT` flips the
table, which is the standard way radiologists view CT.

## 10. Interaction details worth copying

- Zoom levels are a fixed ladder: `1/72 … 1/32, 1/16, 1/12, 1/8, 1/6, 1/4, 1/3,
  1/2, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32`. `+`/`-` step the ladder,
  and zoom is anchored at the cursor.
- The status bar continuously shows `x=..., y=..., value=...` for the pixel under
  the cursor — the single most-used feature for checking CT numbers. For float
  images the raw float is shown, not the 8-bit screen value.
- Nearest-neighbour interpolation when zoomed in (never smooth — smoothing
  invents data).
- `Ctrl+Shift+C` opens B&C; `Ctrl+H` opens the histogram.

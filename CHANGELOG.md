# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/).

## [0.1.1] - 2026-09-16

Second release.

### Added

- **Open as Stack**: select several single-slice `.tif` files in the Explorer
  and right-click to browse them as one stack, the way ImageJ's
  *File > Import > Image Sequence* works. Members are sorted numerically, so the
  Explorer's click order does not matter; the slice readout names the file on
  screen; and files are opened lazily behind a small handle pool, so a
  thousand-slice volume costs a thousand header reads and one decode.
- Files whose shape or pixel type differs from the first are refused by name,
  rather than silently producing a stack that changes size midway.

### Fixed

- Setting Min or Max with its slider, or with a handle under the histogram, now
  keeps the whole display range inside the data of the slice on screen, as
  ImageJ's B&C does. Moving one end used to leave the other wherever it was, so
  a range typed in, or held from a brighter slice, could stay beyond the data;
  now it is pulled back to the slice's own min or max. The histogram handles
  also stop at the data rather than at the edge of the histogram, which for
  8-bit images reaches one level past it. Typing a range is still unrestricted,
  like ImageJ's *Set*.
- Opening a stack now windows the *stack*, not its first slice. Auto-contrast
  was computed from slice 1 alone, so holding that range left every slice at a
  different level drawn as flat white until you pressed Auto again. The opening
  window is now the union of auto-contrast across slices sampled through the
  stack - at most eight of them, fewer for large slices, so opening stays fast.
  In a hyperstack each channel is sampled and windowed on its own, so a 0..100
  channel sharing a file with a 0..5000 one does not open at the wider window.

## [0.1.0] - 2026-08-27

First release.

### Added

- Custom read-only editor for `.tif` / `.tiff`, replacing VS Code's built-in
  image preview, which cannot open non-8-bit TIFFs.
- TIFF reader covering the scientific subset: 8/16/32/64-bit integers (signed
  and unsigned), float16/32/64, RGB and planar RGB, classic TIFF and BigTIFF,
  both byte orders, strips and tiles, and LZW / Deflate / PackBits compression
  with horizontal and floating-point predictors.
- ImageJ display-range model: pixel data is never modified, and a separate
  `(min, max)` is mapped to the screen at draw time.
- `Auto` contrast, ported from `ContrastAdjuster.autoAdjust`, including the
  `pixelCount/10` bin limit and the stateful threshold that tightens on repeated
  presses.
- `Enhance` contrast, ported from `ContrastEnhancer.stretchHistogram`.
- `Reset`, exact numeric min/max entry, Min/Max/Brightness/Contrast sliders, and
  a histogram with draggable range handles.
- LUTs: Grays, Inverted Grays, Fire, Ice, Spectrum, 3-3-2 RGB, Red, Green, Blue.
- Multi-page stacks with a slice slider and arrow-key navigation, plus c/z/t
  axes and per-channel display ranges for ImageJ hyperstacks.
- Live `x, y, value` readout of the raw value under the cursor.
- Cursor-anchored zoom on ImageJ's ladder, always nearest-neighbour.
- Save the current view as a full-resolution PNG.
- NaN and Inf excluded from statistics and drawn in red.
- Lazy per-page decoding with a pixel-budgeted cache, so files larger than
  memory can be browsed.
- `extensionKind: workspace`, so decoding happens on the remote host under
  Remote-SSH and only one slice crosses the link.

# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/).

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

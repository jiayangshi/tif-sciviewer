# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/).

## [0.1.3] - 2026-09-27

Fixes found reviewing 0.1.2.

### Fixed

- Reading ahead no longer pushes the slice on screen out of the cache when a
  single slice is over half of it (8192² float32, 6000² uint16, 4096² RGB),
  which had every pause in a stack decode that slice twice.
- Save PNG pressed while the next slice was still on its way was silently
  dropped. It now saves that slice, at full resolution.
- When the slice the controls stop on cannot be read, it is not asked for again
  until the controls move, and the preview on screen still gets its whole slice.
- A page too small to gain from a preview - a thumbnail in a multi-page file of
  full slices, say - is always sent whole, instead of blocky.
- A 16- or 32-bit strip with predictor 2 that decompresses short is reported
  as an error again, instead of its missing rows reading as zero.

## [0.1.2] - 2026-09-27

Third release.

### Changed

- **Browsing a stack of large slices keeps up.** On 4096x4096 float32 files a
  step took over half a second, and a drag kept the image moving for seconds
  after the hand stopped, because every slider position was decoded and sent in
  turn. Measured in VS Code: a step now takes about 20 ms, and a drag lands on
  the slice under the slider as soon as it stops.
  - At most one slice is on its way at a time; when it lands, the viewer asks
    for wherever the controls are by then and skips what they passed.
  - Pixels travel to the webview as binary instead of an 85 MB base64 string,
    falling back to base64 by itself on a transport that mangles binary.
  - While the stack moves, only what the screen can show is sent - one sample
    per device pixel of the part in view - and the whole slice follows once the
    controls rest. The readout shows coordinates only where the preview does not
    hold that exact pixel, and Save PNG waits for the whole slice.
  - The host reads ahead one slice in the direction of travel when it would
    otherwise be idle.
  - The histogram pass is about 1.7x quicker, and LZW decoding about 3x.

### Fixed

- In a hyperstack, a slice that arrived after the channel slider had moved on
  was given the range of the channel on the slider rather than its own.

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

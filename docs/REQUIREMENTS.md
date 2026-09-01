# Requirements — tif-sciviewer

Derived from `IMAGEJ_ANALYSIS.md`. Status as built: **done** unless noted.
Deliberate omissions and their reasoning are in `ITERATIONS.md` under
"Known gaps".

## A. Decoding (ij.io.TiffDecoder parity)

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| A1 | Parse classic TIFF, both byte orders (`II`, `MM`) | must | done |
| A2 | Parse BigTIFF (version 43, 8-byte offsets) — tifffile emits it for >4 GB | must | done |
| A3 | BitsPerSample 8/16/32/64 with SampleFormat uint/int/float | must | done |
| A4 | float32 (the common `tifffile` CT output) and float64 | must | done |
| A5 | Signed int8/int16/int32, preserved as true signed values | must | done |
| A6 | Compression: none, LZW, PackBits, Deflate/ZIP; Zstd/LZMA/JPEG → clear error naming the codec | must | done |
| A7 | Horizontal differencing predictor (tag 317 = 2), incl. float predictor (=3) | must | done |
| A8 | Strip layout (273/278/279) and tile layout (322/323/324/325) | must | done |
| A9 | PlanarConfiguration chunky (1) and planar (2) | should | done |
| A10 | SamplesPerPixel 1 (gray), 3 (RGB), 4; a 4th sample stays opaque, never alpha | should | done |
| A11 | Multi-page files → stack | must | done |
| A12 | Parse ImageJ `ImageDescription` (images/channels/slices/frames/min/max/unit) | must | done |
| A13 | Parse `tifffile` JSON `ImageDescription` (`{"shape": [...]}`) | must | done |
| A14 | Lazy per-page decode; never hold the whole stack in memory at once | must | done |
| A15 | Report an actionable error for anything unsupported, naming the tag/codec | must | done |

## B. Display pipeline (ij.process parity)

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| B1 | Keep raw numeric data; map to 8-bit at draw time only | must | done |
| B2 | Exact ImageJ mapping `clamp0(v-min) * 255/(max-min) + 0.5`, clamp 255 | must | done |
| B3 | 256-bin histogram over the true data range, as `ImageStatistics` | must | done |
| B4 | `Auto` = `ContrastAdjuster.autoAdjust`, incl. `pixelCount/10` bin limit and stateful `autoThreshold` halving | must | done |
| B5 | `Enhance Contrast` = `stretchHistogram` with saturated %, default 0.35 | must | done |
| B6 | `Reset` → full data range | must | done |
| B7 | `Set` → exact numeric min/max entry | must | done |
| B8 | Brightness/Contrast sliders derived from (min,max) | should | done |
| B9 | NaN/Inf handling: excluded from stats, rendered as a distinct colour | must | done |
| B10 | Display range persists across slices; option to auto-recompute per slice | should | done |
| B11 | Per-channel display range for multi-channel images | could | done |

## C. Viewer UX

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| C1 | Opens as the default editor for `.tif`/`.tiff` (`CustomReadonlyEditorProvider`) | must | done |
| C2 | Live `x, y, value` readout of the raw value under the cursor | must | done |
| C3 | Zoom on ImageJ's ladder, cursor-anchored; pan by drag; fit-to-window | must | done |
| C4 | Nearest-neighbour sampling when zoomed in | must | done |
| C5 | Stack slider + keyboard nav for multi-page | must | done |
| C6 | Histogram view with draggable min/max handles | should | done |
| C7 | LUTs: Grays, Inverted Grays, Fire, Ice, Spectrum, 3-3-2, Red/Green/Blue | should | done |
| C8 | Info panel: dimensions, dtype, data min/max/mean/std, compression | must | done |
| C9 | Copy current display range; export current view as PNG | could | done |
| C10 | Works over Remote-SSH: decode on the remote host, ship only one slice | must | done |
| C11 | Respect VS Code light/dark theme | should | done |
| C12 | Keyboard: `+`/`-` zoom, arrows for slices, `a` auto, `e` enhance, `r` reset, `f` fit, `1` 100% | should | done |

## D. Engineering

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| D1 | No native deps; pure TS/JS so it installs on any remote | must | done |
| D2 | Unit tests for the decoder against `tifffile`-generated fixtures | must | done |
| D3 | Unit tests for auto-contrast against values computed from the ImageJ algorithm | must | done |
| D4 | Handle files larger than RAM without loading fully | should | done |
| D5 | Bundled with esbuild into a single JS file | must | done |

## Traceability

| Area | Test file |
|------|-----------|
| A1–A15 decoding | `test/decoder.test.mjs` (55 tests, fixtures written by `tifffile`) |
| A15, resource limits, damaged files | `test/robustness.test.mjs` (19) |
| B1–B8 contrast, statistics, LUTs | `test/contrast.test.mjs` (51, vs. an independent Python transcription of the ImageJ Java) |
| B2, B9 mapping and NaN | `test/render.test.mjs` (27, exact output-distribution fingerprint vs. numpy) |
| C10 wire format, caching | `test/wire.test.mjs` (11) |
| C1–C12 viewer behaviour | `test/webview.test.mjs` (29, real `viewer.js` mounted in jsdom) |
| C1 activation, CSP, packaging | `test/activation.test.mjs` (6) |
| Performance | `test/perf.test.mjs` (5) |

**197 tests total.**

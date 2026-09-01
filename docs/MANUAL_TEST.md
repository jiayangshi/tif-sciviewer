# Manual test checklist

The automated suite (`npm run verify`, 203 tests) covers decoding, contrast,
rendering and the webview in jsdom. What it cannot cover is VS Code actually
hosting the thing. This is the list for that.

## Launching

**During development** — press <kbd>F5</kbd> in this folder. That builds, opens
an Extension Development Host, and opens `sample.tif` in it. Reload the
host with <kbd>Cmd</kbd>+<kbd>R</kbd> after a rebuild. Use the
"Run Extension (fixtures)" configuration to get the whole `test/fixtures` folder
to click through.

**As an installed extension**:

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension tif-sciviewer.vsix
```

(Or add the CLI to your PATH with *Shell Command: Install 'code' command in
PATH* from the command palette.)

## 1. It opens at all

- [ ] `sample.tif` opens as an image, not as the hex/binary notice.
- [ ] Sidebar shows `512 × 512`, `float32`, `none`, and the file size.
- [ ] Statistics show data min `-1`, max `0.9805`, mean `-0.8227`.
- [ ] It is legible on open — not a black rectangle. That is auto-contrast
      working; this single check is the whole point of the extension.

If it opens as binary instead, VS Code has remembered a different editor:
right-click the file → *Open With…* → *TIFF Scientific Viewer* → *Configure
default*.

## 2. Contrast

- [ ] `Reset` makes it visibly darker (full range `[-1, 0.9805]`).
- [ ] `Auto` brings it back to `[-1, -0.1490]`.
- [ ] Pressing `Auto` repeatedly keeps tightening, then wraps back round.
- [ ] `Enhance` gives `[-1, -0.0252]`.
- [ ] Typing `-0.8` and `-0.2` into Min/Max and pressing Enter takes effect.
- [ ] Typing a min above the max reverts instead of breaking.
- [ ] Dragging the Minimum/Maximum sliders is smooth.
- [ ] Dragging the handles under the histogram moves the shaded region.
- [ ] The shaded region matches the numbers in the Min/Max fields.

## 3. Readout and zoom

- [ ] Moving the cursor over the image shows `x=, y=, value=` in the status bar.
- [ ] The value is a raw float like `-0.6542`, not a 0–255 number.
- [ ] Values outside the image clear the readout rather than showing garbage.
- [ ] Scroll wheel zooms toward the cursor, not the centre.
- [ ] Zoomed in past 100%, pixels are hard squares — never blurred.
- [ ] Drag pans; double-click fits.
- [ ] `+` `-` `f` `1` work; `a` `e` `r` drive contrast.
- [ ] Typing `r` inside the Min box types an `r` rather than resetting.

## 4. Stacks

Open `test/fixtures/stack_f32.tif` (7 pages):

- [ ] A Stack panel appears with a slider reading `z 1/7`.
- [ ] Dragging it changes the image; arrow keys step one slice.
- [ ] The display range stays put across slices (that is the default).
- [ ] Ticking *Recompute range per slice* makes it follow each slice instead.

Open `test/fixtures/imagej_hyperstack.tif` (2 channels × 3 slices × 2 frames):

- [ ] Separate Channel, Frame and slice sliders appear.
- [ ] Switching channel changes the range — the two channels have very
      different scales, and each should look correct rather than blank.
- [ ] Going back to channel 1 restores the range it had.

## 5. Formats

Each of these should open and look sane:

| File | What it checks |
|------|----------------|
| `test/fixtures/f32_lzw_pred3.tif` | LZW + floating-point predictor |
| `test/fixtures/f32_bigtiff.tif` | BigTIFF |
| `test/fixtures/f32_bigendian.tif` | Big-endian |
| `test/fixtures/f32_tiled_lzw.tif` | Tiles |
| `test/fixtures/u16_lzw_pred2.tif` | 16-bit + horizontal predictor |
| `test/fixtures/i16_none.tif` | Signed 16-bit |
| `test/fixtures/rgb_u8.tif` | RGB (LUT picker greys out) |
| `test/fixtures/rgb_u8_planar.tif` | Planar RGB |
| `test/fixtures/f32_nan_inf.tif` | NaN/Inf drawn red, counted in Statistics |
| `test/fixtures/f32_odd.tif` | 37×53, catches stride bugs |

## 6. LUTs and export

- [ ] Switching to Fire recolours without changing Min/Max.
- [ ] Inverted Grays looks like a photographic negative.
- [ ] `Save PNG…` opens a save dialog and writes a file that opens elsewhere.
- [ ] The saved PNG has the range and LUT that were on screen, at full
      resolution rather than the zoomed size.
- [ ] `Copy` puts `min=…, max=…` on the clipboard.

## 7. Failure modes

- [ ] `head -c 20000 sample.tif > /tmp/truncated.tif` — opening it
      shows a readable error overlay, not a blank panel or a crash.
- [ ] A non-TIFF renamed to `.tif` says it is not a TIFF.
- [ ] Setting `tifSciviewer.maxDecodedMegabytes` to `1` and reopening gives an
      error naming the setting to raise.

## 8. Remote (the case this exists for)

On a Remote-SSH window:

- [ ] The extension shows as installed in *SSH: host*, not just locally.
- [ ] A `.tif` on the remote box opens with no local copy of the file.
- [ ] A large stack opens quickly — headers are read, not the whole file.
- [ ] Scrubbing slices stays responsive over the link.

## 9. Theme

- [ ] Switch between a light and a dark theme; the sidebar, histogram and
      status bar all stay readable.

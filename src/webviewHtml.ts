/**
 * The viewer markup, kept in one place so the headless webview test can mount
 * exactly the DOM the extension ships rather than a hand-copied approximation.
 */

export function bodyHtml(): string {
  return /* html */ `<div id="app">
  <div id="stage">
    <canvas id="canvas" tabindex="0"></canvas>
    <div id="overlay-error" hidden></div>
  </div>
  <div id="sidebar">
    <section class="panel">
      <h2 id="file-name">&nbsp;</h2>
      <dl id="info"></dl>
    </section>

    <section class="panel">
      <h2>Brightness / Contrast</h2>
      <div class="hist-wrap">
        <canvas id="histogram" height="90"></canvas>
        <div id="hist-handles">
          <div class="handle" id="handle-min" title="Display minimum"></div>
          <div class="handle" id="handle-max" title="Display maximum"></div>
        </div>
      </div>
      <div id="hist-labels"><span id="hist-lo"></span><span id="hist-hi"></span></div>

      <label class="slider-row"><span>Minimum</span><input type="range" id="slider-min" min="0" max="1000" value="0"></label>
      <label class="slider-row"><span>Maximum</span><input type="range" id="slider-max" min="0" max="1000" value="1000"></label>
      <label class="slider-row"><span>Brightness</span><input type="range" id="slider-brightness" min="0" max="1000" value="500"></label>
      <label class="slider-row"><span>Contrast</span><input type="range" id="slider-contrast" min="0" max="1000" value="500"></label>

      <div class="numeric-row">
        <label>Min <input type="text" id="input-min" spellcheck="false"></label>
        <label>Max <input type="text" id="input-max" spellcheck="false"></label>
      </div>

      <div class="button-row">
        <button id="btn-auto" title="ImageJ Auto (press again to tighten) — A">Auto</button>
        <button id="btn-enhance" title="Enhance Contrast, saturating a fixed percentage — E">Enhance</button>
        <button id="btn-reset" title="Full data range — R">Reset</button>
        <button id="btn-copy" title="Copy the current display range">Copy</button>
      </div>
      <label class="check-row"><input type="checkbox" id="chk-per-slice"> Recompute range per slice</label>
    </section>

    <section class="panel">
      <h2>Display</h2>
      <label class="slider-row"><span>LUT</span><select id="select-lut"></select></label>
      <div class="button-row">
        <button id="btn-zoom-out" title="Zoom out — -">&minus;</button>
        <button id="btn-zoom-in" title="Zoom in — +">+</button>
        <button id="btn-fit" title="Fit to window — F">Fit</button>
        <button id="btn-100" title="Actual size — 1">1:1</button>
      </div>
      <div class="button-row">
        <button id="btn-save" title="Save what you see now as a PNG, at full resolution">Save PNG&hellip;</button>
      </div>
    </section>

    <section class="panel" id="stack-panel" hidden>
      <h2>Stack</h2>
      <label class="slider-row" id="row-c" hidden><span>Channel</span><input type="range" id="slider-c" min="0" max="0" value="0"></label>
      <label class="slider-row" id="row-t" hidden><span>Frame</span><input type="range" id="slider-t" min="0" max="0" value="0"></label>
      <input type="range" id="slider-slice" min="0" max="0" value="0">
      <div id="slice-label"></div>
    </section>

    <section class="panel">
      <h2>Statistics</h2>
      <dl id="stats"></dl>
    </section>
  </div>
</div>
<div id="statusbar"><span id="pos">&nbsp;</span><span id="zoom-label"></span></div>`;
}

export function pageHtml(opts: { cspSource: string; nonce: string; cssUri: string; jsUri: string }): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${opts.cspSource} blob: data:; style-src ${opts.cspSource} 'unsafe-inline'; script-src 'nonce-${opts.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${opts.cssUri}" rel="stylesheet">
<title>TIFF Scientific Viewer</title>
</head>
<body>
${bodyHtml()}
<script nonce="${opts.nonce}" src="${opts.jsUri}"></script>
</body>
</html>`;
}

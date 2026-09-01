// Shared synthetic CT phantom. Used for the README figure and `npm run sample`,
// so neither ships any real research data.
/**
 * An elliptical phantom that reproduces what makes real CT slices unreadable:
 * an enormous air plateau at -1, soft tissue crammed into a narrow band just
 * above it, and a handful of dense pixels reaching almost +1. Mapping the full
 * range onto 256 grey levels spends nearly all of them on the empty gap, so the
 * tissue collapses into a few near-black levels.
 */
export function phantom(W, H) {
  const a = new Float32Array(W * H).fill(-1); // air plateau
  const ell = (x, y, cx, cy, rx, ry, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const dx = x - cx, dy = y - cy;
    const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
    return u * u + v * v;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = (x - W / 2) / (W / 2), py = (y - H / 2) / (H / 2);
      const body = ell(px, py, 0, 0, 0.72, 0.88, 0);
      if (body > 1) continue;

      // Soft tissue spans roughly [-0.92, -0.38]: broad enough to hold real
      // structure, but only a quarter of the full data range.
      let v = -0.72 + 0.06 * Math.exp(-body * 2.2);
      const blobs = [
        [0.22, -0.30, 0.20, 0.14, 0.5, 0.19],
        [-0.26, -0.12, 0.15, 0.22, -0.3, 0.13],
        [0.02, 0.36, 0.26, 0.13, 0.1, -0.11],
        [-0.30, 0.42, 0.10, 0.10, 0.0, 0.24],
      ];
      for (const [cx, cy, rx, ry, ang, amp] of blobs) {
        const d = ell(px, py, cx, cy, rx, ry, ang);
        if (d < 1) v += amp * Math.exp(-d * 1.6);
      }
      // Non-harmonic frequencies, so the texture does not read as a grid.
      v += 0.0045 * Math.sin(px * 23.7 + py * 8.1)
         + 0.0035 * Math.sin(px * 9.3 - py * 31.4)
         + 0.0030 * Math.sin(px * 47.1 + py * 39.9);

      // A thin cortical shell, still inside the tissue band.
      const shell = Math.exp(-(((Math.sqrt(body) - 0.97) / 0.030) ** 2));
      v += 0.42 * shell;

      // Three tiny dense specks - a few dozen pixels in total - are the only
      // thing reaching the top of the range. They are far too sparse for
      // ImageJ's Auto to treat as signal, which is exactly the point: the full
      // range is set by pixels you cannot even see.
      for (const [cx, cy, amp] of [[0.34, 0.30, 1.70], [-0.12, -0.52, 1.45], [0.46, -0.08, 1.28]]) {
        const d = ell(px, py, cx, cy, 0.022, 0.022, 0);
        if (d < 1) v += amp * Math.exp(-d * 2.4);
      }

      a[y * W + x] = Math.max(-1, Math.min(1, v));
    }
  }
  return a;
}


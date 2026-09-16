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


/**
 * One slice through a synthetic volume: the phantom above, extended into 3D.
 *
 * `z` runs from 0 at the top of the volume to 1 at the bottom. Organs are
 * ellipsoids, so they appear, grow, shrink and vanish from slice to slice; the
 * body tapers towards both ends; the spine alternates between vertebra and
 * disc; and the dense specks sit at different depths. What changes from slice
 * to slice is the content - how much of each material there is - so each slice
 * has its own histogram, as in a real reconstruction.
 *
 * Material values stay put, as they do in CT: air is always -1 and tissue
 * always sits in the same band, so one display window suits every slice.
 */
export function phantomSlice(W, H, z) {
  const a = new Float32Array(W * H).fill(-1); // air plateau
  const ell = (x, y, cx, cy, rx, ry, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const dx = x - cx, dy = y - cy;
    const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
    return u * u + v * v;
  };
  // How much of an ellipsoid centred at depth cz, half-height rz, this slice
  // cuts through: 1 through its middle, 0 once the slice misses it.
  const cut = (cz, rz) => {
    const t = (z - cz) / rz;
    return t * t < 1 ? Math.sqrt(1 - t * t) : 0;
  };

  const taper = 0.84 + 0.16 * Math.sin(Math.PI * z);
  //   cx     cy     cz    rx    ry    rz   angle   amp
  const organs = [
    [0.22, -0.28, 0.66, 0.26, 0.19, 0.36, 0.5, 0.19],   // large dense organ, lower two thirds
    [-0.30, -0.06, 0.22, 0.19, 0.30, 0.30, 0.1, -0.15], // lungs: less dense than tissue,
    [0.30, -0.06, 0.22, 0.19, 0.30, 0.30, -0.1, -0.15], //   upper third only
    [-0.04, 0.08, 0.36, 0.20, 0.17, 0.20, 0.3, 0.11],   // heart
    [0.02, 0.36, 0.55, 0.26, 0.13, 0.45, 0.1, -0.11],   // a less dense band mid-volume
    [-0.30, 0.30, 0.84, 0.10, 0.13, 0.16, 0.2, 0.13],   // kidneys, near the bottom
    [0.30, 0.30, 0.84, 0.10, 0.13, 0.16, -0.2, 0.13],
  ].map(([cx, cy, cz, rx, ry, rz, ang, amp]) => ({ cx, cy, rx, ry, ang, amp, k: cut(cz, rz) }))
    .filter(o => o.k > 0);
  // Specks are the only thing near the top of the range; which slices have
  // one decides where each slice's maximum lands.
  const specks = [[0.34, 0.30, 0.15, 1.70], [-0.12, -0.52, 0.50, 1.45], [0.46, -0.08, 0.85, 1.28]]
    .map(([cx, cy, cz, amp]) => ({ cx, cy, amp, k: cut(cz, 0.12) }))
    .filter(o => o.k > 0);
  // Four vertebrae down the volume, discs between them.
  const vertebra = 0.30 + 0.25 * Math.cos(2 * Math.PI * 4 * z);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = (x - W / 2) / (W / 2), py = (y - H / 2) / (H / 2);
      const body = ell(px, py, 0, 0, 0.72 * taper, 0.88 * taper, 0);
      if (body > 1) continue;

      let v = -0.72 + 0.06 * Math.exp(-body * 2.2);
      for (const o of organs) {
        const d = ell(px, py, o.cx, o.cy, o.rx * o.k, o.ry * o.k, o.ang);
        if (d < 1) v += o.amp * Math.exp(-d * 1.6);
      }
      const spine = ell(px, py, 0, 0.62 * taper, 0.09, 0.08, 0);
      if (spine < 1) v += vertebra * Math.exp(-spine * 1.2);

      // The same non-harmonic texture as the 2D phantom, drifting with depth.
      v += 0.0045 * Math.sin(px * 23.7 + py * 8.1 + z * 5.3)
         + 0.0035 * Math.sin(px * 9.3 - py * 31.4 - z * 7.9)
         + 0.0030 * Math.sin(px * 47.1 + py * 39.9 + z * 3.1);

      const shell = Math.exp(-(((Math.sqrt(body) - 0.97) / 0.030) ** 2));
      v += 0.42 * shell;

      for (const o of specks) {
        const d = ell(px, py, o.cx, o.cy, 0.022 * o.k, 0.022 * o.k, 0);
        if (d < 1) v += o.amp * Math.exp(-d * 2.4);
      }

      a[y * W + x] = Math.max(-1, Math.min(1, v));
    }
  }
  return a;
}

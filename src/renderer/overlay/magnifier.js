'use strict';

/**
 * The pixel loupe that trails the crosshair: a nearest-neighbour zoom of the
 * frozen screenshot plus the coordinate / colour readout.
 */
window.TookMagnifier = (() => {
  // Scoped inside the IIFE: the overlay loads several classic scripts into one
  // global scope, and a top-level const T in more than one of them is a
  // redeclaration SyntaxError that stops the later script from loading at all.
  const T = (key, vars) => window.i18n.t(key, vars);
  const ZOOM = 8; // screen pixels per source pixel
  const SIZE = 128; // loupe edge, CSS px
  const GAP = 18; // distance from the cursor
  const EDGE = 10; // keep this far from the display edge

  function create(root) {
    const el = document.createElement('div');
    el.className = 'magnifier';
    el.innerHTML = `
      <canvas class="mag-canvas" width="${SIZE}" height="${SIZE}"
              style="width:${SIZE}px;height:${SIZE}px"></canvas>
      <div class="mag-info">
        <div class="mag-row" data-role="coord"></div>
        <div class="mag-row">
          <span class="mag-swatch" data-role="swatch"></span><span data-role="color">RGB:0,0,0</span>
        </div>
        <div class="mag-row mag-hint">${T('mag.copyHint')}</div>
        <div class="mag-row mag-hint">${T('mag.toggleHint')}</div>
      </div>`;
    root.appendChild(el);

    const canvas = el.querySelector('.mag-canvas');
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    return {
      el,
      canvas,
      ctx,
      refs: {
        coord: el.querySelector('[data-role="coord"]'),
        color: el.querySelector('[data-role="color"]'),
        swatch: el.querySelector('[data-role="swatch"]'),
      },
    };
  }

  /**
   * @param mag      handle from create()
   * @param opts.base        source canvas holding the screenshot (native px)
   * @param opts.x,y         cursor position in display-local CSS px
   * @param opts.screenX,Y   cursor position in global screen coords
   * @param opts.rgb         [r,g,b] under the cursor
   * @param opts.hex         true to show HEX instead of RGB
   * @param opts.ratio       native px per CSS px
   * @param opts.viewW/viewH display size in CSS px
   */
  function update(mag, opts) {
    const { ctx } = mag;
    const src = SIZE / ZOOM; // source pixels covered by the loupe
    const half = src / 2;

    const nx = Math.floor(opts.x * opts.ratio);
    const ny = Math.floor(opts.y * opts.ratio);

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = '#1b1b1d';
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(opts.base, nx - half, ny - half, src, src, 0, 0, SIZE, SIZE);

    // Crosshair, one source-pixel thick, centred on the sampled pixel.
    const center = Math.floor(half) * ZOOM;
    ctx.fillStyle = opts.crossColor || 'rgba(150,170,245,0.62)';
    ctx.fillRect(0, center, SIZE, ZOOM);
    ctx.fillRect(center, 0, ZOOM, SIZE);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(center + 0.5, center + 0.5, ZOOM - 1, ZOOM - 1);

    const [r, g, b] = opts.rgb;
    mag.refs.coord.textContent = T('mag.coord', { x: opts.screenX, y: opts.screenY });
    mag.refs.color.textContent = opts.hex ? `HEX:${toHex(r, g, b)}` : `RGB:${r},${g},${b}`;
    mag.refs.swatch.style.background = `rgb(${r},${g},${b})`;

    position(mag, opts.x, opts.y, opts.viewW, opts.viewH);
  }

  function position(mag, x, y, viewW, viewH) {
    const w = mag.el.offsetWidth || SIZE;
    const h = mag.el.offsetHeight || SIZE + 78;

    // Prefer bottom-right of the cursor, flip when we would run off-screen.
    let left = x + GAP;
    let top = y + GAP;

    if (left + w > viewW - EDGE) left = x - GAP - w;
    if (top + h > viewH - EDGE) top = y - GAP - h;

    left = Math.max(EDGE, Math.min(left, viewW - w - EDGE));
    top = Math.max(EDGE, Math.min(top, viewH - h - EDGE));

    mag.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function show(mag, visible) {
    mag.el.classList.toggle('hidden', !visible);
  }

  function toHex(r, g, b) {
    const p = (n) => n.toString(16).padStart(2, '0').toUpperCase();
    return `#${p(r)}${p(g)}${p(b)}`;
  }

  return { create, update, show, toHex };
})();

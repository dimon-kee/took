'use strict';

/**
 * The scrolling screenshot: its card, its panel and its capture loop.
 *
 * Before it starts, a card with Start sits in the selection, like the
 * recording card. Once started, a panel beside the selection shows a live
 * preview, the size so far and Stop; after Stop, the usual ✓ / save / ✕.
 *
 * Frames come from a live desktop stream of this display, cropped to the
 * selection, and TookStitch works out where each one goes. Main keeps this
 * window out of that stream and lets the wheel through to the app underneath
 * (src/main/longcapture.js).
 */
window.TookLongShot = (() => {
  // Scoped inside the IIFE, like every overlay script — see recordpanel.js.
  const T = (key, vars) => window.i18n.t(key, vars);
  const Icons = window.TookIcons;
  const Stitch = window.TookStitch;

  const MAX_LENGTH = 20000; // px — comfortably inside what a canvas can hold
  const MAX_AREA = 80e6; // px², so a full-width capture cannot eat gigabytes
  const CANVAS_MAX = 32000; // px — Chromium refuses canvases taller than 32767
  const PREVIEW_W = 150; // CSS px — the panel's width, less its scrollbar
  const GAP = 10;
  // How far a pointer image reaches from its hotspot, in CSS px. The arrow and
  // the hand hang down and to the right; the I-beam and the spinner are
  // centred on it.
  const REACH = { left: 20, right: 36, up: 20, down: 40 };

  function create(root, hooks) {
    const card = document.createElement('div');
    card.className = 'long-card hidden';
    card.innerHTML = `<button class="rec-start long-go" type="button">${T('long.start')}</button>`;

    const panel = document.createElement('div');
    panel.className = 'long-panel hidden';
    panel.innerHTML = `
      <div class="long-view"><div class="long-clip"><canvas class="long-preview"></canvas></div></div>
      <div class="long-size"></div>
      <div class="long-status"></div>
      <div class="long-actions" data-for="running">
        <button class="long-stop" type="button"><i></i><span>${T('long.stop')}</span></button>
        <button class="tool danger" data-act="cancel" type="button" title="${T('tool.cancel')}">${Icons.close}</button>
      </div>
      <div class="long-actions hidden" data-for="done">
        <button class="tool" data-act="save" type="button" title="${T('tool.save')}">${Icons.save}</button>
        <button class="tool danger" data-act="cancel" type="button" title="${T('tool.cancel')}">${Icons.close}</button>
        <button class="tool ok" data-act="confirm" type="button" title="${T('tool.confirm')}">${Icons.confirm}</button>
      </div>`;

    root.appendChild(card);
    root.appendChild(panel);

    const ls = {
      hooks,
      card,
      panel,
      els: {
        view: panel.querySelector('.long-view'),
        clip: panel.querySelector('.long-clip'),
        preview: panel.querySelector('.long-preview'),
        size: panel.querySelector('.long-size'),
        status: panel.querySelector('.long-status'),
      },
      state: 'idle', // idle | starting | running | done | failed | closed
      sel: null,
      stream: null,
      video: null,
      crop: null, // the selection in stream pixels
      ratio: 1, // stream pixels per CSS px
      frame: null,
      frameCtx: null,
      result: null,
      resultCtx: null,
      base: 0, // canvas row of result row 0 — result rows go negative growing up
      stitcher: null,
      maxLength: 0,
      lo: 0, // the image is result rows [lo, hi)
      hi: 0,
      pos: 0, // result row of the frame's top edge, where the scroll has got to
      length: 0,
      steps: {}, // how each frame was taken, by kind — for the checks
      pointerNow: null,
      pointerSpan: null,
      previewCtx: null,
      previewScale: 1,
      pending: null,
      raf: 0,
    };

    wire(ls);
    return ls;
  }

  function wire(ls) {
    // Presses on the card or the panel must never reach the overlay's own
    // selection handling underneath.
    [ls.card, ls.panel].forEach((el) => el.addEventListener('mousedown', (e) => e.stopPropagation()));

    ls.card.querySelector('.long-go').addEventListener('click', (e) => {
      e.stopPropagation();
      ls.hooks.onStart();
    });

    ls.panel.querySelector('.long-stop').addEventListener('click', (e) => {
      e.stopPropagation();
      stop(ls);
    });

    ls.panel.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        act(ls, btn.dataset.act);
      });
    });
  }

  // -------------------------------------------------------------------------
  // card
  // -------------------------------------------------------------------------

  function showCard(ls, visible, sel, viewW, viewH) {
    ls.card.classList.toggle('hidden', !visible);
    if (visible) placeCard(ls, sel, viewW, viewH);
  }

  /** Centre the card in the selection, clamped to the display. */
  function placeCard(ls, sel, viewW, viewH) {
    const w = ls.card.offsetWidth;
    const h = ls.card.offsetHeight;
    const left = clamp(sel.x + (sel.w - w) / 2, 6, viewW - w - 6);
    const top = clamp(sel.y + (sel.h - h) / 2, 6, viewH - h - 6);
    ls.card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  // -------------------------------------------------------------------------
  // capture
  // -------------------------------------------------------------------------

  /** @param ctx { shot, sel, viewW, viewH, workArea } */
  async function start(ls, ctx) {
    if (ls.state !== 'idle') return;
    ls.state = 'starting';
    ls.sel = ctx.sel;

    ls.card.classList.add('hidden');
    ls.panel.classList.remove('hidden');
    showActions(ls, 'running');
    setStatus(ls, T('long.starting'));
    placePanel(ls, ctx);

    try {
      await ls.hooks.begin({ selection: rectOf(ctx.sel), panel: panelRect(ls) });
      await openStream(ls, ctx);
    } catch (err) {
      if (ls.state !== 'starting') return; // cancelled while starting
      console.error('[took] 长截图没能开始:', err);
      ls.state = 'failed';
      closeStream(ls);
      ls.hooks.end();
      showActions(ls, 'failed');
      setStatus(ls, T('long.failed', { message: (err && err.message) || err }), true);
      return;
    }

    if (ls.state !== 'starting') {
      closeStream(ls);
      return;
    }
    ls.state = 'running';
    setStatus(ls, T('long.scroll'));
    ls.video.requestVideoFrameCallback(() => onFrame(ls));
  }

  async function openStream(ls, { shot, sel, viewW }) {
    if (!shot.sourceId) throw new Error(T('err.noSource'));

    const { width, height } = shot.pixelSize;
    ls.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: shot.sourceId,
          minWidth: width,
          maxWidth: width,
          minHeight: height,
          maxHeight: height,
          maxFrameRate: 30,
        },
      },
    });

    const video = document.createElement('video');
    video.srcObject = ls.stream;
    video.muted = true;
    await video.play();
    ls.video = video;

    // Crop in the stream's own pixels — trust the frame over the display.
    const vw = video.videoWidth || width;
    const vh = video.videoHeight || height;
    ls.ratio = vw / viewW;
    const sx = clamp(Math.round(sel.x * ls.ratio), 0, vw - 1);
    const sy = clamp(Math.round(sel.y * ls.ratio), 0, vh - 1);
    const sw = clamp(Math.round(sel.w * ls.ratio), 1, vw - sx);
    const sh = clamp(Math.round(sel.h * ls.ratio), 1, vh - sy);
    ls.crop = { sx, sy, sw, sh };

    ls.frame = canvas(sw, sh);
    ls.frameCtx = ls.frame.getContext('2d', { willReadFrequently: true });
    ls.maxLength = Math.max(sh, Math.min(MAX_LENGTH, Math.floor(MAX_AREA / sw)));
    // A frame's worth of spare rows or more either side, since nobody knows
    // yet which way the scroll will go.
    ls.result = canvas(sw, Math.min(CANVAS_MAX, sh * 4));
    ls.resultCtx = ls.result.getContext('2d', { willReadFrequently: true });
    ls.base = Math.floor((ls.result.height - sh) / 2);
    ls.stitcher = Stitch.create(sw, sh, ls.maxLength);
    setupPreview(ls);
  }

  /**
   * Called for each frame the stream presents — which only happens when
   * something on screen changed, so an idle screen costs nothing.
   */
  function onFrame(ls) {
    if (ls.state !== 'running') return;

    const { sx, sy, sw, sh } = ls.crop;
    ls.frameCtx.drawImage(ls.video, sx, sy, sw, sh, 0, 0, sw, sh);
    const { data } = ls.frameCtx.getImageData(0, 0, sw, sh);
    apply(ls, ls.stitcher.push(data, takePointerRows(ls)));

    if (ls.state === 'running') ls.video.requestVideoFrameCallback(() => onFrame(ls));
  }

  function apply(ls, step) {
    ls.steps[step.kind] = (ls.steps[step.kind] || 0) + 1;
    if (step.ops.length) {
      fit(ls, step.lo, step.hi);
      const w = ls.crop.sw;
      for (const op of step.ops) {
        ls.resultCtx.drawImage(ls.frame, 0, op.from, w, op.rows, 0, op.to + ls.base, w, op.rows);
        touchPreview(ls, op.to, op.to + op.rows);
      }
    }
    // Only touch the page when something moved. Any repaint here, even of a
    // window left out of the capture, has Windows hand the stream a fresh
    // frame — which comes straight back through here, thirty times a second.
    const moved = step.lo !== ls.lo || step.hi !== ls.hi || step.pos !== ls.pos;
    ls.lo = step.lo;
    ls.hi = step.hi;
    ls.pos = step.pos;
    ls.length = step.length;
    if (moved) {
      updateSize(ls);
      schedulePreview(ls); // follows the scroll even when nothing new was drawn
    }

    if (step.kind === 'full') {
      stop(ls);
      setStatus(ls, T('long.full'), true);
    } else if (step.kind === 'lost') {
      setStatus(ls, T('long.lost'), true);
    } else if (step.kind === 'appended' || step.kind === 'moved' || step.kind === 'first') {
      setStatus(ls, T('long.scroll'));
    }
  }

  /**
   * The result canvas keeps spare rows above and below the image, so growing
   * either way is usually just drawing into them. When one side runs out, the
   * image moves to a bigger canvas with the spare room on the side it is
   * growing towards.
   */
  function fit(ls, lo, hi) {
    if (lo + ls.base >= 0 && hi + ls.base <= ls.result.height) return;

    const w = ls.crop.sw;
    const need = hi - lo;
    const room = Math.max(0, Math.min(CANVAS_MAX - need, Math.max(ls.crop.sh * 2, need)));
    const next = canvas(w, need + room);
    const ctx = next.getContext('2d', { willReadFrequently: true });
    const base = lo + ls.base < 0 ? room - lo : -lo;

    if (ls.hi > ls.lo) {
      ctx.drawImage(ls.result, 0, ls.lo + ls.base, w, ls.hi - ls.lo, 0, ls.lo + base, w, ls.hi - ls.lo);
    }
    ls.result = next;
    ls.resultCtx = ctx;
    ls.base = base;
  }

  function stop(ls) {
    if (ls.state !== 'running') return;
    ls.state = 'done';
    closeStream(ls);
    ls.hooks.end();
    showActions(ls, 'done');
    setStatus(ls, '');
    drawPreview(ls);
    ls.els.view.scrollTop = 0;
  }

  function closeStream(ls) {
    if (ls.stream) ls.stream.getTracks().forEach((track) => track.stop());
    ls.stream = null;
    if (ls.video) ls.video.srcObject = null;
  }

  /** ✓ / save / ✕, from the panel or the keyboard. */
  function act(ls, what) {
    if (what === 'cancel') {
      ls.state = 'closed';
      closeStream(ls);
      ls.hooks.cancel();
      return;
    }
    if (ls.state !== 'done' || !ls.length) return;

    const dataURL = exportPNG(ls);
    if (what === 'confirm') ls.hooks.copy(dataURL);
    else if (what === 'save') ls.hooks.save(dataURL);
  }

  function exportPNG(ls) {
    const w = ls.crop.sw;
    const out = canvas(w, ls.length);
    out.getContext('2d').drawImage(ls.result, 0, ls.lo + ls.base, w, ls.length, 0, 0, w, ls.length);
    return out.toDataURL('image/png');
  }

  // -------------------------------------------------------------------------
  // pointer
  // -------------------------------------------------------------------------

  /** A pointer sample from main, in display-local CSS px. */
  function pointer(ls, p) {
    if (ls.state !== 'starting' && ls.state !== 'running') return;
    ls.pointerNow = p;
    const rows = rowsUnder(ls, p);
    if (!rows) return;
    ls.pointerSpan = ls.pointerSpan
      ? [Math.min(ls.pointerSpan[0], rows[0]), Math.max(ls.pointerSpan[1], rows[1])]
      : rows;
  }

  /**
   * Every row the pointer may have covered since the last frame: the frame
   * could have caught it anywhere it has been in between.
   */
  function takePointerRows(ls) {
    const span = ls.pointerSpan;
    ls.pointerSpan = ls.pointerNow ? rowsUnder(ls, ls.pointerNow) : null;
    return span;
  }

  function rowsUnder(ls, p) {
    const { sel, crop, ratio } = ls;
    if (!crop) return null;
    if (p.x + REACH.right < sel.x || p.x - REACH.left > sel.x + sel.w) return null;

    const a = Math.floor((p.y - REACH.up - sel.y) * ratio);
    const b = Math.ceil((p.y + REACH.down - sel.y) * ratio);
    if (b <= 0 || a >= crop.sh) return null;
    return [Math.max(0, a), Math.min(crop.sh, b)];
  }

  // -------------------------------------------------------------------------
  // panel
  // -------------------------------------------------------------------------

  /** Beside the selection where there is room, over its right edge where not. */
  function placePanel(ls, { sel, viewW, viewH, workArea }) {
    const wa = workArea || { x: 0, y: 0, width: viewW, height: viewH };
    const w = ls.panel.offsetWidth;
    const h = ls.panel.offsetHeight;

    let left;
    if (sel.x + sel.w + GAP + w <= wa.x + wa.width - 6) left = sel.x + sel.w + GAP;
    else if (sel.x - GAP - w >= wa.x + 6) left = sel.x - GAP - w;
    else left = sel.x + sel.w - w - GAP;
    const top = clamp(sel.y, wa.y + 6, wa.y + wa.height - h - 6);

    ls.panel.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function panelRect(ls) {
    const r = ls.panel.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  function showActions(ls, mode) {
    ls.panel.querySelector('[data-for="running"]').classList.toggle('hidden', mode !== 'running');
    const done = ls.panel.querySelector('[data-for="done"]');
    done.classList.toggle('hidden', mode === 'running');
    // A capture that never started has nothing to copy or save.
    done.querySelectorAll('[data-act="save"], [data-act="confirm"]').forEach((btn) => {
      btn.classList.toggle('hidden', mode === 'failed');
    });
  }

  function setStatus(ls, text, warn) {
    setText(ls.els.status, text);
    ls.els.status.classList.toggle('warn', Boolean(warn));
  }

  function updateSize(ls) {
    setText(ls.els.size, `${ls.crop.sw} × ${ls.length}`);
  }

  /** Assigning textContent rebuilds the node even when the text is the same. */
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  // -------------------------------------------------------------------------
  // preview
  // -------------------------------------------------------------------------

  /**
   * A canvas covering every row the result could ever reach, at preview scale
   * — maxLength either side of the first frame — seen through a clip sized to
   * the image so far. A new strip only ever draws itself, and growing upward
   * just moves the canvas; nothing already drawn is drawn again.
   */
  function setupPreview(ls) {
    const dpr = window.devicePixelRatio || 1;
    const c = ls.els.preview;
    ls.previewScale = Math.min((PREVIEW_W * dpr) / ls.crop.sw, 1, CANVAS_MAX / (ls.maxLength * 2));
    c.width = Math.round(ls.crop.sw * ls.previewScale);
    c.height = Math.ceil(ls.maxLength * 2 * ls.previewScale);
    c.style.width = `${c.width / dpr}px`;
    c.style.height = `${c.height / dpr}px`;
    ls.previewCtx = c.getContext('2d');
    ls.previewCtx.imageSmoothingQuality = 'high';
    ls.els.clip.style.height = '0px';
  }

  /** Result rows [from, to) changed. */
  function touchPreview(ls, from, to) {
    ls.pending = ls.pending ? [Math.min(ls.pending[0], from), Math.max(ls.pending[1], to)] : [from, to];
    schedulePreview(ls);
  }

  function schedulePreview(ls) {
    if (!ls.raf) ls.raf = requestAnimationFrame(() => drawPreview(ls));
  }

  function drawPreview(ls) {
    ls.raf = 0;
    if (!ls.previewCtx) return;

    const s = ls.previewScale;
    const c = ls.els.preview;
    const off = ls.maxLength; // preview row of result row r is (r + off) * s

    if (ls.pending) {
      const [from, to] = ls.pending;
      ls.pending = null;
      const y0 = Math.floor((from + off) * s);
      const y1 = Math.min(c.height, Math.ceil((to + off) * s));
      const src = Math.max(0, y0 / s - off + ls.base);
      const srcH = Math.min((y1 - y0) / s, ls.result.height - src);
      if (y1 > y0 && srcH > 0) {
        ls.previewCtx.clearRect(0, y0, c.width, y1 - y0);
        ls.previewCtx.drawImage(ls.result, 0, src, ls.crop.sw, srcH, 0, y0, c.width, srcH * s);
      }
    }

    const dpr = window.devicePixelRatio || 1;
    ls.els.clip.style.height = `${(ls.length * s) / dpr}px`;
    c.style.transform = `translateY(${(-(ls.lo + off) * s) / dpr}px)`;

    // Keep where the scroll has got to in view while capturing, whichever way
    // it is going.
    if (ls.state === 'running') {
      const view = ls.els.view;
      view.scrollTop = ((ls.pos - ls.lo + ls.crop.sh / 2) * s) / dpr - view.clientHeight / 2;
    }
  }

  // -------------------------------------------------------------------------

  function state(ls) {
    return ls.state;
  }

  function stats(ls) {
    return { state: ls.state, lo: ls.lo, hi: ls.hi, length: ls.length, crop: ls.crop, steps: { ...ls.steps } };
  }

  function rectOf(sel) {
    return { x: sel.x, y: sel.y, width: sel.w, height: sel.h };
  }

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  return { create, showCard, placeCard, start, pointer, stop, act, state, stats };
})();

'use strict';

(() => {
  // Scoped inside the IIFE: the overlay loads several classic scripts into one
  // global scope, and a top-level const T in more than one of them is a
  // redeclaration SyntaxError that stops the later script from loading at all.
  const T = (key, vars) => window.i18n.t(key, vars);
  const Icons = window.TookIcons;
  const Shapes = window.TookShapes;
  const Mag = window.TookMagnifier;
  const RecordPanel = window.TookRecordPanel;
  const LongShot = window.TookLongShot;

  const DIM = 'rgba(0,0,0,0.45)';
  const SEL_STROKE = '#6c8cff';
  // The loupe crosshair turns pink in 录屏 so the mode is obvious at a glance.
  const CROSS_CAPTURE = 'rgba(150,170,245,0.62)';
  const CROSS_RECORD = 'rgba(255,122,158,0.70)';
  const HANDLE_R = 4.2;
  const HANDLE_HIT = 9;
  const WIDTHS = [2, 4, 7];
  const TEXT_SIZES = [15, 20, 27];
  const CLICK_SLOP = 4;

  const COLORS = [
    { value: '#F5222D' },
    { value: '#FA8C16' },
    { value: '#52C41A' },
    { value: '#1890FF' },
    { value: '#141414' },
    { value: '#8C8C8C' },
    { value: '#FFFFFF', light: true },
  ];

  const DRAW_TOOLS = ['rect', 'ellipse', 'line', 'arrow', 'pen', 'text', 'marker', 'mosaic', 'blur'];
  const SHAPE_TOOLS = new Set(DRAW_TOOLS);
  const FREEHAND = new Set(['pen', 'marker']);

  const TOOLBAR = [
    { id: 'rect', title: 'tool.rect' },
    { id: 'ellipse', title: 'tool.ellipse' },
    { id: 'line', title: 'tool.line' },
    { id: 'arrow', title: 'tool.arrow' },
    { id: 'pen', title: 'tool.pen' },
    { id: 'text', title: 'tool.text' },
    { id: 'marker', title: 'tool.marker' },
    { sep: true },
    { id: 'mosaic', title: 'tool.mosaic' },
    { id: 'blur', title: 'tool.blur' },
    { id: 'eraser', title: 'tool.eraser' },
    { id: 'pin', title: 'tool.pin', action: true },
    { id: 'qr', icon: 'qr', title: 'tool.qr', action: true },
    { sep: true },
    { id: 'undo', title: 'tool.undo', action: true },
    { id: 'save', title: 'tool.save', action: true },
    { id: 'close', title: 'tool.cancel', action: true, cls: 'danger' },
    { id: 'confirm', title: 'tool.confirm', action: true, cls: 'ok' },
  ];

  const S = {
    mode: 'capture',
    shot: null,
    ratio: 1,
    viewW: 0,
    viewH: 0,
    workArea: null, // display-local; toolbars stay inside it
    phase: 'idle', // idle | ready
    sel: null, // { x, y, w, h } in display-local CSS px
    // True while `sel` is the whole-screen default rather than something the
    // user drew. A click accepts it; a drag replaces it.
    preselect: false,
    shapes: [],
    tool: null,
    color: COLORS[0].value,
    widthIdx: 1,
    hexMode: false,
    active: true,
    ready: false,
    drag: null,
    cursor: { x: 0, y: 0 },
    baseData: null,
    hoverShape: -1,
    textEdit: null,
    barPos: null, // null = keep the mode bar centred at the top
    toolbarPos: null, // null = follow the selection

    /** 录屏 settings, mirrored straight into the recorder. */
    rec: {
      format: 'mp4', // 'mp4' | 'gif'
      speaker: true, // system audio via desktop loopback
      mic: false,
      camera: false,
      cursor: false, // master switch for the mouse effects below
      micId: null,
      cameraId: null,
      mouseHighlight: true,
      clickEffect: true,
    },
  };

  const els = {
    base: document.getElementById('base'),
    mask: document.getElementById('mask'),
    shapes: document.getElementById('shapes'),
    live: document.getElementById('live'),
    ui: document.getElementById('ui'),
    modebar: document.getElementById('modebar'),
    modeGrip: document.getElementById('mode-grip'),
    badge: document.getElementById('size-badge'),
    toolbar: document.getElementById('toolbar'),
    subbar: document.getElementById('subbar'),
    text: document.getElementById('text-input'),
    toast: document.getElementById('toast'),
  };

  const ctx = {
    // Opaque: a screenshot has no transparency, and Chromium takes the fourth
    // byte of a BGRX frame as alpha anyway. GDI leaves that byte undefined —
    // where it comes back 0, a transparent canvas would show the live desktop
    // through the "frozen" one, and every colour read off it would be 0,0,0.
    base: els.base.getContext('2d', { alpha: false }),
    mask: els.mask.getContext('2d'),
    shapes: els.shapes.getContext('2d'),
    live: els.live.getContext('2d'),
  };

  /** Off-screen context used only to measure text for the inline editor. */
  const measure = document.createElement('canvas').getContext('2d');

  let magnifier = null;
  let recPanel = null;
  let longShot = null;
  let toastTimer = null;
  let dirty = { mask: true, shapes: true, live: true };
  let rafId = 0;

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  // A failure inside the async init below would otherwise leave the overlay
  // silently inert — S.ready never flips and even Esc stops working.
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    console.error('[took] overlay 未处理的异常:', (reason && reason.stack) || reason);
  });

  window.took.onInit(async (payload) => {
    S.mode = payload.mode;
    S.shot = payload.shot;
    S.viewW = payload.shot.bounds.width;
    S.viewH = payload.shot.bounds.height;
    S.workArea = payload.shot.workArea || { x: 0, y: 0, width: S.viewW, height: S.viewH };

    await loadBase(payload.shot);

    // Derive the ratio from the frame we actually captured — the stream can
    // hand back a different size than the display reports.
    S.ratio = els.base.width / S.viewW || payload.shot.scaleFactor || 1;
    sizeCanvases();

    magnifier = Mag.create(els.ui);
    recPanel = RecordPanel.create(els.ui, {
      state: S.rec,
      onStart: () => doConfirm(),
      onChange: () => {
        RecordPanel.place(recPanel, S.sel, S.viewW, S.viewH);
        syncWebcam();
      },
    });
    longShot = LongShot.create(els.ui, {
      onStart: () => startLong(),
      begin: (rects) => window.took.longStart(rects),
      end: () => window.took.longStop(),
      copy: (dataURL) => copyImage(dataURL),
      save: (dataURL) => window.took.save(dataURL),
      cancel: () => window.took.cancel(),
    });
    wireBars();
    buildToolbar();
    buildSubbar();

    S.active = payload.isPrimary;
    if (payload.isPrimary) {
      S.cursor = {
        x: payload.cursor.x - payload.shot.bounds.x,
        y: payload.cursor.y - payload.shot.bounds.y,
      };
      // Open with the whole display already framed, so a single click is a
      // full-screen grab. Displays the cursor is not on stay dimmed.
      preselectFullScreen();
    } else {
      Mag.show(magnifier, false);
    }

    S.ready = true;
    syncModeBar();
    setCursorStyle();
    markDirty('mask', 'live');
    if (payload.isPrimary) drawMagnifier();

    // Two frames: one for the pending flush, one for it to reach the screen.
    // Only then may main reveal the window — otherwise you see a black flash
    // while the screenshot is still decoding.
    requestAnimationFrame(() => requestAnimationFrame(() => window.took.ready()));
  });

  // Where the pointer is during a scrolling screenshot, streamed from main.
  window.took.onPointer((p) => {
    if (longShot) LongShot.pointer(longShot, p);
  });

  // Another display took over the interaction — drop whatever we had going so
  // two screens can never both hold a live selection.
  window.took.onYield(() => {
    S.active = false;
    S.phase = 'idle';
    S.sel = null;
    S.preselect = false;
    S.shapes = [];
    S.tool = null;
    S.drag = null;
    S.hoverShape = -1;
    S.toolbarPos = null;
    cancelText();
    hideChrome();
    if (magnifier) Mag.show(magnifier, false);
    syncModeBar();
    markDirty('mask', 'shapes', 'live');
  });

  /**
   * Freeze this display into the base canvas.
   *
   * Main normally hands over the frame it grabbed when the hotkey fired. Without
   * one, a single frame comes out of a desktop MediaStream instead — slower to
   * start, but still no PNG to encode or decode — and failing that, a PNG.
   */
  async function loadBase(shot) {
    try {
      const drawn = Boolean(shot.frame) && drawFrame(shot.frame);
      // The canvas holds it now; S.shot need not keep 8 MB a display alive.
      shot.frame = null;
      if (!drawn) await grabFromStream(shot);
    } catch (err) {
      console.warn('[took] 抓帧失败，退回 PNG 路径:', err.message);
      const dataURL = await window.took.fallbackShot(shot.displayId);
      if (!dataURL) throw new Error(T('err.noImage'));
      await drawDataURL(dataURL);
    }

    S.baseData = ctx.base.getImageData(0, 0, els.base.width, els.base.height).data;
  }

  /**
   * Paint main's GDI grab: top-down rows of BGRX, the fourth byte undefined.
   * The canvas is opaque, which is what keeps that byte from mattering.
   * @returns false if this frame cannot be drawn, so the caller falls back
   */
  function drawFrame({ width, height, pixels }) {
    let frame;
    try {
      frame = new VideoFrame(pixels, { format: 'BGRX', codedWidth: width, codedHeight: height, timestamp: 0 });
    } catch (err) {
      console.warn('[took] 画面画不出来，改用抓流:', err.message);
      return false;
    }

    try {
      els.base.width = width;
      els.base.height = height;
      ctx.base.drawImage(frame, 0, 0);
    } finally {
      frame.close();
    }
    return true;
  }

  async function grabFromStream(shot) {
    const sourceId = shot.sourceId || (await window.took.sourceId(shot.displayId));
    if (!sourceId) throw new Error(T('err.noSource'));

    const { width, height } = shot.pixelSize;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: width,
          maxWidth: width,
          minHeight: height,
          maxHeight: height,
        },
      },
    });

    try {
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      // The first decoded frame, not just "playing" — otherwise we can paint
      // an empty canvas.
      await new Promise((resolve) => video.requestVideoFrameCallback(() => resolve()));

      // Trust the frame we actually got over the size we asked for.
      els.base.width = video.videoWidth || width;
      els.base.height = video.videoHeight || height;
      ctx.base.drawImage(video, 0, 0, els.base.width, els.base.height);

      video.srcObject = null;
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  }

  function drawDataURL(dataURL) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        els.base.width = img.naturalWidth;
        els.base.height = img.naturalHeight;
        ctx.base.drawImage(img, 0, 0);
        resolve();
      };
      img.onerror = () => reject(new Error(T('err.decodeFailed')));
      img.src = dataURL;
    });
  }

  function sizeCanvases() {
    const nw = els.base.width;
    const nh = els.base.height;

    els.base.style.width = `${S.viewW}px`;
    els.base.style.height = `${S.viewH}px`;

    ['mask', 'shapes', 'live'].forEach((key) => {
      const c = els[key];
      c.width = nw;
      c.height = nh;
      c.style.width = `${S.viewW}px`;
      c.style.height = `${S.viewH}px`;
      // Work in CSS pixels everywhere; the backing store stays native-res.
      ctx[key].setTransform(S.ratio, 0, 0, S.ratio, 0, 0);
    });
  }

  // -------------------------------------------------------------------------
  // pixel sampling
  // -------------------------------------------------------------------------

  function pixelAt(cssX, cssY) {
    const w = els.base.width;
    const h = els.base.height;
    const nx = clamp(Math.floor(cssX * S.ratio), 0, w - 1);
    const ny = clamp(Math.floor(cssY * S.ratio), 0, h - 1);
    const i = (ny * w + nx) * 4;
    const d = S.baseData;
    return d ? [d[i], d[i + 1], d[i + 2]] : [0, 0, 0];
  }

  /** Average colour of a CSS-px rect, sampled on a coarse grid. */
  function sampleAverage(cssX, cssY, cssW, cssH) {
    const steps = 4;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;

    for (let sy = 0; sy < steps; sy++) {
      for (let sx = 0; sx < steps; sx++) {
        const px = cssX + ((sx + 0.5) / steps) * cssW;
        const py = cssY + ((sy + 0.5) / steps) * cssH;
        const c = pixelAt(px, py);
        r += c[0];
        g += c[1];
        b += c[2];
        n++;
      }
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  const drawEnv = {
    get base() {
      return els.base;
    },
    get cssWidth() {
      return S.viewW;
    },
    get cssHeight() {
      return S.viewH;
    },
    sampleAverage,
  };

  // -------------------------------------------------------------------------
  // rendering
  // -------------------------------------------------------------------------

  function markDirty(...layers) {
    layers.forEach((l) => (dirty[l] = true));
    if (!rafId) rafId = requestAnimationFrame(flush);
  }

  function flush() {
    rafId = 0;
    if (dirty.mask) renderMask();
    if (dirty.shapes) renderShapes();
    if (dirty.live) renderLive();
    dirty = { mask: false, shapes: false, live: false };
  }

  function renderMask() {
    const c = ctx.mask;
    c.clearRect(0, 0, S.viewW, S.viewH);
    c.fillStyle = DIM;
    c.fillRect(0, 0, S.viewW, S.viewH);
    if (S.sel) c.clearRect(S.sel.x, S.sel.y, S.sel.w, S.sel.h);
  }

  function renderShapes() {
    const c = ctx.shapes;
    c.clearRect(0, 0, S.viewW, S.viewH);
    if (!S.sel || !S.shapes.length) return;

    c.save();
    clipToSelection(c);
    S.shapes.forEach((s) => Shapes.draw(c, s, drawEnv));
    c.restore();
  }

  function renderLive() {
    const c = ctx.live;
    c.clearRect(0, 0, S.viewW, S.viewH);
    if (!S.sel) return;

    const preview = S.drag && S.drag.kind === 'draw' ? S.drag.shape : null;
    if (preview) {
      c.save();
      clipToSelection(c);
      Shapes.draw(c, preview, drawEnv);
      c.restore();
    }

    if (S.tool === 'eraser' && S.hoverShape >= 0) {
      const box = shapeBounds(S.shapes[S.hoverShape]);
      c.save();
      c.strokeStyle = '#ff4d4f';
      c.lineWidth = 1;
      c.setLineDash([4, 3]);
      c.strokeRect(box.x - 3, box.y - 3, box.w + 6, box.h + 6);
      c.restore();
    }

    drawSelectionChrome(c);
  }

  function clipToSelection(c) {
    c.beginPath();
    c.rect(S.sel.x, S.sel.y, S.sel.w, S.sel.h);
    c.clip();
  }

  function drawSelectionChrome(c) {
    const { x, y, w, h } = S.sel;

    c.save();
    c.strokeStyle = SEL_STROKE;
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    if (S.phase === 'ready' && !S.tool) {
      c.fillStyle = '#ffffff';
      handlePoints().forEach((p) => {
        c.beginPath();
        c.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
        c.fill();
        c.stroke();
      });
    }
    c.restore();
  }

  function handlePoints() {
    const { x, y, w, h } = S.sel;
    const mx = x + w / 2;
    const my = y + h / 2;
    return [
      { id: 'nw', x, y },
      { id: 'n', x: mx, y },
      { id: 'ne', x: x + w, y },
      { id: 'e', x: x + w, y: my },
      { id: 'se', x: x + w, y: y + h },
      { id: 's', x: mx, y: y + h },
      { id: 'sw', x, y: y + h },
      { id: 'w', x, y: my },
    ];
  }

  function shapeBounds(shape) {
    if (shape.type === 'pen' || shape.type === 'marker') {
      const xs = shape.points.map((p) => p.x);
      const ys = shape.points.map((p) => p.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
    }
    if (shape.type === 'text') {
      const lines = String(shape.text).split('\n');
      return {
        x: shape.x,
        y: shape.y,
        w: Math.max(...lines.map((l) => l.length)) * shape.size * 0.62,
        h: lines.length * shape.size * 1.32,
      };
    }
    const [x, y, w, h] = Shapes.normalize(shape);
    return { x, y, w, h };
  }

  function drawMagnifier() {
    if (!magnifier || !S.active || !S.baseData) return;
    const { x, y } = S.cursor;
    Mag.update(magnifier, {
      base: els.base,
      x,
      y,
      screenX: Math.round(S.shot.bounds.x + x),
      screenY: Math.round(S.shot.bounds.y + y),
      rgb: pixelAt(x, y),
      hex: S.hexMode,
      crossColor: S.mode === 'record' ? CROSS_RECORD : CROSS_CAPTURE,
      ratio: S.ratio,
      viewW: S.viewW,
      viewH: S.viewH,
    });
  }

  // -------------------------------------------------------------------------
  // toolbars
  // -------------------------------------------------------------------------

  /** One-time listener setup that must survive toolbar rebuilds. */
  function wireBars() {
    // Clicks landing on bar padding must not start a new selection.
    [els.toolbar, els.subbar, els.modebar].forEach((bar) =>
      bar.addEventListener('mousedown', (e) => e.stopPropagation())
    );

    els.modebar.querySelectorAll('.mode').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setMode(btn.dataset.mode);
      });
    });

    makeDraggable(els.modeGrip, els.modebar, (pos) => {
      S.barPos = pos;
      placeModeBar();
    }, {
      // Moving the bar is a UI gesture, not colour picking — park the loupe.
      onStart: () => Mag.show(magnifier, false),
      onEnd: () => {
        if (S.phase === 'idle' && S.active) {
          Mag.show(magnifier, true);
          drawMagnifier();
        }
      },
    });

    placeModeBar();
  }

  /**
   * Drag a floating bar around the overlay by its ⋮⋮ handle. Uses capture-phase
   * listeners that swallow the event so the overlay never reads the gesture as
   * a selection drag.
   */
  function makeDraggable(grip, el, onMove, hooks = {}) {
    grip.style.cursor = 'move';

    grip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const off = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (hooks.onStart) hooks.onStart();

      const move = (ev) => {
        ev.stopPropagation();
        onMove({
          x: clamp(ev.clientX - off.x, 4, S.viewW - rect.width - 4),
          y: clamp(ev.clientY - off.y, 4, S.viewH - rect.height - 4),
        });
      };
      const up = (ev) => {
        ev.stopPropagation();
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        if (hooks.onEnd) hooks.onEnd();
      };

      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });
  }

  function setMode(mode) {
    if (mode === S.mode) return;
    S.mode = mode;
    S.tool = null;
    syncToolbar();
    syncModeBar();
    syncWebcam();
    if (S.phase === 'ready') layoutBars();
    setCursorStyle();
    markDirty('live');
  }

  /** Visible while picking a region; a chosen tool means we are past that. */
  function syncModeBar() {
    els.modebar.classList.toggle('hidden', !S.active || Boolean(S.tool) || S.phase === 'long');
    els.modebar.querySelectorAll('.mode').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === S.mode);
    });
    placeModeBar();
  }

  /**
   * The webcam bubble is a separate always-on-top window. Park it in the
   * bottom-left of the selection so the screen grab includes it.
   */
  function syncWebcam() {
    const wanted = S.mode === 'record' && S.active && S.rec.camera && Boolean(S.sel);

    // Fire-and-forget: the main side may already be tearing the session down.
    const ask = (payload) => window.took.webcam(payload).catch(() => {});

    if (!wanted) return ask({ on: false });

    const width = clamp(Math.round(S.sel.w * 0.28), 140, 320);
    const height = Math.round(width * 0.75);

    ask({
      on: true,
      deviceId: S.rec.cameraId,
      bounds: {
        x: S.shot.bounds.x + S.sel.x + 12,
        y: S.shot.bounds.y + S.sel.y + S.sel.h - height - 12,
        width,
        height,
      },
    });
  }

  function placeModeBar() {
    const w = els.modebar.offsetWidth || 200;
    const x = S.barPos ? S.barPos.x : Math.round((S.viewW - w) / 2);
    const y = S.barPos ? S.barPos.y : 12;
    els.modebar.style.transform = `translate(${x}px, ${y}px)`;
  }

  function buildToolbar() {
    els.toolbar.innerHTML = '<div class="grip"><i></i><i></i><i></i><i></i><i></i><i></i></div>';

    TOOLBAR.forEach((item) => {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'tool-sep';
        els.toolbar.appendChild(sep);
        return;
      }

      const btn = document.createElement('button');
      btn.className = `tool${item.cls ? ` ${item.cls}` : ''}`;
      btn.dataset.id = item.id;
      btn.title = T(item.title);
      btn.innerHTML = Icons[item.icon || item.id] || '';
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onToolbarClick(item);
      });
      els.toolbar.appendChild(btn);
    });

    // Dragging by the handle pins the stack; it stops following the selection
    // until the selection is thrown away.
    makeDraggable(els.toolbar.querySelector('.grip'), els.toolbar, (pos) => {
      S.toolbarPos = pos;
      layoutBars();
    });
  }

  function buildSubbar() {
    els.subbar.innerHTML = '';

    WIDTHS.forEach((w, i) => {
      const btn = document.createElement('button');
      btn.className = `width-dot${i === S.widthIdx ? ' active' : ''}`;
      btn.dataset.width = String(i);
      btn.title = T(['tool.widthThin', 'tool.widthMedium', 'tool.widthThick'][i]);
      const dot = document.createElement('i');
      const size = 5 + i * 3;
      dot.style.width = `${size}px`;
      dot.style.height = `${size}px`;
      btn.appendChild(dot);
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        S.widthIdx = i;
        syncSubbar();
      });
      els.subbar.appendChild(btn);
    });

    const sep = document.createElement('div');
    sep.className = 'tool-sep';
    els.subbar.appendChild(sep);

    COLORS.forEach((color) => {
      const btn = document.createElement('button');
      btn.className = `swatch${color.value === S.color ? ' active' : ''}`;
      btn.dataset.color = color.value;
      if (color.light) btn.dataset.light = '1';
      btn.style.background = color.value;
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        S.color = color.value;
        syncSubbar();
        if (S.textEdit) els.text.style.color = S.color;
      });
      els.subbar.appendChild(btn);
    });
  }

  function syncSubbar() {
    els.subbar.querySelectorAll('.width-dot').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.width) === S.widthIdx);
    });
    els.subbar.querySelectorAll('.swatch').forEach((el) => {
      el.classList.toggle('active', el.dataset.color === S.color);
    });
    if (S.textEdit) {
      els.text.style.font = Shapes.fontFor(TEXT_SIZES[S.widthIdx]);
      autoGrowText();
    }
  }

  function syncToolbar() {
    // 录屏 and 长截图 have no annotation step — their card takes the toolbar's
    // place.
    if (S.mode === 'record' || S.mode === 'long') {
      els.toolbar.classList.add('hidden');
      els.subbar.classList.add('hidden');
      const show = S.phase === 'ready' && S.active;
      RecordPanel.show(recPanel, S.mode === 'record' && show, S.sel, S.viewW, S.viewH);
      LongShot.showCard(longShot, S.mode === 'long' && show, S.sel, S.viewW, S.viewH);
      syncModeBar();
      return;
    }

    RecordPanel.show(recPanel, false);
    LongShot.showCard(longShot, false);
    els.toolbar.querySelectorAll('.tool').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === S.tool);
      if (el.dataset.id === 'undo') el.classList.toggle('disabled', S.shapes.length === 0);
    });
    // Only drawing tools carry a colour and a stroke width.
    const wantsSub = SHAPE_TOOLS.has(S.tool);
    els.subbar.classList.toggle('hidden', !wantsSub);
    if (wantsSub) layoutBars();
    syncModeBar();
  }

  function onToolbarClick(item) {
    switch (item.id) {
      case 'undo':
        undo();
        return;
      case 'save':
        doSave();
        return;
      case 'close':
        window.took.cancel();
        return;
      case 'confirm':
        doConfirm();
        return;
      case 'pin':
        doPin();
        return;
      case 'qr':
        doQR();
        return;
      default:
        commitText();
        S.tool = S.tool === item.id ? null : item.id;
        syncToolbar();
        setCursorStyle();
        markDirty('live');
    }
  }

  function layoutBars() {
    if (!S.sel) return;

    if (S.mode === 'record') {
      if (S.phase === 'ready') RecordPanel.place(recPanel, S.sel, S.viewW, S.viewH);
      return;
    }
    if (S.mode === 'long') {
      if (S.phase === 'ready') LongShot.placeCard(longShot, S.sel, S.viewW, S.viewH);
      return;
    }

    els.toolbar.classList.remove('hidden');
    const tw = els.toolbar.offsetWidth;
    const th = els.toolbar.offsetHeight;
    const sh = els.subbar.classList.contains('hidden') ? 0 : els.subbar.offsetHeight + 6;

    const { x, y, w, h } = S.sel;
    // Stay inside the work area so a full-screen selection does not park the
    // toolbar underneath the taskbar.
    const wa = S.workArea;
    const waBottom = wa.y + wa.height;
    const stackH = th + sh; // sh already carries its 6px gap

    let left;
    let top;
    let stackDown = true;

    if (S.toolbarPos) {
      left = S.toolbarPos.x;
      top = S.toolbarPos.y;
      if (top + stackH > waBottom - 6) stackDown = false;
    } else {
      const below = y + h + 8;
      const above = y - stackH - 8;

      if (below + stackH <= waBottom - 6) {
        top = below;
        left = x + w - tw;
      } else if (above >= wa.y + 6) {
        top = above + sh; // toolbar sits under the subbar when flipped up
        stackDown = false;
        left = x + w - tw;
      } else {
        // No room on either side — tuck the stack into the selection's own
        // bottom-right corner, which is where a full-screen grab lands.
        top = y + h - stackH - 10;
        left = x + w - tw - 10;
      }
    }

    top = clamp(top, wa.y + 6, Math.max(wa.y + 6, waBottom - th - 6));
    left = clamp(left, wa.x + 6, wa.x + wa.width - tw - 6);

    els.toolbar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;

    if (sh) {
      const subH = els.subbar.offsetHeight;
      const subTop = stackDown ? top + th + 6 : top - subH - 6;
      els.subbar.style.transform = `translate(${Math.round(left)}px, ${Math.round(
        clamp(subTop, wa.y + 6, waBottom - subH - 6)
      )}px)`;
    }
  }

  function layoutBadge() {
    if (!S.sel) return;
    els.badge.classList.remove('hidden');
    els.badge.textContent = `${Math.round(S.sel.w)} x ${Math.round(S.sel.h)}`;

    const bh = els.badge.offsetHeight;
    const top = S.sel.y - bh - 6 < 4 ? S.sel.y + 6 : S.sel.y - bh - 6;
    const left = clamp(S.sel.x, 4, S.viewW - els.badge.offsetWidth - 4);
    els.badge.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  // -------------------------------------------------------------------------
  // pointer interaction
  // -------------------------------------------------------------------------

  document.addEventListener('mousedown', (e) => {
    // During a scrolling screenshot the selection is fixed; only its panel
    // takes clicks, and that stops them before they get here.
    if (e.button !== 0 || !S.ready || S.phase === 'long') return;
    if (!S.active) {
      // A click on a non-owning display restarts the selection there.
      S.active = true;
      window.took.claim();
      syncModeBar();
    }

    const p = point(e);
    commitText();

    if (S.phase === 'idle') {
      window.took.claim();
      S.drag = { kind: 'select', ox: p.x, oy: p.y, moved: false };
      return;
    }

    if (S.tool && SHAPE_TOOLS.has(S.tool)) {
      if (!inSelection(p)) return;
      if (S.tool === 'text') {
        startText(p);
        return;
      }
      S.drag = { kind: 'draw', shape: newShape(S.tool, p) };
      markDirty('live');
      return;
    }

    if (S.tool === 'eraser') {
      const idx = findShape(p);
      if (idx >= 0) {
        S.shapes.splice(idx, 1);
        S.hoverShape = -1;
        syncToolbar();
        markDirty('shapes', 'live');
      }
      return;
    }

    const handle = findHandle(p);
    if (handle) {
      S.drag = { kind: 'resize', handle, start: { ...S.sel } };
      Mag.show(magnifier, true); // the loupe helps land the edge on a pixel
      return;
    }

    if (inSelection(p)) {
      S.drag = { kind: 'move', ox: p.x, oy: p.y, start: { ...S.sel } };
      return;
    }

    // Outside the box with no tool: draw a fresh selection.
    S.phase = 'idle';
    S.toolbarPos = null;
    S.drag = { kind: 'select', ox: p.x, oy: p.y, moved: false };
    hideChrome();
    markDirty('mask', 'live');
  });

  document.addEventListener('mousemove', (e) => {
    if (!S.ready || S.phase === 'long') return;
    const p = point(e);
    S.cursor = p;

    const d = S.drag;
    if (!d) {
      if (S.phase === 'idle' && S.active) drawMagnifier();
      if (S.tool === 'eraser') {
        const idx = findShape(p);
        if (idx !== S.hoverShape) {
          S.hoverShape = idx;
          markDirty('live');
        }
      }
      setCursorStyle(p);
      return;
    }

    switch (d.kind) {
      case 'select': {
        if (Math.abs(p.x - d.ox) > CLICK_SLOP || Math.abs(p.y - d.oy) > CLICK_SLOP) d.moved = true;

        // Hold the full-screen default until the pointer really travels —
        // otherwise a shaky click collapses it to a speck and the screen
        // flashes dim on the way back.
        if (!d.moved && S.preselect) {
          drawMagnifier();
          break;
        }

        S.preselect = false;
        S.sel = rectFrom(d.ox, d.oy, p.x, p.y);
        layoutBadge();
        drawMagnifier();
        markDirty('mask', 'live');
        break;
      }

      case 'draw': {
        updateShape(d.shape, p);
        markDirty('live');
        break;
      }

      case 'move': {
        const w = d.start.w;
        const h = d.start.h;
        S.sel = {
          x: clamp(d.start.x + (p.x - d.ox), 0, S.viewW - w),
          y: clamp(d.start.y + (p.y - d.oy), 0, S.viewH - h),
          w,
          h,
        };
        layoutBadge();
        layoutBars();
        markDirty('mask', 'shapes', 'live');
        break;
      }

      case 'resize': {
        S.sel = resize(d.start, d.handle, p);
        layoutBadge();
        layoutBars();
        drawMagnifier();
        markDirty('mask', 'shapes', 'live');
        break;
      }
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !S.drag) return;
    const d = S.drag;
    S.drag = null;

    if (d.kind === 'select') {
      // A bare click accepts the whole-display default that is already framed.
      if (!d.moved) S.sel = { x: 0, y: 0, w: S.viewW, h: S.viewH };

      // A drag too small to be meaningful falls back to that default rather
      // than leaving nothing selected.
      if (S.sel.w < 2 || S.sel.h < 2) {
        preselectFullScreen();
        return;
      }

      enterReady();
      return;
    }

    if (d.kind === 'draw') {
      if (isMeaningful(d.shape)) {
        S.shapes.push(d.shape);
        syncToolbar();
        markDirty('shapes');
      }
      markDirty('live');
      return;
    }

    if (d.kind === 'resize' || d.kind === 'move') {
      Mag.show(magnifier, false);
      layoutBars();
      markDirty('live');
    }
  });

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (S.phase === 'long') return;
    if (S.textEdit) {
      cancelText();
      return;
    }
    if (S.tool) {
      S.tool = null;
      syncToolbar();
      setCursorStyle();
      markDirty('live');
      return;
    }
    if (S.phase === 'ready') {
      resetSelection();
      return;
    }
    window.took.cancel();
  });

  /** Frame the whole display as the pending default selection. */
  function preselectFullScreen() {
    S.phase = 'idle';
    S.sel = { x: 0, y: 0, w: S.viewW, h: S.viewH };
    S.preselect = true;
    layoutBadge();
    markDirty('mask', 'live');
  }

  function enterReady() {
    S.phase = 'ready';
    S.preselect = false;
    Mag.show(magnifier, false);
    layoutBadge();
    syncToolbar();
    layoutBars();
    syncWebcam();
    setCursorStyle();
    markDirty('live');
  }

  function resetSelection() {
    S.shapes = [];
    S.tool = null;
    S.hoverShape = -1;
    S.toolbarPos = null;
    hideChrome();

    // Back to the opening state rather than to nothing selected.
    if (S.active) preselectFullScreen();
    else {
      S.phase = 'idle';
      S.sel = null;
      S.preselect = false;
    }

    Mag.show(magnifier, S.active);
    syncModeBar();
    syncWebcam();
    setCursorStyle();
    markDirty('mask', 'shapes', 'live');
    drawMagnifier();
  }

  function hideChrome() {
    els.toolbar.classList.add('hidden');
    els.subbar.classList.add('hidden');
    els.badge.classList.add('hidden');
    if (recPanel) RecordPanel.show(recPanel, false);
    if (longShot) LongShot.showCard(longShot, false);
  }

  function point(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function inSelection(p) {
    const s = S.sel;
    return !!s && p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h;
  }

  function findHandle(p) {
    if (S.phase !== 'ready' || S.tool) return null;
    return handlePoints().find((h) => Math.hypot(p.x - h.x, p.y - h.y) <= HANDLE_HIT) || null;
  }

  function findShape(p) {
    for (let i = S.shapes.length - 1; i >= 0; i--) {
      if (Shapes.hitTest(S.shapes[i], p.x, p.y)) return i;
    }
    return -1;
  }

  function rectFrom(x1, y1, x2, y2) {
    return {
      x: clamp(Math.min(x1, x2), 0, S.viewW),
      y: clamp(Math.min(y1, y2), 0, S.viewH),
      w: Math.min(Math.abs(x2 - x1), S.viewW - Math.min(x1, x2)),
      h: Math.min(Math.abs(y2 - y1), S.viewH - Math.min(y1, y2)),
    };
  }

  function resize(start, handle, p) {
    let left = start.x;
    let top = start.y;
    let right = start.x + start.w;
    let bottom = start.y + start.h;

    const id = handle.id;
    if (id.includes('w')) left = clamp(p.x, 0, S.viewW);
    if (id.includes('e')) right = clamp(p.x, 0, S.viewW);
    if (id.includes('n')) top = clamp(p.y, 0, S.viewH);
    if (id.includes('s')) bottom = clamp(p.y, 0, S.viewH);

    return {
      x: Math.min(left, right),
      y: Math.min(top, bottom),
      w: Math.abs(right - left),
      h: Math.abs(bottom - top),
    };
  }

  function setCursorStyle(p) {
    if (S.phase === 'long') {
      document.body.style.cursor = 'default';
      return;
    }
    if (S.phase === 'idle') {
      document.body.style.cursor = 'crosshair';
      return;
    }
    if (S.tool === 'text') {
      document.body.style.cursor = 'text';
      return;
    }
    if (S.tool) {
      document.body.style.cursor = 'crosshair';
      return;
    }
    const handle = p ? findHandle(p) : null;
    if (handle) {
      const map = {
        n: 'ns-resize',
        s: 'ns-resize',
        e: 'ew-resize',
        w: 'ew-resize',
        nw: 'nwse-resize',
        se: 'nwse-resize',
        ne: 'nesw-resize',
        sw: 'nesw-resize',
      };
      document.body.style.cursor = map[handle.id];
      return;
    }
    document.body.style.cursor = p && inSelection(p) ? 'move' : 'default';
  }

  // -------------------------------------------------------------------------
  // shape building
  // -------------------------------------------------------------------------

  function newShape(tool, p) {
    const base = { type: tool, color: S.color, width: WIDTHS[S.widthIdx] };
    if (FREEHAND.has(tool)) return { ...base, points: [{ x: p.x, y: p.y }] };
    return { ...base, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  }

  function updateShape(shape, p) {
    if (FREEHAND.has(shape.type)) {
      const last = shape.points[shape.points.length - 1];
      // Skip micro-moves so the smoothing pass has room to work.
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 1.5) shape.points.push({ x: p.x, y: p.y });
      return;
    }
    shape.x2 = p.x;
    shape.y2 = p.y;
  }

  function isMeaningful(shape) {
    if (FREEHAND.has(shape.type)) return shape.points.length > 1;
    return Math.abs(shape.x2 - shape.x1) > 2 || Math.abs(shape.y2 - shape.y1) > 2;
  }

  function undo() {
    if (!S.shapes.length) return;
    S.shapes.pop();
    S.hoverShape = -1;
    syncToolbar();
    markDirty('shapes', 'live');
  }

  // -------------------------------------------------------------------------
  // text tool
  // -------------------------------------------------------------------------

  function startText(p) {
    S.textEdit = { x: p.x, y: p.y, size: TEXT_SIZES[S.widthIdx] };

    els.text.value = '';
    els.text.style.color = S.color;
    els.text.classList.remove('hidden');
    autoGrowText();
    els.text.focus();
  }

  /**
   * Size the editor to its content. A textarea's intrinsic width comes from
   * `cols`, so scrollWidth never reports the real text extent — measure it on a
   * canvas with the exact font the committed shape will use.
   */
  function autoGrowText() {
    if (!S.textEdit) return;
    const size = TEXT_SIZES[S.widthIdx];
    S.textEdit.size = size;

    const font = Shapes.fontFor(size);
    els.text.style.font = font;
    els.text.style.lineHeight = '1.32';

    measure.font = font;
    const lines = els.text.value.split('\n');
    const width = Math.max(...lines.map((l) => measure.measureText(l).width), size * 0.9);

    els.text.style.width = `${Math.ceil(width) + size * 0.7}px`;
    els.text.style.height = `${Math.ceil(lines.length * size * 1.32) + 4}px`;
    // The 1px dashed border sits outside the content box; shift back so the
    // caret lands exactly where the glyphs will be drawn.
    els.text.style.transform = `translate(${Math.round(S.textEdit.x) - 1}px, ${
      Math.round(S.textEdit.y) - 1
    }px)`;
  }

  function commitText() {
    if (!S.textEdit) return;
    const text = els.text.value.replace(/\s+$/, '');
    const { x, y, size } = S.textEdit;

    S.textEdit = null;
    els.text.classList.add('hidden');
    els.text.value = '';

    if (!text) return;
    S.shapes.push({
      type: 'text',
      text,
      x,
      y,
      size,
      color: S.color,
      width: WIDTHS[S.widthIdx],
    });
    syncToolbar();
    markDirty('shapes');
  }

  function cancelText() {
    if (!S.textEdit) return;
    S.textEdit = null;
    els.text.classList.add('hidden');
    els.text.value = '';
  }

  els.text.addEventListener('input', autoGrowText);
  els.text.addEventListener('mousedown', (e) => e.stopPropagation());
  els.text.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      cancelText();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitText();
    }
  });

  // -------------------------------------------------------------------------
  // output
  // -------------------------------------------------------------------------

  /** Flatten the selection plus annotations into a native-resolution canvas. */
  function composite() {
    const { x, y, w, h } = S.sel;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * S.ratio));
    out.height = Math.max(1, Math.round(h * S.ratio));

    const c = out.getContext('2d');
    c.drawImage(
      els.base,
      Math.round(x * S.ratio),
      Math.round(y * S.ratio),
      out.width,
      out.height,
      0,
      0,
      out.width,
      out.height
    );

    c.save();
    c.scale(S.ratio, S.ratio);
    c.translate(-x, -y);
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    S.shapes.forEach((s) => Shapes.draw(c, s, drawEnv));
    c.restore();

    return out;
  }

  function doConfirm() {
    if (!S.sel) return;
    commitText();

    if (S.mode === 'record') {
      window.took.startRecord({
        rect: {
          x: Math.round(S.sel.x),
          y: Math.round(S.sel.y),
          width: Math.round(S.sel.w),
          height: Math.round(S.sel.h),
        },
        displayId: S.shot.displayId,
        scaleFactor: S.ratio,
        settings: { ...S.rec },
      });
      return;
    }

    if (S.mode === 'long') {
      startLong();
      return;
    }

    copyImage(composite().toDataURL('image/png'));
  }

  function copyImage(dataURL) {
    window.took.copy(dataURL).then((ok) => {
      // Main leaves the overlay up when the write fails; say so, rather than
      // sit there looking like the click never landed.
      if (!ok) toast(T('toast.copyFailed'), 2600);
    });
  }

  /** The card's Start: the selection goes live and the capture begins. */
  function startLong() {
    if (!S.sel || S.phase !== 'ready' || S.mode !== 'long') return;
    S.phase = 'long';
    S.tool = null;
    S.shapes = [];
    hideChrome();
    syncModeBar();
    Mag.show(magnifier, false);
    // From here on the selection shows the live screen, so the frozen one goes.
    els.base.classList.add('hidden');
    setCursorStyle();
    markDirty('mask', 'shapes', 'live');

    LongShot.start(longShot, {
      shot: S.shot,
      sel: { ...S.sel },
      viewW: S.viewW,
      viewH: S.viewH,
      workArea: S.workArea,
    });
  }

  /** Keys while a scrolling screenshot runs, or once it has stopped. */
  function onLongKey(e, mod) {
    if (e.key === 'Escape') {
      e.preventDefault();
      LongShot.act(longShot, 'cancel');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (LongShot.state(longShot) === 'running') LongShot.stop(longShot);
      else LongShot.act(longShot, 'confirm');
    } else if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      LongShot.act(longShot, 'save');
    } else if (mod && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      LongShot.act(longShot, 'confirm');
    }
  }

  function doSave() {
    if (!S.sel || S.mode !== 'capture') return;
    commitText();
    window.took.save(composite().toDataURL('image/png'));
  }

  function doPin() {
    if (!S.sel) return;
    commitText();
    window.took.pin({
      dataURL: composite().toDataURL('image/png'),
      rect: {
        x: S.shot.bounds.x + S.sel.x,
        y: S.shot.bounds.y + S.sel.y,
        width: S.sel.w,
        height: S.sel.h,
      },
    });
  }

  /** The raw screenshot crop, with no annotations painted over it. */
  function cropBase() {
    const { x, y, w, h } = S.sel;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * S.ratio));
    out.height = Math.max(1, Math.round(h * S.ratio));
    out
      .getContext('2d')
      .drawImage(
        els.base,
        Math.round(x * S.ratio),
        Math.round(y * S.ratio),
        out.width,
        out.height,
        0,
        0,
        out.width,
        out.height
      );
    return out;
  }

  function doQR() {
    if (!S.sel) return;
    // Decode the untouched pixels — a mosaic or arrow on top would break it.
    const canvas = cropBase();
    const c = canvas.getContext('2d', { willReadFrequently: true });
    const img = c.getImageData(0, 0, canvas.width, canvas.height);

    let text = null;
    try {
      text = window.took.decodeQR(img.data, canvas.width, canvas.height);
    } catch (err) {
      console.error('[took] 二维码识别出错:', err);
    }

    if (text) {
      window.took.copyText(text);
      toast(T('toast.qrFound', { text }), 2600);
    } else {
      toast(T('toast.qrMissing'), 1800);
    }
  }

  function copyColor() {
    const [r, g, b] = pixelAt(S.cursor.x, S.cursor.y);
    const value = S.hexMode ? Mag.toHex(r, g, b) : `${r},${g},${b}`;
    window.took.copyText(value);
    toast(T('toast.copiedColour', { value }), 1200);
  }

  function toast(message, ms) {
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms || 1600);
  }

  // -------------------------------------------------------------------------
  // keyboard
  // -------------------------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (!S.ready) return;
    const mod = e.ctrlKey || e.metaKey;

    if (S.phase === 'long') {
      onLongKey(e, mod);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (S.textEdit) return cancelText();
      if (S.tool) {
        S.tool = null;
        syncToolbar();
        setCursorStyle();
        return markDirty('live');
      }
      return window.took.cancel();
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (S.phase === 'ready') doConfirm();
      return;
    }

    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      return undo();
    }

    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      return doSave();
    }

    if (mod && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      return S.phase === 'ready' ? doConfirm() : copyColor();
    }

    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      S.sel = { x: 0, y: 0, w: S.viewW, h: S.viewH };
      return enterReady();
    }

    // Shift flips the readout between RGB and HEX while picking.
    if (e.key === 'Shift' && !e.repeat && S.phase === 'idle') {
      S.hexMode = !S.hexMode;
      return drawMagnifier();
    }

    // Arrow keys nudge the selection edge / whole box by a pixel.
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      e.key
    ];
    if (nudge && S.phase === 'ready') {
      e.preventDefault();
      const [dx, dy] = nudge;
      if (e.shiftKey) {
        S.sel.w = clamp(S.sel.w + dx, 1, S.viewW - S.sel.x);
        S.sel.h = clamp(S.sel.h + dy, 1, S.viewH - S.sel.y);
      } else {
        S.sel.x = clamp(S.sel.x + dx, 0, S.viewW - S.sel.w);
        S.sel.y = clamp(S.sel.y + dy, 0, S.viewH - S.sel.h);
      }
      layoutBadge();
      layoutBars();
      markDirty('mask', 'shapes', 'live');
    }
  });

  window.addEventListener('resize', () => {
    S.viewW = window.innerWidth;
    S.viewH = window.innerHeight;
    placeModeBar();
    markDirty('mask', 'live');
  });

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Introspection hook for tools/preview-ui.js and the checks.
  window.__tookDebug = () => ({
    ready: S.ready,
    mode: S.mode,
    phase: S.phase,
    tool: S.tool,
    shapes: S.shapes.length,
    sel: S.sel,
    long: longShot ? LongShot.state(longShot) : null,
    longStats: longShot ? LongShot.stats(longShot) : null,
  });
})();

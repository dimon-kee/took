'use strict';

/**
 * Always-on-top webcam bubble. It is a real window rather than something
 * composited into the recording, so the desktop grab picks it up on its own and
 * it stays draggable while recording.
 */
(() => {
  const canvas = document.getElementById('view');
  const ctx = canvas.getContext('2d');
  const menu = document.getElementById('menu');

  const opts = {
    mirror: document.getElementById('opt-mirror'),
    beauty: document.getElementById('opt-beauty'),
    blur: document.getElementById('opt-blur'),
  };

  let video = null;
  let stream = null;
  let shape = 'rect';
  let raf = 0;

  start();

  async function start() {
    try {
      const deviceId = window.took.deviceId;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: 1280, height: 720 }
          : { width: 1280, height: 720 },
      });

      video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      probeBackgroundBlur();
      resize();
      loop();
    } catch (err) {
      console.error('[took] 摄像头启动失败:', err);
      window.took.failed(err.name === 'NotAllowedError' ? '摄像头权限被拒绝' : err.message);
    }
  }

  /**
   * Chromium can offload background blur to the platform on capable hardware.
   * There is no software fallback worth shipping, so the option is disabled
   * when the track cannot do it.
   */
  function probeBackgroundBlur() {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const supported = Array.isArray(caps.backgroundBlur) && caps.backgroundBlur.includes(true);

    if (!supported) {
      const row = document.getElementById('row-blur');
      row.classList.add('disabled');
      row.title = '当前摄像头 / 系统不支持背景虚化';
    }

    opts.blur.addEventListener('change', async () => {
      if (!supported) return;
      try {
        await track.applyConstraints({ advanced: [{ backgroundBlur: opts.blur.checked }] });
      } catch (err) {
        console.warn('[took] 背景虚化切换失败:', err.message);
      }
    });
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (!video || video.readyState < 2) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    clipShape(ctx, w, h);

    if (opts.mirror.checked) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }

    drawCover(ctx, video, w, h);

    // Cheap soft-focus pass: a blurred copy laid back over the frame keeps skin
    // smooth without touching the actual pixels' colour balance much.
    if (opts.beauty.checked) {
      ctx.globalAlpha = 0.42;
      ctx.filter = 'blur(6px) brightness(1.07) saturate(1.04)';
      drawCover(ctx, video, w, h);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  /** Fill the canvas with the frame, cropping the overflow (object-fit: cover). */
  function drawCover(c, src, w, h) {
    const vw = src.videoWidth;
    const vh = src.videoHeight;
    if (!vw || !vh) return;

    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    c.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function clipShape(c, w, h) {
    c.beginPath();
    if (shape === 'circle') {
      c.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else {
      c.roundRect(0, 0, w, h, Math.min(14, w / 8, h / 8));
    }
    c.clip();
  }

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
  }

  window.addEventListener('resize', resize);

  document.querySelectorAll('.shape').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.shape === shape);
    btn.addEventListener('click', () => {
      shape = btn.dataset.shape;
      document
        .querySelectorAll('.shape')
        .forEach((b) => b.classList.toggle('active', b.dataset.shape === shape));
    });
  });

  document.getElementById('btn-gear').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle('hidden');
    document.body.classList.toggle('menu-open', !open);
  });

  document.addEventListener('click', (e) => {
    if (menu.contains(e.target)) return;
    menu.classList.add('hidden');
    document.body.classList.remove('menu-open');
  });

  window.addEventListener('beforeunload', () => {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
  });
})();

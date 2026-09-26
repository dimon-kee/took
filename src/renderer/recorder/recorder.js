'use strict';

/**
 * Hidden worker window that owns the capture.
 *
 * It pulls the whole display as a MediaStream, redraws only the chosen region
 * into a canvas (adding the cursor overlays), then either records that canvas
 * with MediaRecorder (MP4) or encodes it frame by frame as a GIF.
 *
 * The webcam is deliberately absent here: it lives in its own always-on-top
 * window, so the screen grab picks it up for free.
 */
(() => {
  const FPS = 30;
  const GIF_FPS = 10;
  const GIF_MAX_WIDTH = 640;
  const CLICK_MS = 520; // ripple lifetime
  const HIGHLIGHT_R = 26;

  const state = {
    settings: null,
    crop: null,
    region: null,
    displayBounds: null,
    scaleFactor: 1,
    frameScale: { x: 1, y: 1 },
  };

  let video = null;
  let canvas = null;
  let ctx = null;
  let displayStream = null;
  let micStream = null;
  let audioCtx = null;
  let recorder = null;
  let chunks = [];
  let mime = '';

  let drawTimer = 0;
  let statusTimer = 0;
  let startedAt = 0;
  let pausedAt = 0;
  let pausedTotal = 0;
  let paused = false;
  let aborted = false;
  let finished = false;

  // cursor overlay state
  let cursor = { x: -9999, y: -9999, down: false };
  let clicks = [];

  // GIF
  let gif = null;
  let gifCanvas = null;
  let gifCtx = null;
  let gifLastAt = 0;
  let gifFrames = 0;

  // -------------------------------------------------------------------------

  window.took.onStart(async (opts) => {
    try {
      await start(opts);
    } catch (err) {
      console.error('[took] recorder:', err);
      window.took.failed(describe(err));
    }
  });

  window.took.onPause(() => {
    if (paused || finished) return;
    paused = true;
    pausedAt = Date.now();
    if (recorder && recorder.state === 'recording') recorder.pause();
    pushStatus();
  });

  window.took.onResume(() => {
    if (!paused || finished) return;
    paused = false;
    pausedTotal += Date.now() - pausedAt;
    pausedAt = 0;
    if (recorder && recorder.state === 'paused') recorder.resume();
    pushStatus();
  });

  window.took.onStop(() => stop());

  window.took.onAbort(() => {
    aborted = true;
    cleanup();
  });

  window.took.onToggleMic((on) => {
    if (micStream) micStream.getAudioTracks().forEach((t) => (t.enabled = Boolean(on)));
  });

  window.took.onCursor((sample) => {
    cursor = sample;
    if (sample.clicked && state.settings && state.settings.clickEffect && !paused) {
      clicks.push({ x: sample.x, y: sample.y, at: performance.now() });
      if (clicks.length > 12) clicks.shift();
    }
  });

  // -------------------------------------------------------------------------

  async function start(opts) {
    state.settings = opts.settings;
    state.region = opts.region;
    state.displayBounds = opts.displayBounds;
    state.scaleFactor = opts.scaleFactor;

    const wantsSystemAudio = opts.settings.format === 'mp4' && opts.settings.speaker;

    displayStream = await navigator.mediaDevices.getUserMedia({
      audio: wantsSystemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: opts.sourceId,
          minWidth: opts.displayPixelSize.width,
          maxWidth: opts.displayPixelSize.width,
          minHeight: opts.displayPixelSize.height,
          maxHeight: opts.displayPixelSize.height,
          maxFrameRate: FPS,
        },
      },
    });

    video = document.createElement('video');
    video.srcObject = new MediaStream(displayStream.getVideoTracks());
    video.muted = true;
    await video.play();

    setupCrop(opts);

    canvas = document.createElement('canvas');
    // H.264 wants even dimensions.
    canvas.width = Math.max(2, state.crop.w - (state.crop.w % 2));
    canvas.height = Math.max(2, state.crop.h - (state.crop.h % 2));
    ctx = canvas.getContext('2d', { alpha: false });

    startedAt = Date.now();
    pausedTotal = 0;

    if (opts.settings.format === 'gif') {
      await startGif();
    } else {
      await startVideo(opts);
    }

    drawTimer = setInterval(drawFrame, Math.round(1000 / FPS));
    statusTimer = setInterval(pushStatus, 250);
    pushStatus();
  }

  function setupCrop(opts) {
    // The captured frame can come back at a different scale than the display
    // reports, so derive the factor from the real frame size.
    const frameW = video.videoWidth || opts.displayPixelSize.width;
    const frameH = video.videoHeight || opts.displayPixelSize.height;

    state.frameScale = {
      x: frameW / opts.displayPixelSize.width,
      y: frameH / opts.displayPixelSize.height,
    };

    const r = opts.region;
    const s = opts.scaleFactor;
    state.crop = {
      x: Math.round(r.x * s * state.frameScale.x),
      y: Math.round(r.y * s * state.frameScale.y),
      w: Math.round(r.width * s * state.frameScale.x),
      h: Math.round(r.height * s * state.frameScale.y),
    };
  }

  // --- MP4 -----------------------------------------------------------------

  async function startVideo(opts) {
    const out = canvas.captureStream(FPS);

    const audioTracks = await collectAudio(opts);
    audioTracks.forEach((t) => out.addTrack(t));

    mime = pickMime(audioTracks.length > 0);
    recorder = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 8_000_000 });

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = finishVideo;
    recorder.onerror = (e) => window.took.failed(describe(e.error || e));

    chunks = [];
    recorder.start(1000);
  }

  /**
   * System loopback and the microphone are separate streams; mix them through
   * one AudioContext so the recording carries a single audio track.
   */
  async function collectAudio(opts) {
    const sources = [];
    const desktopAudio = displayStream.getAudioTracks();

    if (opts.settings.speaker && desktopAudio.length) {
      sources.push(new MediaStream(desktopAudio));
    }

    if (opts.settings.mic) {
      micStream = await tryMic(opts.settings.micId);
      if (micStream) sources.push(micStream);
    }

    if (!sources.length) return [];
    if (sources.length === 1) return sources[0].getAudioTracks();

    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    sources.forEach((s) => audioCtx.createMediaStreamSource(s).connect(dest));
    return dest.stream.getAudioTracks();
  }

  async function tryMic(deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
    } catch (err) {
      console.warn('[took] 麦克风不可用:', err.message);
      return null;
    }
  }

  function pickMime(withAudio) {
    const candidates = withAudio
      ? [
          'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
          'video/mp4',
          'video/webm;codecs=vp9,opus',
          'video/webm',
        ]
      : ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
  }

  // --- GIF -----------------------------------------------------------------

  async function startGif() {
    window.tookGif.begin();
    gif = true;
    mime = 'image/gif';

    // Encoding happens inline on every sampled frame, so keep the raster small.
    const scale = Math.min(1, GIF_MAX_WIDTH / canvas.width);
    gifCanvas = document.createElement('canvas');
    gifCanvas.width = Math.max(2, Math.round(canvas.width * scale));
    gifCanvas.height = Math.max(2, Math.round(canvas.height * scale));
    gifCtx = gifCanvas.getContext('2d', { alpha: false, willReadFrequently: true });

    gifLastAt = 0;
    gifFrames = 0;
  }

  function writeGifFrame(now) {
    const interval = 1000 / GIF_FPS;
    if (gifLastAt && now - gifLastAt < interval) return;

    const delay = gifLastAt ? Math.round(now - gifLastAt) : interval;
    gifLastAt = now;

    gifCtx.drawImage(canvas, 0, 0, gifCanvas.width, gifCanvas.height);
    const { data } = gifCtx.getImageData(0, 0, gifCanvas.width, gifCanvas.height);

    window.tookGif.addFrame(data, gifCanvas.width, gifCanvas.height, delay);
    gifFrames++;
  }

  // --- frame loop ----------------------------------------------------------

  function drawFrame() {
    if (paused || finished || !video || video.readyState < 2) return;

    const c = state.crop;
    ctx.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);

    if (state.settings.cursor) drawCursorEffects();

    if (gif) writeGifFrame(performance.now());
  }

  /** Cursor position arrives in global screen coords; map into canvas space. */
  function toCanvas(gx, gy) {
    const localX = gx - state.displayBounds.x - state.region.x;
    const localY = gy - state.displayBounds.y - state.region.y;
    return {
      x: (localX / state.region.width) * canvas.width,
      y: (localY / state.region.height) * canvas.height,
    };
  }

  function drawCursorEffects() {
    const now = performance.now();
    const scale = canvas.width / state.region.width;

    if (state.settings.mouseHighlight) {
      const p = toCanvas(cursor.x, cursor.y);
      const r = HIGHLIGHT_R * scale;
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grad.addColorStop(0, 'rgba(255,214,0,0.42)');
      grad.addColorStop(0.72, 'rgba(255,193,7,0.26)');
      grad.addColorStop(1, 'rgba(255,193,7,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!state.settings.clickEffect) return;

    clicks = clicks.filter((c) => now - c.at < CLICK_MS);
    clicks.forEach((c) => {
      const t = (now - c.at) / CLICK_MS;
      const p = toCanvas(c.x, c.y);
      const r = (10 + t * 30) * scale;

      ctx.strokeStyle = `rgba(24,144,255,${(1 - t) * 0.85})`;
      ctx.lineWidth = Math.max(1.5, 2.6 * scale * (1 - t * 0.5));
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
    });
  }

  // --- finish --------------------------------------------------------------

  function stop() {
    if (finished) return;
    finished = true;

    clearInterval(drawTimer);
    clearInterval(statusTimer);
    drawTimer = 0;
    statusTimer = 0;

    if (gif) return finishGif();
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else cleanup();
  }

  async function finishVideo() {
    const blob = new Blob(chunks, { type: mime });
    chunks = [];
    cleanup();

    if (aborted || !blob.size) return;
    deliver(await blob.arrayBuffer(), mime);
  }

  function finishGif() {
    cleanup();
    const bytes = window.tookGif.end();
    gif = null;
    if (aborted || !gifFrames || !bytes) return;
    deliver(bytes, 'image/gif');
  }

  function deliver(data, type) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    window.took.done(bytes, type, {
      width: canvas.width,
      height: canvas.height,
      seconds: elapsed(),
    });
  }

  function cleanup() {
    clearInterval(drawTimer);
    clearInterval(statusTimer);
    drawTimer = 0;
    statusTimer = 0;

    [displayStream, micStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
    displayStream = null;
    micStream = null;

    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    if (video) {
      video.srcObject = null;
      video = null;
    }
    recorder = null;
  }

  function elapsed() {
    const now = paused && pausedAt ? pausedAt : Date.now();
    return Math.max(0, Math.floor((now - startedAt - pausedTotal) / 1000));
  }

  function pushStatus() {
    if (finished) return;
    window.took.status({
      state: paused ? 'paused' : 'recording',
      seconds: elapsed(),
      format: state.settings ? state.settings.format : 'mp4',
      hasMic: Boolean(micStream),
      micOn: Boolean(micStream && micStream.getAudioTracks().some((t) => t.enabled)),
    });
  }

  function describe(err) {
    if (!err) return '未知错误';
    if (err.name === 'NotAllowedError') return '屏幕录制权限被拒绝';
    if (err.name === 'NotFoundError') return '找不到可录制的屏幕源';
    return err.message || String(err);
  }
})();

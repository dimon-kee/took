'use strict';

(() => {
  const els = {
    player: document.getElementById('player'),
    still: document.getElementById('still'),
    track: document.getElementById('track'),
    fill: document.getElementById('track-fill'),
    head: document.getElementById('track-head'),
    play: document.getElementById('btn-play'),
    glyphPlay: document.getElementById('glyph-play'),
    glyphPause: document.getElementById('glyph-pause'),
    now: document.getElementById('now'),
    total: document.getElementById('total'),
    toast: document.getElementById('toast'),
  };

  const clip = window.took.clip; // { url, mime, seconds, width, height }
  const isGif = clip && clip.mime === 'image/gif';

  let toastTimer = null;
  let scrubbing = false;

  if (!clip) return;

  if (isGif) {
    // A GIF plays itself; the scrubber just tracks a synthetic clock.
    els.still.src = clip.url;
    els.still.classList.remove('hidden');
    els.play.classList.add('hidden');
    els.total.textContent = format(clip.seconds || 0);
    startGifClock();
  } else {
    els.player.src = clip.url;
    els.player.classList.remove('hidden');
    wireVideo();
  }

  wireActions();

  // -------------------------------------------------------------------------

  function wireVideo() {
    const v = els.player;

    v.addEventListener('loadedmetadata', () => {
      els.total.textContent = format(duration());
      v.play().catch(() => {});
    });
    v.addEventListener('timeupdate', () => {
      if (!scrubbing) paint(v.currentTime / duration());
    });
    v.addEventListener('play', () => syncGlyph(true));
    v.addEventListener('pause', () => syncGlyph(false));
    v.addEventListener('ended', () => syncGlyph(false));

    els.play.addEventListener('click', toggle);
    document.addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    const seek = (e) => {
      const rect = els.track.getBoundingClientRect();
      const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      v.currentTime = ratio * duration();
      paint(ratio);
    };

    els.track.addEventListener('mousedown', (e) => {
      scrubbing = true;
      seek(e);
      const move = (ev) => seek(ev);
      const up = () => {
        scrubbing = false;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function duration() {
    const d = els.player.duration;
    // MediaRecorder output often reports Infinity until fully buffered.
    return Number.isFinite(d) && d > 0 ? d : clip.seconds || 0;
  }

  function toggle() {
    els.player.paused ? els.player.play() : els.player.pause();
  }

  function syncGlyph(playing) {
    els.glyphPlay.classList.toggle('hidden', playing);
    els.glyphPause.classList.toggle('hidden', !playing);
  }

  function startGifClock() {
    const span = (clip.seconds || 1) * 1000;
    const begin = performance.now();
    setInterval(() => {
      const t = ((performance.now() - begin) % span) / span;
      paint(t);
    }, 100);
  }

  function paint(ratio) {
    const pct = clamp(ratio, 0, 1) * 100;
    els.fill.style.width = `${pct}%`;
    els.head.style.left = `${pct}%`;
    els.now.textContent = format((clamp(ratio, 0, 1) * (duration() || clip.seconds || 0)) | 0);
  }

  function wireActions() {
    document.getElementById('btn-save').addEventListener('click', async () => {
      const saved = await window.took.save();
      if (saved) toast('已保存');
    });

    document.getElementById('btn-copy').addEventListener('click', async () => {
      const ok = await window.took.copy();
      toast(ok ? '已复制到剪贴板' : '复制失败');
    });
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 1600);
  }

  function format(total) {
    const pad = (n) => String(n).padStart(2, '0');
    const s = Math.max(0, Math.floor(total));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
})();

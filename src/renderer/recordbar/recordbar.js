'use strict';

(() => {
  const elapsed = document.getElementById('elapsed');
  const limit = document.getElementById('limit');
  const glyphPause = document.getElementById('glyph-pause');
  const glyphPlay = document.getElementById('glyph-play');

  let paused = false;

  document.getElementById('btn-pause').addEventListener('click', () => {
    paused ? window.took.resume() : window.took.pause();
  });

  document.getElementById('btn-stop').addEventListener('click', () => window.took.stop());
  document.getElementById('btn-cancel').addEventListener('click', () => window.took.cancel());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.took.cancel();
    else if (e.key === 'Enter') window.took.stop();
    else if (e.key === ' ') {
      e.preventDefault();
      paused ? window.took.resume() : window.took.pause();
    }
  });

  window.took.onStatus((s) => {
    paused = s.state === 'paused';

    elapsed.textContent = format(s.seconds);
    if (s.maxSeconds) limit.textContent = format(s.maxSeconds);

    glyphPause.classList.toggle('hidden', paused);
    glyphPlay.classList.toggle('hidden', !paused);
    document.body.classList.toggle('paused', paused);
  });

  function format(total) {
    const pad = (n) => String(n).padStart(2, '0');
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${pad(h)}:${pad(m)}:${pad(total % 60)}`;
  }
})();

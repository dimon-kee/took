'use strict';

(() => {
  const img = document.getElementById('shot');
  if (window.took.dataURL) img.src = window.took.dataURL;

  let opacity = 1;

  const copy = () => window.took.copy(window.took.dataURL);
  const save = () => window.took.save(window.took.dataURL);
  const close = () => window.took.close();

  document.getElementById('act-copy').addEventListener('click', copy);
  // Saved straight into the folder, the second click of a double click would
  // be a second copy. (A double click anywhere else closes the pin.)
  document.getElementById('act-save').addEventListener('click', (e) => {
    if (e.detail < 2) save();
  });
  document.getElementById('act-close').addEventListener('click', close);

  document.addEventListener('dblclick', close);

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') close();
    else if (mod && (e.key === 'c' || e.key === 'C')) copy();
    // Saving straight into the folder has no dialog to stop a held-down key:
    // every repeat would be another copy of the pin.
    else if (mod && (e.key === 's' || e.key === 'S') && !e.repeat) save();
  });

  // Wheel fades the pin so you can trace over what is underneath it.
  document.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      opacity = Math.max(0.25, Math.min(1, opacity + (e.deltaY < 0 ? 0.06 : -0.06)));
      window.took.setOpacity(opacity);
    },
    { passive: false }
  );
})();

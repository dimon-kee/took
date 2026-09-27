'use strict';

const cursorTracker = require('./cursor');

/**
 * Main's half of a scrolling screenshot. While one runs, the overlay stays on
 * screen, but:
 *   - it is left out of screen captures, so its dimming, frame and panel never
 *     turn up in the frames being stitched;
 *   - it lets the mouse through wherever the pointer is inside the selection,
 *     so the wheel scrolls the app underneath — and only there, so the panel
 *     stays clickable and a stray click outside cannot raise another window
 *     over what is being captured;
 *   - it streams the pointer position to the renderer, because the pointer is
 *     drawn into every captured frame and the stitcher has to work around it.
 *
 * Electron can forward mouse moves to a window that ignores the mouse, but
 * polling the cursor — as the recorder already does — keeps working whether or
 * not the window is taking input, and is the thing deciding that in the first
 * place.
 */

let session = null;

/**
 * @param win     the overlay window
 * @param rects   { selection, panel } — display-local CSS px, {x, y, width, height}
 */
function start(win, { selection, panel }) {
  stop();
  win.setContentProtection(true);

  const bounds = win.getBounds();
  const state = { win, selection, panel, through: false, untrack: null };

  state.untrack = cursorTracker.track((p) => {
    if (win.isDestroyed()) {
      stop();
      return;
    }

    const local = { x: p.x - bounds.x, y: p.y - bounds.y };
    const through = inside(local, state.selection) && !inside(local, state.panel);
    if (through !== state.through) {
      state.through = through;
      win.setIgnoreMouseEvents(through);
    }

    win.webContents.send('overlay:pointer', local);
  });

  session = state;
}

/** The panel moved or changed size. */
function setPanel(rect) {
  if (session) session.panel = rect;
}

function stop() {
  if (!session) return;
  const { win, untrack } = session;
  session = null;

  untrack();
  if (!win.isDestroyed()) {
    win.setIgnoreMouseEvents(false);
    win.setContentProtection(false);
  }
}

function inside(p, r) {
  return Boolean(r) && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

module.exports = { start, setPanel, stop };

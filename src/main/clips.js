'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Recordings wait in a folder of their own under the temp directory while the
 * editor shows them; the user may save a copy, put the file on the clipboard,
 * or do neither. Only the newest is kept — the clipboard may still point at
 * it — and the folder goes when the app quits, and again at the next start in
 * case it did not quit cleanly.
 *
 * Before 0.1.2 recordings went loose into the temp directory and were never
 * removed; the sweep at start clears those too.
 */

const LOOSE = /^took_\d{8}_\d{6}\.(mp4|gif|webm)$/;

function dir() {
  return path.join(app.getPath('temp'), 'Took');
}

/** Where a new recording goes. The previous one is removed first. */
function next(name) {
  clear();
  fs.mkdirSync(dir(), { recursive: true });
  return path.join(dir(), name);
}

function clear() {
  // A clip the editor is still playing is locked on Windows; it goes next time.
  try {
    fs.rmSync(dir(), { recursive: true, force: true });
  } catch {}
}

/** Everything earlier runs left behind, in the folder and loose in temp. */
function sweep() {
  clear();
  try {
    const temp = app.getPath('temp');
    for (const name of fs.readdirSync(temp)) {
      if (LOOSE.test(name)) fs.rmSync(path.join(temp, name), { force: true });
    }
  } catch {}
}

module.exports = { next, clear, sweep, dir };

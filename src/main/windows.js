'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const win32 = require('./win32');
const settings = require('./settings');
const { createTranslator, LANG_SWITCH } = require('../shared/i18n');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload');

/**
 * Every window gets the current language on its command line; its preload turns
 * that into a translator. Read per call so a change takes effect on the next
 * window without any invalidation dance.
 */
function langArgs(extra = []) {
  return [`${LANG_SWITCH}${settings.get().language}`, ...extra];
}

function translate() {
  return createTranslator(settings.get().language);
}

/**
 * One borderless window pinned over each display, rendering the frozen
 * screenshot itself.
 *
 * It is transparent rather than opaque-black on purpose. Windows paints a
 * window's background brush for a frame or two before the renderer's surface
 * reaches the screen, and on a fullscreen window a single black frame is very
 * visible — measurably so: `task check:flash` caught luminance dropping to 2
 * out of 31 for exactly one frame. With no brush to paint, that frame shows the
 * real desktop instead, which is indistinguishable from the screenshot about to
 * replace it.
 */
function createOverlayWindow(shot) {
  const { bounds } = shot;

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    show: false,
    // A tool window (WS_EX_TOOLWINDOW). Chromium — every browser and Electron
    // app — stops painting a window it believes is fully covered, and a
    // screen-sized topmost window counts unless it is a tool window. During a
    // scrolling screenshot that would freeze the very app being scrolled.
    type: 'toolbar',
    webPreferences: {
      preload: path.join(PRELOAD, 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: langArgs(),
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Must happen before the first show(): a fullscreen window fading and
  // scaling into place reads as the app launching, not as the screen freezing.
  win32.disableWindowAnimations(win);

  win.loadFile(path.join(RENDERER, 'overlay', 'index.html'));

  return win;
}

function createPinWindow({ dataURL, width, height, x, y }) {
  const win = new BrowserWindow({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    frame: false,
    transparent: false,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'pin.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: langArgs([`--pin-data=${encodeURIComponent(dataURL)}`]),
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(RENDERER, 'pin', 'index.html'));
  win.once('ready-to-show', () => win.show());

  return win;
}

/** Off-screen worker that owns the MediaRecorder for screen recording. */
function createRecorderWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'recorder.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: langArgs(),
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(RENDERER, 'recorder', 'index.html'));
  return win;
}

const BAR_WIDTH = 330;
const BAR_HEIGHT = 48;

/** Small floating pause/stop bar shown while a recording runs. */
function createRecordBarWindow(region) {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(region.x + region.width / 2),
    y: Math.round(region.y + region.height / 2),
  });

  let x = Math.round(region.x + region.width - BAR_WIDTH);
  let y = Math.round(region.y + region.height + 10);

  const wa = display.workArea;
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - BAR_WIDTH - 8));
  if (y + BAR_HEIGHT > wa.y + wa.height - 8) y = Math.round(region.y - BAR_HEIGHT - 10);
  y = Math.max(wa.y + 8, y);

  const win = new BrowserWindow({
    x,
    y,
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'recordbar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: langArgs(),
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(RENDERER, 'recordbar', 'index.html'));
  win.once('ready-to-show', () => win.show());

  return win;
}

/** Post-recording preview: play it back, then save or copy. */
function createEditorWindow(clip) {
  const display = screen.getPrimaryDisplay();
  const maxW = Math.round(display.workArea.width * 0.8);
  const maxH = Math.round(display.workArea.height * 0.8);

  const scale = Math.min(1, maxW / (clip.width || maxW), (maxH - 110) / (clip.height || maxH));
  const width = Math.max(520, Math.round((clip.width || 960) * scale));
  const height = Math.max(360, Math.round((clip.height || 540) * scale)) + 110;

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 460,
    minHeight: 320,
    title: translate()('app.editor'),
    backgroundColor: '#16161a',
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'editor.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: langArgs([`--clip=${encodeURIComponent(JSON.stringify(clip))}`]),
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(RENDERER, 'editor', 'index.html'));
  win.once('ready-to-show', () => win.show());

  return win;
}

/**
 * Floating webcam bubble. It sits above the overlay and stays put while
 * recording, which is what lets the screen grab capture it without any
 * compositing on our side.
 */
function createWebcamWindow({ deviceId, bounds }) {
  const win = new BrowserWindow({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 120,
    minHeight: 90,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'webcam.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: langArgs([`--device=${encodeURIComponent(deviceId || '')}`]),
    },
  });

  // Above the overlay, which sits at screen-saver level too.
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.loadFile(path.join(RENDERER, 'webcam', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());

  return win;
}

function createSettingsWindow() {
  const win = new BrowserWindow({
    width: 580,
    height: 680,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: translate()('app.settings'),
    backgroundColor: '#1c1c20',
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: langArgs(),
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(RENDERER, 'settings', 'index.html'));
  win.once('ready-to-show', () => win.show());

  return win;
}

/**
 * The overlay on the display under `point` (screen DIP) — or the nearest one,
 * should the point fall in a gap between displays of different scaling.
 * Each window carries its display's bounds as __tookBounds.
 */
function overlayAt(wins, point) {
  let nearest = null;
  let best = Infinity;
  wins.forEach((win) => {
    if (win.isDestroyed()) return;
    const b = win.__tookBounds;
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width - 1));
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height - 1));
    if (dx * dx + dy * dy < best) {
      best = dx * dx + dy * dy;
      nearest = win;
    }
  });
  return nearest;
}

module.exports = {
  overlayAt,
  createOverlayWindow,
  createEditorWindow,
  createWebcamWindow,
  createSettingsWindow,
  createPinWindow,
  createRecorderWindow,
  createRecordBarWindow,
};

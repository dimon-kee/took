'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload');

/**
 * One opaque, borderless window pinned over each display. It renders the frozen
 * screenshot itself, so there is no live transparency to fight with on Windows.
 */
function createOverlayWindow(shot) {
  const { bounds } = shot;

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
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
    webPreferences: {
      preload: path.join(PRELOAD, 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
      additionalArguments: [`--pin-data=${encodeURIComponent(dataURL)}`],
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
    title: '编辑录屏',
    backgroundColor: '#16161a',
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'editor.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--clip=${encodeURIComponent(JSON.stringify(clip))}`],
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
      additionalArguments: [`--device=${encodeURIComponent(deviceId || '')}`],
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
    width: 560,
    height: 470,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '设置',
    backgroundColor: '#1c1c20',
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(RENDERER, 'settings', 'index.html'));
  win.once('ready-to-show', () => win.show());

  return win;
}

module.exports = {
  createOverlayWindow,
  createEditorWindow,
  createWebcamWindow,
  createSettingsWindow,
  createPinWindow,
  createRecorderWindow,
  createRecordBarWindow,
};

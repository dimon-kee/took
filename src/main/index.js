'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  nativeImage,
  dialog,
  desktopCapturer,
  screen,
  shell,
} = require('electron');

const { pathToFileURL } = require('url');

const { describeDisplays, captureDisplayImage } = require('./capture');
const screens = require('./screens');
const cursorTracker = require('./cursor');
const longCapture = require('./longcapture');
const autoLaunch = require('./autolaunch');
const updater = require('./updater');
const clips = require('./clips');
const mp4 = require('./mp4');
const settings = require('./settings');
const { pngFromDataURL, copyImage, copyFile, copyText } = require('./clipboard');
const { createTranslator, LANGUAGES } = require('../shared/i18n');

/**
 * Translate with whatever language is configured right now. Resolved per call
 * rather than cached, so switching language in settings takes effect as soon as
 * the tray menu is rebuilt.
 */
function t(key, vars) {
  return createTranslator(settings.get().language)(key, vars);
}
const {
  createOverlayWindow,
  createPinWindow,
  createRecorderWindow,
  createRecordBarWindow,
  createEditorWindow,
  createWebcamWindow,
  createSettingsWindow,
} = require('./windows');

// Unpackaged, the app name would default to "Electron" — which also becomes the
// HKCU Run value name. Pinning it keeps the dev run and the packaged build on
// one registry entry instead of leaving two start-up items behind.
app.setName('Took');

// Windows heads the tray's notices with the name of the Start menu shortcut
// carrying this ID. The installer gives its shortcut build.appId from
// package.json; left at Electron's default, the heading reads
// "electron.app.Took".
if (process.platform === 'win32') app.setAppUserModelId('ai.xtractify.took');

const SHORTCUT_ACTIONS = {
  capture: () => startCapture(),
  record: () => startRecordSelection(),
};

// Overlay windows are transient and impossible to attach DevTools to mid-drag,
// so surface their warnings and errors on the terminal instead.
app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  contents.on('render-process-gone', (_evt, details) => {
    console.error('[took] 渲染进程退出:', details.reason);
  });
});

/** @type {BrowserWindow[]} */ let overlayWins = [];
/** @type {BrowserWindow|null} */ let recorderWin = null;
/** @type {BrowserWindow|null} */ let recordBarWin = null;
/** @type {BrowserWindow|null} */ let editorWin = null;
/** @type {BrowserWindow|null} */ let webcamWin = null;
/** @type {BrowserWindow|null} */ let settingsWin = null;
/** @type {Tray|null} */ let tray = null;
/** @type {Set<BrowserWindow>} */ const pinWins = new Set();

let capturing = false;
let webcamDeviceId = null;
let recordSettings = null;
let stopCursor = null;
/** Last finished recording, parked in temp for the preview window. */
let lastClip = null;
/** What clicking the tray's balloon does; set by whichever balloon went up last. */
let balloonClick = null;

// One Took at a time. Launching it again — from the Start menu, or the
// installer's "Run Took" — only says it is already running.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on('second-instance', () => sayRunning());
}

// Tray-resident app: closing every window must not quit it.
app.on('window-all-closed', () => {});

// Nothing is shown at startup: the app lives in the tray until a hotkey fires.
app.whenReady().then(() => {
  // A copy that lost the lock still gets here before it quits. Starting up
  // would give it a tray icon of its own, and its sweep would delete the
  // recording the running copy is holding.
  if (!primary) return;
  clips.sweep();
  autoLaunch.refresh();
  setupTray();
  applyShortcuts();
  // Enumerating capture sources takes about a second; get it out of the way
  // now so the first hotkey press does not have to wait for it.
  screens.warmUp();
  updater.init({
    autoUpdate: settings.get().autoUpdate,
    onChange: (state) => sendToSettings('update:state', state),
    onReady: (version) => offerRestart(version),
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clips.clear();
});

// ---------------------------------------------------------------------------
// tray + shortcuts
// ---------------------------------------------------------------------------

function trayIcon() {
  const file = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  if (fs.existsSync(file)) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function setupTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(t('app.tooltip'));
  refreshTrayMenu();
  tray.on('click', () => startCapture());
  tray.on('balloon-click', () => balloonClick && balloonClick());
}

function balloon(title, content, onClick = null) {
  if (!tray || tray.isDestroyed()) return;
  balloonClick = onClick;
  tray.displayBalloon({ iconType: 'info', title, content });
}

/** An update has downloaded: offer the restart, unless settings already shows it. */
function offerRestart(version) {
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isFocused()) return;
  balloon(t('update.readyTitle', { version }), t('update.readyBody'), () => updater.install(true));
}

/**
 * Took was launched again while it runs: say so, rather than open a capture
 * nobody asked for. A dev run says it is one — the installed build shares its
 * lock, so launching that while `task dev` runs lands here too.
 */
function sayRunning() {
  balloon(
    t('tray.runningTitle', { app: app.isPackaged ? 'Took' : 'Took (dev)' }),
    t('tray.runningBody', { key: prettyKey(shortcutFor('capture')) })
  );
}

/** Quit — running a downloaded update on the way out, if one is waiting. */
function quit() {
  // app.exit skips will-quit, so the parked recording is cleared here.
  clips.clear();
  if (!updater.install(false)) app.exit(0);
}

/**
 * Actions only. Anything that is a preference lives in the settings window, so
 * the tray does not grow a second copy of it to keep in sync.
 */
function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${t('tray.capture')}  ${prettyKey(shortcutFor('capture'))}`, click: () => startCapture() },
      { label: `${t('tray.record')}  ${prettyKey(shortcutFor('record'))}`, click: () => startRecordSelection() },
      { type: 'separator' },
      { label: t('tray.settings'), click: () => openSettings() },
      { label: t('tray.quit'), click: () => quit() },
    ])
  );
}

function prettyKey(accel) {
  return String(accel)
    .replace('CommandOrControl', 'Ctrl')
    .replace('Super', 'Win')
    .replace(/\+/g, ' + ');
}

function shortcutFor(action) {
  return settings.get().shortcuts[action];
}

/**
 * (Re)register the global hotkeys.
 * @returns the actions whose accelerator was refused — almost always because
 *          another program already owns that combination.
 */
function applyShortcuts() {
  globalShortcut.unregisterAll();

  const configured = settings.get().shortcuts;
  const conflicts = [];

  Object.entries(SHORTCUT_ACTIONS).forEach(([action, handler]) => {
    const accelerator = configured[action];
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, handler);
    } catch (err) {
      // A malformed accelerator throws instead of returning false.
      console.warn(`[took] 快捷键 ${accelerator} 无效:`, err.message);
    }

    if (!ok) {
      conflicts.push(action);
      console.warn(`[took] 无法注册快捷键 ${accelerator}，可能被其他程序占用`);
    }
  });

  return conflicts;
}

// ---------------------------------------------------------------------------
// overlay lifecycle
// ---------------------------------------------------------------------------

async function startCapture() {
  await openOverlays('capture');
}

async function startRecordSelection() {
  if (recorderWin && !recorderWin.isDestroyed()) return; // already recording
  await openOverlays('record');
}

async function openOverlays(mode) {
  if (capturing || overlayWins.length) return;
  capturing = true;

  try {
    const shots = await describeDisplays();
    if (!shots.length) throw new Error(t('err.noScreens'));

    const cursor = screen.getCursorScreenPoint();

    // The overlay under the cursor owns the keyboard; the rest show passively.
    let primaryIndex = shots.findIndex((s) => pointInBounds(cursor, s.bounds));
    if (primaryIndex < 0) primaryIndex = 0;

    overlayWins = shots.map((shot, index) => {
      const win = createOverlayWindow(shot);
      const isPrimary = index === primaryIndex;

      win.once('closed', () => {
        overlayWins = overlayWins.filter((w) => w !== win);
      });

      win.__tookPrimary = isPrimary;
      win.__tookRevealed = false;

      win.webContents.once('did-finish-load', () => {
        win.webContents.send('overlay:init', { mode, shot, cursor, isPrimary });
        // Safety net: if the renderer never reports back, show it anyway
        // rather than leaving an invisible fullscreen window swallowing input.
        setTimeout(() => revealOverlay(win), 1500);
      });
      return win;
    });
  } catch (err) {
    console.error('[took] 截屏失败:', err);
    dialog.showErrorBox(t('err.captureTitle'), String(err && err.message ? err.message : err));
    closeOverlays();
  } finally {
    capturing = false;
  }
}

function closeOverlays() {
  longCapture.stop();
  const wins = overlayWins.slice();
  overlayWins = [];
  wins.forEach((w) => {
    if (!w.isDestroyed()) w.destroy();
  });
}

function pointInBounds(p, b) {
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

// ---------------------------------------------------------------------------
// IPC — overlay
// ---------------------------------------------------------------------------

/** The overlay's own frame grab failed; hand it a PNG instead. */
ipcMain.handle('overlay:fallback-shot', (event, displayId) => captureDisplayImage(displayId));

/** The renderer has the frozen screenshot on screen — safe to reveal now. */
ipcMain.on('overlay:ready', (event) => {
  revealOverlay(BrowserWindow.fromWebContents(event.sender));
});

function revealOverlay(win) {
  if (!win || win.isDestroyed() || win.__tookRevealed) return;
  win.__tookRevealed = true;

  if (win.__tookPrimary) {
    win.show();
    win.focus();
  } else {
    win.showInactive();
  }
}

/** One overlay took the drag; the rest should stop drawing their magnifiers. */
ipcMain.on('overlay:claim', (event) => {
  overlayWins.forEach((win) => {
    if (!win.isDestroyed() && win.webContents.id !== event.sender.id) {
      win.webContents.send('overlay:yield');
    }
  });
});

ipcMain.on('overlay:cancel', () => {
  closeWebcam(); // the camera preview belongs to this session only
  closeOverlays();
});

ipcMain.handle('overlay:copy', async (event, dataURL) => {
  try {
    await copyImage(pngFromDataURL(dataURL));
  } catch (err) {
    // Leave the overlay up: closing it now would throw the screenshot away.
    console.error('[took] 复制截图失败:', err);
    return false;
  }
  closeOverlays();
  return true;
});

ipcMain.handle('overlay:save', async (event, dataURL) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: t('dialog.saveShot'),
    defaultPath: path.join(settings.saveDir(), `${t('file.screenshot', { stamp: stamp() })}.png`),
    filters: [{ name: t('dialog.png'), extensions: ['png'] }],
  });

  if (canceled || !filePath) return false;

  fs.writeFileSync(filePath, nativeImage.createFromDataURL(dataURL).toPNG());
  closeOverlays();
  return true;
});

ipcMain.handle('overlay:pin', (event, { dataURL, rect }) => {
  const win = createPinWindow({
    dataURL,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
  pinWins.add(win);
  win.once('closed', () => pinWins.delete(win));
  closeOverlays();
  return true;
});

ipcMain.handle('overlay:copy-text', async (event, text) => {
  await copyText(text);
  return true;
});

// --- scrolling screenshot ----------------------------------------------------

ipcMain.handle('overlay:long-start', (event, rects) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;

  // Only one display scrolls; the others would sit there frozen, eating clicks.
  overlayWins.filter((w) => w !== win && !w.isDestroyed()).forEach((w) => w.destroy());

  longCapture.start(win, rects);
  return true;
});

ipcMain.on('overlay:long-panel', (event, rect) => longCapture.setPanel(rect));

ipcMain.on('overlay:long-stop', () => longCapture.stop());

// ---------------------------------------------------------------------------
// IPC — pin windows
// ---------------------------------------------------------------------------

ipcMain.on('pin:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.destroy();
});

ipcMain.on('pin:copy', (event, dataURL) => {
  copyImage(pngFromDataURL(dataURL)).catch((err) => console.error('[took] 复制贴图失败:', err));
});

ipcMain.on('pin:set-opacity', (event, value) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.setOpacity(value);
});

ipcMain.handle('pin:save', async (event, dataURL) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: t('dialog.saveShot'),
    defaultPath: path.join(settings.saveDir(), `${t('file.screenshot', { stamp: stamp() })}.png`),
    filters: [{ name: t('dialog.png'), extensions: ['png'] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, nativeImage.createFromDataURL(dataURL).toPNG());
  return true;
});

// ---------------------------------------------------------------------------
// IPC — recording
// ---------------------------------------------------------------------------

const MAX_RECORD_SECONDS = 3600;

/** Camera toggled in the setup card — show or hide the floating bubble. */
ipcMain.handle('overlay:webcam', (event, { on, deviceId, bounds }) => {
  if (!on) {
    closeWebcam();
    return false;
  }

  if (webcamWin && !webcamWin.isDestroyed()) {
    if (webcamDeviceId === deviceId) return true;
    closeWebcam(); // device changed; rebuild against the new one
  }

  webcamDeviceId = deviceId || null;
  webcamWin = createWebcamWindow({ deviceId, bounds });
  webcamWin.once('closed', () => {
    webcamWin = null;
    webcamDeviceId = null;
  });
  return true;
});

ipcMain.on('webcam:close', () => closeWebcam());

ipcMain.on('webcam:failed', (event, message) => {
  closeWebcam();
  dialog.showErrorBox(t('err.cameraTitle'), String(message || t('err.unknown')));
});

/** Overlay finished picking a region in record mode. */
ipcMain.handle('overlay:record', async (event, { rect, displayId, scaleFactor, settings }) => {
  closeOverlays();

  const displays = screen.getAllDisplays();
  const display = displays.find((d) => d.id === displayId);
  const index = displays.findIndex((d) => d.id === displayId);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });
  const source =
    sources.find((s) => String(s.display_id) === String(displayId)) || sources[index] || sources[0];

  if (!source || !display) {
    dialog.showErrorBox(t('err.recordTitle'), t('err.noSource'));
    closeWebcam();
    return false;
  }

  if (!settings.camera) closeWebcam();

  recordSettings = settings;

  recorderWin = createRecorderWindow();
  recorderWin.webContents.once('did-finish-load', () => {
    recorderWin.webContents.send('recorder:start', {
      sourceId: source.id,
      settings,
      // Region is display-local CSS px; the recorder converts with scaleFactor.
      region: rect,
      scaleFactor,
      displayBounds: display.bounds,
      displayPixelSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    });
  });

  recordBarWin = createRecordBarWindow({
    x: display.bounds.x + rect.x,
    y: display.bounds.y + rect.y,
    width: rect.width,
    height: rect.height,
  });

  if (settings.cursor) startCursorTracking();
  return true;
});

function startCursorTracking() {
  stopCursorTracking();
  stopCursor = cursorTracker.track((sample) => {
    if (recorderWin && !recorderWin.isDestroyed()) {
      recorderWin.webContents.send('recorder:cursor', sample);
    }
  });
}

function stopCursorTracking() {
  if (stopCursor) stopCursor();
  stopCursor = null;
}

ipcMain.on('recordbar:pause', () => sendToRecorder('recorder:pause'));
ipcMain.on('recordbar:resume', () => sendToRecorder('recorder:resume'));
ipcMain.on('recordbar:stop', () => sendToRecorder('recorder:stop'));

ipcMain.on('recordbar:cancel', () => {
  sendToRecorder('recorder:abort');
  teardownRecording();
});

ipcMain.on('recorder:status', (event, status) => {
  if (recordBarWin && !recordBarWin.isDestroyed()) {
    recordBarWin.webContents.send('recordbar:status', {
      ...status,
      maxSeconds: MAX_RECORD_SECONDS,
    });
  }
  // Hard stop at the advertised limit rather than filling the disk.
  if (status.seconds >= MAX_RECORD_SECONDS) sendToRecorder('recorder:stop');
});

ipcMain.handle('recorder:done', async (event, { buffer, mime, meta }) => {
  const ext = extensionFor(mime);
  teardownRecording();

  // Park it in temp so the preview window can play it back before the user
  // decides where — if anywhere — it should live.
  let file;
  try {
    file = clips.next(`took_${stamp()}.${ext}`);
    saveRecording(file, Buffer.from(buffer), ext);
  } catch (err) {
    dialog.showErrorBox(t('err.saveRecordingTitle'), String(err.message || err));
    return false;
  }

  lastClip = {
    file,
    mime,
    ext,
    seconds: (meta && meta.seconds) || 0,
    width: (meta && meta.width) || 0,
    height: (meta && meta.height) || 0,
  };

  editorWin = createEditorWindow({
    url: pathToFileURL(file).href,
    mime,
    seconds: lastClip.seconds,
    width: lastClip.width,
    height: lastClip.height,
  });
  editorWin.once('closed', () => {
    editorWin = null;
  });

  return true;
});

ipcMain.on('recorder:failed', (event, message) => {
  teardownRecording();
  dialog.showErrorBox(t('err.recordTitle'), String(message || t('err.unknown')));
});

ipcMain.handle('editor:save', async (event) => {
  if (!lastClip) return false;
  const win = BrowserWindow.fromWebContents(event.sender);

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: t('dialog.saveRecording'),
    defaultPath: path.join(settings.saveDir(), `${t('file.recording', { stamp: stamp() })}.${lastClip.ext}`),
    filters: [{ name: describeFormat(lastClip.ext), extensions: [lastClip.ext] }],
  });

  if (canceled || !filePath) return false;

  fs.copyFileSync(lastClip.file, filePath);
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('editor:copy', async () => {
  if (!lastClip) return false;
  try {
    // As a file reference, so the clip pastes as the file itself. There is no
    // picture version to put beside a GIF: nativeImage cannot decode one.
    await copyFile(lastClip.file);
    return true;
  } catch (err) {
    console.error('[took] 复制录屏失败:', err);
    return false;
  }
});

/**
 * MediaRecorder's MP4 arrives in fragments with no overall length, which
 * Windows' players cannot seek in, so it is laid out as a regular MP4 first.
 * Should that fail, the recording is kept as it was recorded.
 */
function saveRecording(file, data, ext) {
  if (ext === 'mp4') {
    try {
      mp4.writeRegular(file, data);
      return;
    } catch (err) {
      console.warn('[took] 录屏整理成普通 MP4 失败，按原样保存:', err.message);
    }
  }
  fs.writeFileSync(file, data);
}

function extensionFor(mime) {
  if (!mime) return 'webm';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('mp4')) return 'mp4';
  return 'webm';
}

function describeFormat(ext) {
  return { mp4: t('dialog.mp4'), gif: t('dialog.gif'), webm: t('dialog.webm') }[ext] || ext.toUpperCase();
}

function sendToRecorder(channel, payload) {
  if (recorderWin && !recorderWin.isDestroyed()) {
    recorderWin.webContents.send(channel, payload);
  }
}

function closeWebcam() {
  if (webcamWin && !webcamWin.isDestroyed()) webcamWin.destroy();
  webcamWin = null;
  webcamDeviceId = null;
}

function teardownRecording() {
  stopCursorTracking();
  closeWebcam();

  if (recordBarWin && !recordBarWin.isDestroyed()) recordBarWin.destroy();
  recordBarWin = null;

  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.destroy();
  recorderWin = null;

  recordSettings = null;
}

// ---------------------------------------------------------------------------
// IPC — settings
// ---------------------------------------------------------------------------

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  settingsWin = createSettingsWindow();
  settingsWin.once('closed', () => {
    settingsWin = null;
  });
}

function sendToSettings(channel, payload) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
}

ipcMain.handle('settings:load', () => ({
  settings: settings.get(),
  // Lives in the registry rather than settings.json, so report it separately.
  autoLaunch: autoLaunch.enabled(),
  version: app.getVersion(),
  update: updater.get(),
  defaults: {
    ...settings.DEFAULTS,
    // What the placeholder path actually resolves to, so the field can show a
    // real directory instead of an empty box.
    saveDirLabel: settings.saveDir(),
    languages: LANGUAGES,
  },
}));

ipcMain.handle('settings:save', (event, next) => {
  const previous = settings.get();

  if (next.saveDir) {
    const check = settings.checkWritable(next.saveDir);
    if (!check.ok) return { ok: false, message: t('settings.dirNotWritable', { message: check.message }) };
  }

  settings.set(next);
  const conflicts = applyShortcuts();

  if (conflicts.length) {
    // Never leave the user with hotkeys that no longer fire.
    settings.set(previous);
    applyShortcuts();
    refreshTrayMenu();
    return { ok: false, conflicts };
  }

  // Only once everything else has been accepted, so a rejected save never
  // leaves the start-up entry changed on its own. The renderer sends this
  // field only when the user touched the checkbox.
  if (typeof next.autoLaunch === 'boolean') autoLaunch.set(next.autoLaunch);
  if (previous.autoUpdate !== settings.get().autoUpdate) updater.setAuto(settings.get().autoUpdate);

  refreshTrayMenu();

  // A window's language arrives as a command-line argument at creation, which a
  // reload would not change — so the settings window has to be rebuilt, not
  // refreshed. Every other window is transient and picks it up on its own.
  const languageChanged = previous.language !== settings.get().language;
  if (languageChanged) {
    setTimeout(() => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.destroy();
      settingsWin = null;
      openSettings();
    }, 350);
  }

  return { ok: true, languageChanged };
});

ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:install', () => updater.install(true));

ipcMain.handle('settings:pick-dir', async (event, current) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: t('dialog.pickFolder'),
    defaultPath: current || settings.saveDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

ipcMain.on('settings:open-dir', () => shell.openPath(settings.saveDir()));

ipcMain.on('settings:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
});

// ---------------------------------------------------------------------------

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

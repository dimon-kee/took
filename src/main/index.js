'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  nativeImage,
  dialog,
  screen,
  shell,
} = require('electron');

const { pathToFileURL } = require('url');

const { describeDisplays, grabDisplay, captureDisplayImage } = require('./capture');
const screens = require('./screens');
const cursorTracker = require('./cursor');
const longCapture = require('./longcapture');
const autoLaunch = require('./autolaunch');
const updater = require('./updater');
const clips = require('./clips');
const mp4 = require('./mp4');
const settings = require('./settings');
const { createSaver } = require('./saving');
const { createOcr } = require('./ocr');
const { safeHref } = require('../shared/links');
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

const saver = createSaver({
  settings,
  showSaveDialog: (win, options) => dialog.showSaveDialog(win, options),
  t,
});
const {
  createOverlayWindow,
  overlayAt,
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
  ocr: () => startTextCapture(),
};

// Text recognition, in a process of its own that comes and goes with use.
// The models sit unpacked beside app.asar: onnxruntime opens them itself, and
// cannot see inside the archive.
const ocr = createOcr({
  modelsDir: path.join(app.getAppPath(), 'assets', 'ocr').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked'),
  idleMs: 60 * 1000,
  timeoutMs: 30 * 1000,
  // Recognition is quick enough on four; more would only make the rest of the
  // machine stutter while it runs.
  threads: Math.max(1, Math.min(4, os.cpus().length)),
});

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
/**
 * The mode the open overlays are in. It is one choice for every display: an
 * overlay still loading when the user switches is told the new one at init.
 */
let overlayMode = 'capture';
const OVERLAY_MODES = new Set(['capture', 'long', 'record', 'text']);
let webcamDeviceId = null;
let recordSettings = null;
let stopCursor = null;
/** Last finished recording, parked in temp for the preview window. */
let lastClip = null;
/** What clicking the tray's balloon does; set by whichever balloon went up last. */
let balloonClick = null;

// Took starts in the tray. Only the first start after installing opens the
// settings, so a new user sees something; later starts — at boot, from the
// Start menu — stay quiet until Took is launched again while it runs.
//
// Started by the Start with Windows entry, or by the installer after an
// update, it never opens a window, not even as a second copy.
const QUIET = [autoLaunch.FLAG, '--updated'];
const quiet = (argv) => argv.some((arg) => QUIET.includes(arg));

// One Took at a time. Launching it again opens the running copy's settings.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!quiet(argv)) openSettings();
  });
}

// Tray-resident app: closing every window must not quit it.
app.on('window-all-closed', () => {});

// The app lives in the tray; captures come from the hotkeys.
app.whenReady().then(() => {
  // A copy that lost the lock still gets here before it quits. Starting up
  // would give it a tray icon of its own, and its sweep would delete the
  // recording the running copy is holding.
  if (!primary) return;
  clips.sweep();
  autoLaunch.refresh();
  setupTray();
  applyShortcuts();
  // A loaded overlay for every display, so the hotkey only has to hand it a
  // screenshot.
  prepareOverlays();
  ['display-added', 'display-removed', 'display-metrics-changed'].forEach((event) =>
    screen.on(event, () => prepareSoon())
  );
  // Recordings and scrolling screenshots need the capture sources, and
  // enumerating them holds up main for a second or more — so now, while
  // nobody is waiting.
  screens.warmUp();
  updater.init({
    autoUpdate: settings.get().autoUpdate,
    onChange: (state) => sendToSettings('update:state', state),
    onReady: (version) => offerRestart(version),
  });
  if (settings.firstLaunch() && !quiet(process.argv)) openSettings();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clips.clear();
  ocr.stop();
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
  // Captures have their hotkeys and the menu; a click opens the settings.
  tray.on('click', () => openSettings());
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
      { label: `${t('tray.ocr')}  ${prettyKey(shortcutFor('ocr'))}`, click: () => startTextCapture() },
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

function startCapture() {
  openOverlays('capture');
}

function startRecordSelection() {
  if (recorderWin && !recorderWin.isDestroyed()) return; // already recording
  openOverlays('record');
}

function startTextCapture() {
  openOverlays('text');
}

/**
 * Everything from the hotkey to handing each overlay its frame runs in one go,
 * with no await. A global hotkey's callback runs outside Node's callback scope,
 * so code after an await there resumes only once something else wakes the
 * event loop — measured at half a second and more on battery, on every press.
 */
function openOverlays(mode) {
  if (capturing || overlayWins.length) return;
  capturing = true;
  overlayMode = mode;

  try {
    const shots = describeDisplays();
    if (!shots.length) throw new Error(t('err.noScreens'));

    // Freeze every display before an overlay can appear on any of them.
    shots.forEach((shot) => {
      shot.frame = grabDisplay(shot.displayId);
    });

    const cursor = screen.getCursorScreenPoint();

    // The overlay under the cursor owns the keyboard; the rest show passively.
    let primaryIndex = shots.findIndex((s) => pointInBounds(cursor, s.bounds));
    if (primaryIndex < 0) primaryIndex = 0;

    overlayWins = shots.map((shot, index) => {
      const win = takeOverlay(shot);
      const isPrimary = index === primaryIndex;

      win.once('closed', () => {
        overlayWins = overlayWins.filter((w) => w !== win);
      });

      win.__tookPrimary = isPrimary;
      win.__tookBounds = shot.bounds;
      win.__tookRevealed = false;

      const init = () => {
        win.webContents.send('overlay:init', { mode: overlayMode, shot, cursor, isPrimary });
        // Safety net: if the renderer never reports back, show it anyway
        // rather than leaving an invisible fullscreen window swallowing input.
        setTimeout(() => revealOverlay(win), 1500);
      };
      if (win.__tookLoaded) init();
      else win.webContents.once('did-finish-load', init);
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
  // Replace the spares this session used up — off the hotkey's path, once
  // whatever ended the session (a copy, a save, a recording) has started.
  if (wins.length) setTimeout(prepareOverlays, 500);
}

// ---------------------------------------------------------------------------
// spare overlays
// ---------------------------------------------------------------------------

/**
 * One hidden overlay per display, loaded and waiting for the next hotkey.
 *
 * Starting a window from scratch — a renderer process, the page, its scripts
 * — took ~200 ms of every screenshot. A spare serves a single screenshot and
 * is replaced afterwards, so no session inherits anything from the one before.
 * @type {Map<number, BrowserWindow>}
 */
const spareOverlays = new Map();
let quitting = false;
let prepareTimer = null;

app.on('before-quit', () => {
  quitting = true;
});

/** Make sure every display has a usable spare, dropping any that no longer fit. */
function prepareOverlays() {
  if (quitting) return;
  const displays = screen.getAllDisplays();

  for (const [id, win] of spareOverlays) {
    const display = displays.find((d) => d.id === id);
    if (!display || !fits(win, display)) dropSpare(id, win);
  }

  displays.forEach((display) => {
    if (spareOverlays.has(display.id)) return;

    const win = createOverlayWindow({ bounds: display.bounds });
    win.__tookBounds = { ...display.bounds };
    win.__tookScale = display.scaleFactor;
    win.webContents.once('did-finish-load', () => {
      win.__tookLoaded = true;
    });
    // A spare that cannot draw would take the next hotkey and show nothing.
    win.webContents.once('did-fail-load', () => dropSpare(display.id, win));
    win.webContents.once('render-process-gone', () => {
      if (dropSpare(display.id, win)) prepareSoon();
    });
    win.once('closed', () => dropSpare(display.id, win));
    spareOverlays.set(display.id, win);
  });
}

/** Coalesces the bursts of display events a single change can fire. */
function prepareSoon(delay = 1000) {
  clearTimeout(prepareTimer);
  prepareTimer = setTimeout(prepareOverlays, delay);
}

/** Built for this display as it is now, and still able to draw. */
function fits(win, display) {
  if (win.isDestroyed() || win.webContents.isCrashed()) return false;
  const a = win.__tookBounds;
  const b = display.bounds;
  const sameBounds = a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  return sameBounds && win.__tookScale === display.scaleFactor;
}

/** @returns true when `win` was this display's spare */
function dropSpare(displayId, win) {
  if (spareOverlays.get(displayId) !== win) return false;
  spareOverlays.delete(displayId);
  if (!win.isDestroyed()) win.destroy();
  return true;
}

/** Destroy every spare, e.g. once they carry the wrong language. */
function resetSpares() {
  for (const [id, win] of spareOverlays) dropSpare(id, win);
  prepareSoon(0);
}

/** The display's spare, ready or still loading; a fresh window if it has none. */
function takeOverlay(shot) {
  const win = spareOverlays.get(shot.displayId);
  const display = screen.getAllDisplays().find((d) => d.id === shot.displayId);

  if (win && display && fits(win, display) && (win.__tookLoaded || win.webContents.isLoading())) {
    spareOverlays.delete(shot.displayId);
    return win;
  }
  if (win) dropSpare(shot.displayId, win);
  return createOverlayWindow(shot);
}

function pointInBounds(p, b) {
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

// ---------------------------------------------------------------------------
// IPC — overlay
// ---------------------------------------------------------------------------

/** The stream fallback or a scrolling screenshot needs the display's source. */
ipcMain.handle('overlay:source-id', (event, displayId) => screens.sourceIdFor(displayId));

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

/**
 * The pointer left the display that owned the keyboard before anything was
 * chosen on it. The display it is on now takes over — framed whole, with the
 * loupe — and gets the keyboard, as if the hotkey had been pressed there.
 */
ipcMain.on('overlay:release', () => {
  const cursor = screen.getCursorScreenPoint();
  const win = overlayAt(overlayWins, cursor);
  if (!win) return;
  const b = win.__tookBounds;
  win.webContents.send('overlay:take-over', { x: cursor.x - b.x, y: cursor.y - b.y });
  win.focus();
});

/**
 * The user picked another mode on one display. Every display follows, so
 * the pointer can carry 录屏 or 文字 across to another screen.
 */
ipcMain.on('overlay:mode', (event, mode) => {
  if (!OVERLAY_MODES.has(mode)) return;
  overlayMode = mode;
  overlayWins.forEach((win) => {
    if (!win.isDestroyed() && win.webContents.id !== event.sender.id) {
      win.webContents.send('overlay:mode', mode);
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

// The scrolling screenshot saves through here too.
ipcMain.handle('overlay:save', async (event, dataURL) => {
  const win = event.sender.isDestroyed() ? null : BrowserWindow.fromWebContents(event.sender);
  // Ctrl+S held down sends a save with every key repeat. Without a dialog in
  // the way, each would be another file: only the first counts, and the rest
  // arrive once the overlay is already gone.
  if (!win || win.isDestroyed() || win.__tookSaving) return false;
  win.__tookSaving = true;
  let saved = false;
  try {
    saved = await saveShot(win, dataURL);
  } finally {
    win.__tookSaving = false;
  }
  if (!saved) return false;
  closeOverlays();
  return true;
});

/**
 * Save a screenshot the way the settings ask. Saved without a dialog, a tray
 * notice says where it went: the overlay closes the moment it has saved, so
 * nothing else is left on screen to say so.
 * @returns whether it was saved; if not, whatever asked keeps the screenshot
 */
async function saveShot(win, dataURL) {
  let saved;
  try {
    saved = await saver.save(win, {
      name: t('file.screenshot', { stamp: stamp() }),
      ext: 'png',
      title: t('dialog.saveShot'),
      filter: t('dialog.png'),
      source: pngFromDataURL(dataURL),
    });
  } catch (err) {
    console.error('[took] 保存截图失败:', err);
    await saveFailed(win, t('err.saveShotTitle'), err);
    return false;
  }
  if (!saved) return false;

  if (!saved.asked) {
    // Windows cuts a notice off at 255 characters, so two whole paths would
    // lose the last line first: the folder it went to is enough there.
    const body = saved.movedFrom
      ? t('notice.savedElsewhere', { dir: saved.movedFrom, fallback: path.dirname(saved.file) })
      : t('notice.savedTo', { file: saved.file });
    balloon(t('notice.shotSaved'), body, () => shell.showItemInFolder(saved.file));
  }
  return true;
}

/** Saving failed where the dialog said: say so over the window that asked. */
async function saveFailed(win, title, err) {
  const detail = String((err && err.message) || err);
  // Parented, or it would open behind the overlay, which stays on top.
  if (win && !win.isDestroyed()) await dialog.showMessageBox(win, { type: 'error', title, message: title, detail });
  else dialog.showErrorBox(title, detail);
}

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

ipcMain.handle('overlay:copy-text', async (event, text, { close } = {}) => {
  await copyText(text);
  if (close) closeOverlays();
  return true;
});

// --- text recognition --------------------------------------------------------

/** A region is about to be recognised: have the models loaded by then. */
ipcMain.on('overlay:ocr-warm', () => ocr.warm());

/** RGBA pixels in; `{ lines }` or `{ error }` out — see src/main/ocr.js. */
ipcMain.handle('overlay:ocr', (event, image) => ocr.recognize(image));

/** A link in the recognised text: open it, and the capture is over. */
ipcMain.handle('overlay:open-link', async (event, href) => {
  const safe = safeHref(href);
  if (!safe) return false;
  closeOverlays();
  await shell.openExternal(safe);
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

ipcMain.handle('pin:save', (event, dataURL) => saveShot(BrowserWindow.fromWebContents(event.sender), dataURL));

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

  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  // Cached since startup. Asking getSources afresh froze Took for a second or
  // two, right as the recording was meant to begin — and began it that late.
  const sourceId = await screens.sourceIdFor(displayId);

  if (!sourceId || !display) {
    dialog.showErrorBox(t('err.recordTitle'), t('err.noSource'));
    closeWebcam();
    return false;
  }

  if (!settings.camera) closeWebcam();

  recordSettings = settings;

  recorderWin = createRecorderWindow();
  recorderWin.webContents.once('did-finish-load', () => {
    recorderWin.webContents.send('recorder:start', {
      sourceId,
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

  let saved;
  try {
    saved = await saver.save(win, {
      name: t('file.recording', { stamp: stamp() }),
      ext: lastClip.ext,
      title: t('dialog.saveRecording'),
      filter: describeFormat(lastClip.ext),
      source: { copyFrom: lastClip.file },
    });
  } catch (err) {
    console.error('[took] 保存录屏失败:', err);
    await saveFailed(win, t('err.saveRecordingTitle'), err);
    return false;
  }
  if (!saved) return false;

  // Asked or not, this shows where it went; the window says "Saved".
  shell.showItemInFolder(saved.file);
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

/**
 * The window saves every change as it is made. Each answer carries what is in
 * effect afterwards, so a change that was refused shows its old value again.
 */
ipcMain.handle('settings:save', (event, next) => {
  const previous = settings.get();
  const effective = () => ({ settings: settings.get(), autoLaunch: autoLaunch.enabled() });

  // The window sends every setting each time. Only a folder that changed is
  // checked: one that has gone offline since must not block every other change.
  if (next.saveDir && next.saveDir !== previous.saveDir) {
    const check = settings.checkWritable(next.saveDir);
    if (!check.ok) return { ok: false, message: t('settings.dirNotWritable', { message: check.message }), ...effective() };
  }

  settings.set(next);
  const conflicts = settings.refusedShortcuts(applyShortcuts(), previous, settings.get());

  if (conflicts.length) {
    // Never leave the user with hotkeys that no longer fire.
    settings.set(previous);
    applyShortcuts();
    refreshTrayMenu();
    return { ok: false, conflicts, ...effective() };
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
    // A window takes its language at creation; the spares have the old one.
    resetSpares();
    setTimeout(() => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.destroy();
      settingsWin = null;
      openSettings();
    }, 350);
  }

  return { ok: true, languageChanged, ...effective() };
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

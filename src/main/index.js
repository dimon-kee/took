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
  clipboard,
  nativeImage,
  dialog,
  desktopCapturer,
  screen,
  shell,
} = require('electron');

const { pathToFileURL } = require('url');

const { captureAllDisplays } = require('./capture');
const cursorTracker = require('./cursor');
const autoLaunch = require('./autolaunch');
const {
  createOverlayWindow,
  createPinWindow,
  createRecorderWindow,
  createRecordBarWindow,
  createEditorWindow,
  createWebcamWindow,
} = require('./windows');

// Unpackaged, the app name would default to "Electron" — which also becomes the
// HKCU Run value name. Pinning it keeps the dev run and the packaged build on
// one registry entry instead of leaving two start-up items behind.
app.setName('Took');

const SHORTCUT_CAPTURE = 'CommandOrControl+Shift+S';
const SHORTCUT_RECORD = 'CommandOrControl+Shift+R';

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
/** @type {Tray|null} */ let tray = null;
/** @type {Set<BrowserWindow>} */ const pinWins = new Set();

let capturing = false;
let webcamDeviceId = null;
let recordSettings = null;
let stopCursor = null;
/** Last finished recording, parked in temp for the preview window. */
let lastClip = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => startCapture());
}

// Tray-resident app: closing every window must not quit it.
app.on('window-all-closed', () => {});

// Nothing is shown at startup: the app lives in the tray until a hotkey fires.
app.whenReady().then(() => {
  autoLaunch.refresh();
  setupTray();
  registerShortcuts();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

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
  tray.setToolTip('Took — 截图 / 录屏');
  refreshTrayMenu();
  tray.on('click', () => startCapture());
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `截图  ${prettyKey(SHORTCUT_CAPTURE)}`, click: () => startCapture() },
      { label: `录屏  ${prettyKey(SHORTCUT_RECORD)}`, click: () => startRecordSelection() },
      { type: 'separator' },
      { label: '打开保存目录', click: () => shell.openPath(defaultSaveDir()) },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: autoLaunch.enabled(),
        click: (item) => {
          autoLaunch.set(item.checked);
          refreshTrayMenu();
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.exit(0) },
    ])
  );
}

function prettyKey(accel) {
  return accel.replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ');
}

function registerShortcuts() {
  const ok = globalShortcut.register(SHORTCUT_CAPTURE, () => startCapture());
  const okRec = globalShortcut.register(SHORTCUT_RECORD, () => startRecordSelection());

  if (!ok) console.warn(`[took] 无法注册快捷键 ${SHORTCUT_CAPTURE},可能被其他程序占用`);
  if (!okRec) console.warn(`[took] 无法注册快捷键 ${SHORTCUT_RECORD},可能被其他程序占用`);
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
    const shots = await captureAllDisplays();
    if (!shots.length) throw new Error('没有可捕获的屏幕');

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
    dialog.showErrorBox('截屏失败', String(err && err.message ? err.message : err));
    closeOverlays();
  } finally {
    capturing = false;
  }
}

function closeOverlays() {
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

ipcMain.handle('overlay:copy', (event, dataURL) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
  closeOverlays();
  return true;
});

ipcMain.handle('overlay:save', async (event, dataURL) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '保存截图',
    defaultPath: path.join(defaultSaveDir(), `截图_${stamp()}.png`),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
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

ipcMain.handle('overlay:copy-text', (event, text) => {
  clipboard.writeText(String(text));
  return true;
});

// ---------------------------------------------------------------------------
// IPC — pin windows
// ---------------------------------------------------------------------------

ipcMain.on('pin:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.destroy();
});

ipcMain.on('pin:copy', (event, dataURL) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
});

ipcMain.on('pin:set-opacity', (event, value) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.setOpacity(value);
});

ipcMain.handle('pin:save', async (event, dataURL) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '保存截图',
    defaultPath: path.join(defaultSaveDir(), `截图_${stamp()}.png`),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
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
  dialog.showErrorBox('摄像头打开失败', String(message || '未知错误'));
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
    dialog.showErrorBox('录屏失败', '找不到对应的屏幕源');
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
  const file = path.join(app.getPath('temp'), `took_${stamp()}.${ext}`);
  try {
    fs.writeFileSync(file, Buffer.from(buffer));
  } catch (err) {
    dialog.showErrorBox('保存录屏失败', String(err.message || err));
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
  dialog.showErrorBox('录屏失败', String(message || '未知错误'));
});

ipcMain.handle('editor:save', async (event) => {
  if (!lastClip) return false;
  const win = BrowserWindow.fromWebContents(event.sender);

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '保存录屏',
    defaultPath: path.join(defaultSaveDir(), `录屏_${stamp()}.${lastClip.ext}`),
    filters: [{ name: describeFormat(lastClip.ext), extensions: [lastClip.ext] }],
  });

  if (canceled || !filePath) return false;

  fs.copyFileSync(lastClip.file, filePath);
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('editor:copy', () => {
  if (!lastClip) return false;
  try {
    // A GIF can go on the clipboard as a bitmap too, which is what most chat
    // apps paste; the file reference covers Explorer and everything else.
    if (lastClip.ext === 'gif') {
      clipboard.writeImage(nativeImage.createFromPath(lastClip.file));
    }
    writeFileToClipboard(lastClip.file);
    return true;
  } catch (err) {
    console.error('[took] 复制录屏失败:', err);
    return false;
  }
});

/** Windows pastes a file when CF_HDROP-style 'FileNameW' data is present. */
function writeFileToClipboard(file) {
  if (process.platform !== 'win32') return;
  const buffer = Buffer.from(`${file}\0`, 'ucs2');
  clipboard.writeBuffer('FileNameW', buffer);
}

function extensionFor(mime) {
  if (!mime) return 'webm';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('mp4')) return 'mp4';
  return 'webm';
}

function describeFormat(ext) {
  return { mp4: 'MP4 视频', gif: 'GIF 动图', webm: 'WebM 视频' }[ext] || ext.toUpperCase();
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

function defaultSaveDir() {
  try {
    const pictures = app.getPath('pictures');
    const dir = path.join(pictures, 'Took');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.homedir();
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
}

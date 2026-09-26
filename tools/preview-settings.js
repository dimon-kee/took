'use strict';

// 语言可用 TOOK_LANG=zh 覆盖，便于比对两种语言的排版。
const LANG = process.env.TOOK_LANG || 'en';

/**
 * Renders the settings window to a PNG, including the hotkey-capture and
 * conflict states, so the layout can be checked without clicking through the
 * tray menu.
 *
 *   npx electron tools/preview-settings.js [outDir]
 */

const fs = require('fs');
const path = require('path');
const { app, ipcMain, BrowserWindow } = require('electron');
const settings = require('../src/main/settings');

app.setName('Took');
app.on('window-all-closed', () => {});

const OUT = process.argv[2] || path.join(app.getPath('temp'), 'took-preview');

// Stand in for src/main/index.js, which this harness does not load.
ipcMain.handle('settings:load', () => ({
  settings: settings.get(),
  defaults: {
    ...settings.DEFAULTS,
    saveDirLabel: settings.saveDir(),
    languages: require('../src/shared/i18n').LANGUAGES,
  },
}));
ipcMain.handle('settings:save', () => ({ ok: false, conflicts: ['record'] }));
ipcMain.handle('settings:pick-dir', () => null);
ipcMain.on('settings:open-dir', () => {});
ipcMain.on('settings:close', () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 580,
    height: 580,
    show: true,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'settings.js'),
      additionalArguments: [`--took-lang=${LANG}`],
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.log(`  [renderer:error] ${e.message}`);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'settings', 'index.html'));
  await wait(700);

  await shoot(win, 'settings-a-default', '');
  await shoot(win, 'settings-b-listening', `document.getElementById('hk-capture').click();`);
  await shoot(
    win,
    'settings-c-conflict',
    `document.getElementById('hk-capture').click();
     document.dispatchEvent(new KeyboardEvent('keydown',
       { code: 'KeyJ', ctrlKey: true, altKey: true, bubbles: true }));
     document.getElementById('btn-save').click();`
  );

  console.log(`\n预览图写在: ${OUT}`);
  app.exit(0);
});

async function shoot(win, name, script) {
  if (script) {
    await win.webContents.executeJavaScript(`(() => { ${script} return true; })()`);
    await wait(450);
  }

  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
  console.log(`  ${name}.png`);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

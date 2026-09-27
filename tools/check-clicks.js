'use strict';

/**
 * Clicks through the recording card's dropdowns and the settings checkbox with
 * real input events (webContents.sendInputEvent) rather than element.click().
 *
 * element.click() fires a lone click with no press before it, so anything that
 * reacts to mousedown never runs under the previews. That is how a real bug
 * got through: the cursor-effect ticks and the device pickers dismissed their
 * menu on the press, and the item under the pointer never got its click.
 *
 *   npx electron tools/check-clicks.js
 */

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { DEFAULTS } = require('../src/main/settings');
const { LANGUAGES } = require('../src/shared/i18n');

app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const W = 1280;
const H = 720;

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

// This harness is its own entry point, so stand in for the app's IPC.
['overlay:webcam', 'overlay:copy', 'overlay:save', 'overlay:pin', 'overlay:copy-text',
 'overlay:record'].forEach((channel) => ipcMain.handle(channel, () => false));

let saved = null;
ipcMain.handle('settings:load', () => ({
  settings: { ...DEFAULTS, shortcuts: { ...DEFAULTS.shortcuts } },
  autoLaunch: true,
  defaults: { ...DEFAULTS, saveDirLabel: 'C:\\Took', languages: LANGUAGES },
}));
ipcMain.handle('settings:save', (event, next) => {
  saved = next;
  return { ok: true, languageChanged: false };
});
ipcMain.handle('settings:pick-dir', () => null);
ipcMain.on('settings:open-dir', () => {});
ipcMain.on('settings:close', () => {});

app.whenReady().then(async () => {
  try {
    await recordCard();
    await settingsWindow();
  } catch (err) {
    console.log(`  FAIL  ${err.message}`);
    failures++;
  }

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  app.exit(failures ? 1 : 0);
});

async function recordCard() {
  console.log('录屏卡片的下拉菜单');

  const win = open('overlay', { width: W, height: H, frame: false });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'overlay', 'index.html'));

  // No real desktop to grab here — let the overlay fall back to a PNG.
  const blank = await win.webContents.executeJavaScript(`(() => {
    const c = document.createElement('canvas');
    c.width = ${W}; c.height = ${H};
    const x = c.getContext('2d');
    x.fillStyle = '#e9edf4'; x.fillRect(0, 0, ${W}, ${H});
    return c.toDataURL('image/png');
  })()`);
  ipcMain.handle('overlay:fallback-shot', () => blank);

  win.webContents.send('overlay:init', {
    mode: 'record',
    isPrimary: true,
    cursor: { x: 420, y: 300 },
    shot: {
      displayId: 1,
      sourceId: null,
      bounds: { x: 0, y: 0, width: W, height: H },
      workArea: { x: 0, y: 0, width: W, height: H - 48 },
      scaleFactor: 1,
      pixelSize: { width: W, height: H },
    },
  });
  await wait(800);

  const page = driver(win);
  const menu = () =>
    page.run(`(() => {
      const m = document.querySelector('.rec-menu');
      return {
        open: !m.classList.contains('hidden'),
        boxes: [...m.querySelectorAll('.menu-item.check .box')].map((b) => b.classList.contains('on')),
        ticks: [...m.querySelectorAll('.menu-item[data-id]')].map((i) => Boolean(i.querySelector('.tick'))),
      };
    })()`);

  await page.clickAt(420, 300); // accept the pre-selected full screen
  check('卡片出现', await page.run(`!document.querySelector('.recpanel').classList.contains('hidden')`));

  await page.clickOn('.dev[data-key="cursor"] .dev-caret');
  let m = await menu();
  check('点 ▾ 打开光标菜单', m.open);

  const before = m.boxes[0];
  await page.clickOn('.rec-menu .menu-item.check');
  m = await menu();
  check('勾选项能切换', m.boxes[0] === !before, `${before} -> ${m.boxes[0]}`);
  check('勾选后菜单不收起', m.open);

  await page.clickOn('.dev[data-key="cursor"] .dev-caret');
  check('再点 ▾ 收起菜单', !(await menu()).open);

  await page.clickOn('.dev[data-key="mic"] .dev-caret');
  m = await menu();
  if (m.ticks.length < 2) {
    console.log('  SKIP  换麦克风 — 这台机器上不到两个输入设备');
  } else {
    const target = m.ticks.findIndex((on) => !on);
    await page.clickOn('.rec-menu .menu-item[data-id]', target);
    m = await menu();
    check('换麦克风', m.ticks[target] === true && m.ticks.filter(Boolean).length === 1, `选第 ${target + 1} 个`);
  }

  await page.clickAt(40, 40);
  check('点菜单外面收起', !(await menu()).open);

  win.destroy();
}

async function settingsWindow() {
  console.log('\n设置窗口的勾选框');

  const win = open('settings', { width: 580, height: 580 });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'settings', 'index.html'));
  await wait(500);

  const page = driver(win);
  const checked = () => page.run(`document.getElementById('auto-launch').checked`);

  check('按注册表显示为已勾选', await checked());

  // Every part of the row should toggle it: the box, its text, and the label
  // in the left column.
  for (const [name, selector] of [
    ['方框', '.check i'],
    ['文字', '.check span'],
    ['左侧标签', 'label[for="auto-launch"]'],
  ]) {
    const was = await checked();
    await page.clickOn(selector);
    check(`点${name}能切换`, (await checked()) === !was);
  }

  // Three flips from on leave it off, so the save has to carry the change.
  await page.clickOn('#btn-save');
  check('改过的值随保存发给主进程', saved && saved.autoLaunch === false, `autoLaunch=${saved && saved.autoLaunch}`);

  win.destroy();
}

function open(preload, options) {
  const win = new BrowserWindow({
    ...options,
    show: true,
    useContentSize: true,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', `${preload}.js`),
      additionalArguments: ['--took-lang=en'],
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.log(`  [renderer:error] ${e.message}`);
  });

  return win;
}

/** Real input: move, press, release — the same sequence a mouse produces. */
function driver(win) {
  const run = (code) => win.webContents.executeJavaScript(code);

  async function clickAt(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await wait(250);
  }

  async function clickOn(selector, index = 0) {
    const p = await run(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!p) throw new Error(`找不到 ${selector}`);
    await clickAt(p.x, p.y);
  }

  return { run, clickAt, clickOn };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

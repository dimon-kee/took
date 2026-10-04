'use strict';

/**
 * Clicks through the recording card's dropdowns and the settings window with
 * real input events (webContents.sendInputEvent) rather than element.click().
 *
 * element.click() fires a lone click with no press before it, so anything that
 * reacts to mousedown never runs under the previews. That is how a real bug
 * got through: the cursor-effect ticks and the device pickers dismissed their
 * menu on the press, and the item under the pointer never got its click.
 *
 * The clipboard itself is check-clipboard.js's job; here main's side is a stub.
 *
 *   npx electron tools/check-clicks.js
 */

const path = require('path');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const { DEFAULTS } = require('../src/main/settings');
const { LANGUAGES, createTranslator } = require('../src/shared/i18n');

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
['overlay:webcam', 'overlay:save', 'overlay:pin', 'overlay:copy-text',
 'overlay:record'].forEach((channel) => ipcMain.handle(channel, () => false));

// Answers the way main does when the clipboard write fails, so the overlay's
// failure path gets exercised too.
let copied = null;
ipcMain.handle('overlay:copy', (event, dataURL) => {
  copied = dataURL;
  return false;
});

// No real desktop to grab here, so the overlay falls back to asking main for a
// PNG — hand it a flat one.
let desktop = null;
ipcMain.handle('overlay:fallback-shot', () => {
  if (!desktop) {
    const raw = Buffer.alloc(W * H * 4);
    for (let i = 0; i < raw.length; i += 4) raw.set([0xf4, 0xed, 0xe9, 0xff], i); // BGRA
    desktop = nativeImage.createFromBuffer(raw, { width: W, height: H }).toDataURL();
  }
  return desktop;
});

// Answers the way main does: what is in effect after the save, and a hotkey
// another program owns — here Ctrl+Alt+J — refused, with the old one kept.
const TAKEN = 'CommandOrControl+Alt+J';
const saves = [];
let effective = { ...DEFAULTS, shortcuts: { ...DEFAULTS.shortcuts } };
let autoLaunch = true;
ipcMain.handle('settings:load', () => ({
  settings: structuredClone(effective),
  autoLaunch,
  defaults: { ...DEFAULTS, saveDirLabel: 'C:\\Took', languages: LANGUAGES },
}));
ipcMain.handle('settings:save', (event, next) => {
  saves.push(structuredClone(next));
  const conflicts = Object.keys(next.shortcuts).filter((k) => next.shortcuts[k] === TAKEN);
  if (conflicts.length) return { ok: false, conflicts, settings: structuredClone(effective), autoLaunch };
  const { autoLaunch: wanted, ...rest } = next;
  effective = structuredClone(rest);
  if (typeof wanted === 'boolean') autoLaunch = wanted;
  return { ok: true, languageChanged: false, settings: structuredClone(effective), autoLaunch };
});
ipcMain.handle('settings:pick-dir', () => null);
ipcMain.on('settings:open-dir', () => {});
ipcMain.on('settings:close', () => {});

app.whenReady().then(async () => {
  try {
    await confirmButton();
    await recordCard();
    await settingsWindow();
  } catch (err) {
    console.log(`  FAIL  ${err.message}`);
    failures++;
  }

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  app.exit(failures ? 1 : 0);
});

async function confirmButton() {
  console.log('截图工具栏的 ✓');

  const win = await openOverlay('capture');
  const page = driver(win);

  await page.clickAt(420, 300); // accept the pre-selected full screen
  await page.clickOn('.tool[data-id="confirm"]');

  check(
    '点 ✓ 把截图交给主进程',
    typeof copied === 'string' && copied.startsWith('data:image/png;base64,'),
    copied ? `${Math.round(copied.length / 1024)} KB` : '没收到'
  );

  const toast = await page.run(`(() => {
    const t = document.getElementById('toast');
    return t.classList.contains('hidden') ? null : t.textContent;
  })()`);
  check('复制失败时提示，而不是没反应', toast === createTranslator('en')('toast.copyFailed'), toast || '没有提示');

  win.destroy();
}

async function recordCard() {
  console.log('\n录屏卡片的下拉菜单');

  const win = await openOverlay('record');
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
  console.log('\n设置窗口：改了就保存');

  const win = open('settings', { width: 580, height: 680 });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'settings', 'index.html'));
  await wait(500);

  const page = driver(win);
  const checked = () => page.run(`document.getElementById('auto-launch').checked`);
  const status = () => page.run(`(() => { const s = document.getElementById('status'); return { text: s.textContent, warn: s.classList.contains('warn') }; })()`);
  const T = createTranslator('en');

  check('没有保存按钮', await page.run(`!document.getElementById('btn-save') && !document.getElementById('btn-cancel')`));
  check('底部说明改了会自动保存', (await status()).text === T('settings.autoSaves'), (await status()).text);
  check('按注册表显示为已勾选', await checked());

  // Every part of the row should toggle it: the box, its text, and the label
  // in the left column — and each flip goes straight to main.
  for (const [name, selector] of [
    ['方框', '.check i'],
    ['文字', '.check span'],
    ['左侧标签', 'label[for="auto-launch"]'],
  ]) {
    const was = await checked();
    const before = saves.length;
    await page.clickOn(selector);
    const last = saves[saves.length - 1];
    check(`点${name}能切换，马上保存`, (await checked()) === !was && saves.length === before + 1 && last.autoLaunch === !was, `autoLaunch=${last && last.autoLaunch}`);
  }
  check('保存后底部显示「已保存」', (await status()).text === T('settings.saved'));

  await page.clickOn('.lang[data-lang="zh"]');
  check('点语言马上保存', saves[saves.length - 1].language === 'zh');

  // A hotkey: press the field, then the combination, as a keyboard would.
  await page.clickOn('#hk-capture');
  await page.keys('K', ['control', 'alt']);
  const capture = () => page.run(`document.getElementById('hk-capture').textContent`);
  check(
    '录好的快捷键马上保存',
    saves[saves.length - 1].shortcuts.capture === 'CommandOrControl+Alt+K' && (await capture()) === 'Ctrl + Alt + K',
    await capture()
  );

  await page.clickOn('#hk-capture');
  await page.keys('J', ['control', 'alt']);
  const refused = await status();
  check('被占用的快捷键退回原来的', (await capture()) === 'Ctrl + Alt + K', await capture());
  check('并在底部说明', refused.warn && refused.text === T('settings.conflict', { names: T('settings.capture') }), refused.text);

  win.destroy();
}

async function openOverlay(mode) {
  const win = open('overlay', { width: W, height: H, frame: false });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'overlay', 'index.html'));

  win.webContents.send('overlay:init', {
    mode,
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

  return win;
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

  /** A key pressed with modifiers held, e.g. keys('K', ['control', 'alt']). */
  async function keys(keyCode, modifiers) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(250);
  }

  return { run, clickAt, clickOn, keys };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

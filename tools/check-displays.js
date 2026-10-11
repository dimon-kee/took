'use strict';

/**
 * Two displays, simulated on one: two overlays side by side, each told it is
 * a display of its own, each with a frozen frame of a single colour. The real
 * pointer is moved from the first across into the second, so Windows hands
 * the windows their moves and leaves as it would between two monitors, and
 * the loupe has to follow: on the display under the pointer, reading that
 * display's pixels, gone from the other one — and the keyboard with it.
 *
 * It moves your pointer for a few seconds, then puts it back. Leave the mouse
 * alone meanwhile.
 *
 *   npx electron tools/check-displays.js
 */

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const koffi = require('koffi');
const { createOverlayWindow, overlayAt } = require('../src/main/windows');

const user32 = koffi.load('user32.dll');
koffi.struct('POINT', { x: 'int32', y: 'int32' });
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *point)');
const mouse_event = user32.func('void __stdcall mouse_event(uint32 flags, int32 dx, int32 dy, int32 data, uintptr extra)');
const MOUSE_LEFTDOWN = 0x0002;
const MOUSE_LEFTUP = 0x0004;

app.setName('Took');
app.on('window-all-closed', () => {});

const SIZE = { width: 600, height: 400 }; // CSS px, each "display"
const COLORS = [
  [200, 40, 40],
  [40, 40, 200],
];

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

let overlays = [];
let revealed = 0;

// What main answers the overlays with — claim, yield and release as in
// src/main/index.js.
ipcMain.on('overlay:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (win.__tookPrimary) {
    win.show();
    win.focus();
  } else {
    win.showInactive();
  }
  revealed++;
});
ipcMain.on('overlay:claim', (event) => {
  overlays.forEach((win) => {
    if (!win.isDestroyed() && win.webContents.id !== event.sender.id) {
      win.webContents.send('overlay:yield');
    }
  });
});
// As src/main/index.js: the display under the pointer takes over.
ipcMain.on('overlay:release', () => {
  const cursor = screen.getCursorScreenPoint();
  const win = overlayAt(overlays, cursor);
  if (!win) return;
  const b = win.__tookBounds;
  win.webContents.send('overlay:take-over', { x: cursor.x - b.x, y: cursor.y - b.y });
  win.focus();
});
ipcMain.on('overlay:cancel', () => {});
ipcMain.handle('overlay:source-id', () => null);
ipcMain.handle('overlay:fallback-shot', () => null);
['overlay:webcam', 'overlay:copy', 'overlay:save', 'overlay:pin', 'overlay:copy-text', 'overlay:record'].forEach(
  (channel) => ipcMain.handle(channel, () => false)
);

app.whenReady().then(async () => {
  const home = {};
  GetCursorPos(home);
  try {
    await run();
  } catch (err) {
    check('跑完', false, err.message);
  } finally {
    overlays.forEach((w) => !w.isDestroyed() && w.destroy());
    SetCursorPos(home.x, home.y);
  }

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  app.exit(failures ? 1 : 0);
});

async function run() {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const left = Math.round(wa.x + wa.width / 2 - SIZE.width);
  const top = Math.round(wa.y + (wa.height - SIZE.height) / 2);

  const shots = [0, 1].map((i) =>
    shotFor(i, { x: left + i * SIZE.width, y: top, ...SIZE }, display.scaleFactor)
  );
  // Pressed with the pointer on the first display: that one owns the keyboard.
  const cursor = { x: shots[0].bounds.x + 100, y: shots[0].bounds.y + 100 };
  await pointTo(cursor.x, cursor.y);

  overlays = shots.map((shot, i) => {
    const win = createOverlayWindow(shot);
    win.__tookPrimary = i === 0;
    win.__tookBounds = shot.bounds;
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('overlay:init', { mode: 'capture', shot, cursor, isPrimary: i === 0 });
    });
    return win;
  });
  if (!(await until(() => revealed === 2, 10000))) throw new Error('两块屏的取景层没都出来');
  await wait(300);

  const [a, b] = overlays;
  const y = SIZE.height / 2;
  const at = (i, x) => pointTo(shots[i].bounds.x + x, shots[i].bounds.y + y);

  console.log('指针从屏幕 1 走到屏幕 2');
  await at(0, SIZE.width - 60);
  await at(0, SIZE.width - 2);
  await wait(150);
  const first = await loupe(a);
  check('在屏幕 1 上时，屏幕 1 显示放大镜', first.visible);
  check('读的是屏幕 1 的颜色', first.color === `RGB:${COLORS[0].join(',')}`, first.color);

  await at(1, 2);
  await at(1, 80);
  await wait(150);
  let [la, lb] = [await loupe(a), await loupe(b)];
  check('指到屏幕 2，屏幕 2 显示放大镜', lb.visible);
  check(
    '读的是屏幕 2 的坐标',
    lb.visible && lb.coord.includes(String(shots[1].bounds.x + 80)) && lb.coord.includes(String(shots[1].bounds.y + y)),
    lb.coord
  );
  check('读的是屏幕 2 的颜色', lb.visible && lb.color === `RGB:${COLORS[1].join(',')}`, lb.color);
  check('屏幕 1 的放大镜不再停在边上', !la.visible, la.visible ? `还在：${la.transform}，${la.coord}` : '');
  check('键盘也跟到屏幕 2', b.isFocused(), b.isFocused() ? '' : a.isFocused() ? '还在屏幕 1' : '两边都没有');

  console.log('\n再走回屏幕 1');
  await at(0, SIZE.width - 2);
  await at(0, SIZE.width - 80);
  await wait(150);
  [la, lb] = [await loupe(a), await loupe(b)];
  check('回到屏幕 1，屏幕 1 显示放大镜', la.visible && la.color === `RGB:${COLORS[0].join(',')}`, la.color);
  check('屏幕 2 的放大镜收起来', !lb.visible, lb.visible ? `还在：${lb.transform}，${lb.coord}` : '');
  check('键盘回到屏幕 1', a.isFocused());

  console.log('\n在屏幕 1 选好区域，再走到屏幕 2');
  // A click takes the whole display it is framed on; the toolbar comes up.
  mouse_event(MOUSE_LEFTDOWN, 0, 0, 0, 0);
  mouse_event(MOUSE_LEFTUP, 0, 0, 0, 0);
  await wait(200);
  check('屏幕 1 选好了，工具栏出来', await toolbarShown(a));
  await at(1, 2);
  await at(1, 80);
  await wait(150);
  lb = await loupe(b);
  check('选区还在屏幕 1，工具栏也在', await toolbarShown(a));
  check('屏幕 2 不抢：没有放大镜', !lb.visible, lb.visible ? lb.coord : '');
  check('键盘留在屏幕 1', a.isFocused());
}

function toolbarShown(win) {
  return win.webContents.executeJavaScript(`!document.getElementById('toolbar').classList.contains('hidden')`);
}

/** One display's worth of shot, its frozen frame a single colour. */
function shotFor(i, bounds, scaleFactor) {
  const width = Math.round(bounds.width * scaleFactor);
  const height = Math.round(bounds.height * scaleFactor);
  const pixels = Buffer.alloc(width * height * 4);
  const [r, g, b] = COLORS[i];
  for (let p = 0; p < pixels.length; p += 4) {
    pixels[p] = b; // BGRX, as GDI hands it over; the fourth byte stays 0
    pixels[p + 1] = g;
    pixels[p + 2] = r;
  }
  return {
    displayId: i + 1,
    sourceId: null,
    bounds,
    workArea: { x: 0, y: 0, width: bounds.width, height: bounds.height },
    scaleFactor,
    pixelSize: { width, height },
    frame: { width, height, pixels },
  };
}

/** Move the real pointer to a point on screen (DIP) and let Windows deliver it. */
async function pointTo(x, y) {
  const p = screen.dipToScreenPoint({ x, y });
  SetCursorPos(p.x, p.y);
  await wait(60);
}

function loupe(win) {
  return win.webContents.executeJavaScript(`(() => {
    const m = document.querySelector('.magnifier');
    if (!m) return { visible: false, coord: '', color: '', transform: '' };
    return {
      visible: !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none',
      transform: m.style.transform,
      coord: m.querySelector('[data-role="coord"]').textContent,
      color: m.querySelector('[data-role="color"]').textContent,
    };
  })()`);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await wait(50);
  }
  return false;
}

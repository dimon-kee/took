'use strict';

/**
 * A scrolling screenshot end to end, through the real pieces: the overlay
 * window, a live desktop stream, main's capture session, the stitcher and the
 * export. A test page carries its own row number in every pixel row; it is
 * scrolled under the selection, and the stitched image must then read
 * n, n+1, n+2, … all the way down — nothing skipped, nothing repeated, none of
 * the overlay's own chrome captured.
 *
 * Puts an overlay over the primary display for a few seconds. Leave the mouse
 * alone while it runs: the pointer is part of what gets captured.
 *
 *   npx electron tools/check-longshot.js
 */

const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron');
const { describeDisplays, captureDisplayImage } = require('../src/main/capture');
const { createOverlayWindow } = require('../src/main/windows');
const longCapture = require('../src/main/longcapture');

app.on('window-all-closed', () => {});

const PAGE = { width: 520, height: 460 }; // CSS px
// The row number is written down the page's left edge in black and white —
// one cell per bit. Not in colour: Windows colour management maps page colours
// to the display's profile before any capture sees them, and exact values do
// not survive that. Black and white do.
const BITS = 14;
const CELL = 8; // device px per bit, so a crop a few px off still reads true
const MARGIN = 8; // device px of plain page before the first cell
// The page starts part way down, is scrolled down, then back up past where it
// started — the image has to grow at both ends — with a couple of small moves
// inside what is already captured. CSS px, all multiples of 4 so they land on
// whole device pixels at 125% as well as 100% and 200%.
const START = 1200;
const MOVES = [40, 80, 120, 64, 96, -160, -48, -112, -88, -136, -72, -104, -56, -144, -92, -128, 48, -60];

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

let overlay = null;
let page = null;
let copied = null;

ipcMain.on('overlay:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.show();
});
ipcMain.on('overlay:claim', () => {});
ipcMain.on('overlay:cancel', () => {});
ipcMain.handle('overlay:webcam', () => false);
ipcMain.handle('overlay:fallback-shot', (event, id) => captureDisplayImage(id));
ipcMain.handle('overlay:save', () => false);
ipcMain.handle('overlay:copy', (event, dataURL) => {
  copied = dataURL;
  return true;
});
// The same three lines as src/main/index.js, minus closing other displays.
ipcMain.handle('overlay:long-start', (event, rects) => {
  longCapture.start(BrowserWindow.fromWebContents(event.sender), rects);
  return true;
});
ipcMain.on('overlay:long-panel', (event, rect) => longCapture.setPanel(rect));
ipcMain.on('overlay:long-stop', () => longCapture.stop());

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    check('跑完整个流程', false, err.message);
  } finally {
    longCapture.stop();
    [overlay, page].forEach((w) => w && !w.isDestroyed() && w.destroy());
  }

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  app.exit(failures ? 1 : 0);
});

async function run() {
  const display = screen.getPrimaryDisplay();
  const shot = (await describeDisplays()).find((s) => s.displayId === display.id);
  if (!shot || !shot.sourceId) throw new Error('找不到主屏幕的捕获源');

  // Keep the page away from the pointer: it would be captured along with it.
  const pointer = screen.getCursorScreenPoint();
  const wa = display.workArea;
  const leftHalf = pointer.x > wa.x + wa.width / 2;
  const bounds = {
    x: Math.round(leftHalf ? wa.x + 60 : wa.x + wa.width - PAGE.width - 60),
    y: Math.round(wa.y + 60),
    width: PAGE.width,
    height: PAGE.height,
  };

  console.log('长截图，端到端');
  page = new BrowserWindow({
    ...bounds,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { sandbox: true },
  });
  await page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHTML())}`);
  await page.webContents.executeJavaScript(`window.scrollTo(0, ${START}); true`);
  page.showInactive();
  const dpr = await page.webContents.executeJavaScript('window.devicePixelRatio');

  overlay = createOverlayWindow(shot);
  await new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
  overlay.webContents.send('overlay:init', { mode: 'long', shot, cursor: pointer, isPrimary: true });
  await until(() => debug().then((d) => d.ready), '覆盖层就绪');
  await wait(400);

  // Drag a selection over the page, with the row-number strip just inside it.
  const local = { x: bounds.x - display.bounds.x, y: bounds.y - display.bounds.y };
  const sel = { x0: local.x + 2, y0: local.y + 12, x1: local.x + PAGE.width - 30, y1: local.y + PAGE.height - 12 };
  mouse('mouseDown', sel.x0, sel.y0);
  for (let i = 1; i <= 6; i++) {
    mouse('mouseMove', sel.x0 + ((sel.x1 - sel.x0) * i) / 6, sel.y0 + ((sel.y1 - sel.y0) * i) / 6);
  }
  mouse('mouseUp', sel.x1, sel.y1);
  await wait(300);

  const afterSelect = await debug();
  check('选好区域，出现开始按钮', afterSelect.phase === 'ready' && (await visible('.long-go')));

  await clickOn('.long-go');
  await until(() => debug().then((d) => d.long === 'running'), '开始捕获');
  check('按开始后进入捕获', true);
  await wait(500);

  // Scroll position relative to START, and how far up and down it went.
  let at = 0;
  let highest = 0;
  let lowest = 0;
  for (const move of MOVES) {
    await page.webContents.executeJavaScript(`window.scrollBy(0, ${move}); true`);
    at += move;
    highest = Math.min(highest, at);
    lowest = Math.max(lowest, at);
    await wait(220);
  }
  await wait(400);
  const { steps } = (await debug()).longStats;

  await clickOn('.long-stop');
  await until(() => debug().then((d) => d.long === 'done'), '停止');
  await clickOn('[data-act="confirm"]');
  await until(async () => Boolean(copied), '点 ✓ 交出图片');

  // Read the row numbers back out of the stitched image.
  const image = nativeImage.createFromDataURL(copied);
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  // Where the crop starts inside the page, in device px — the cell centres
  // are read relative to that.
  const offset = Math.round((sel.x0 - local.x) * dpr);
  const rows = [];
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let bit = 0; bit < BITS; bit++) {
      const x = MARGIN + bit * CELL + CELL / 2 - offset;
      const i = (y * width + x) * 4;
      if (bgra[i] + bgra[i + 1] + bgra[i + 2] < 3 * 128) n |= 1 << bit;
    }
    rows.push(n);
  }

  let breaks = 0;
  let firstBreak = -1;
  for (let y = 1; y < rows.length; y++) {
    if (rows[y] !== rows[y - 1] + 1) {
      breaks++;
      if (firstBreak < 0) firstBreak = y;
    }
  }

  check('往下长过，也往上长过', steps.appended > 0 && steps.moved > 0, JSON.stringify(steps));

  const expected = Math.round((sel.y1 - sel.y0 + lowest - highest) * dpr);
  check('图片高度 ≈ 选区高度 + 上下滚过的范围', Math.abs(height - expected) <= 3, `${width}×${height}，应为 ≈${expected}`);
  check(
    '每一行的行号都连续',
    breaks === 0,
    breaks ? `${breaks} 处断开，第一处在第 ${firstBreak} 行：${rows[firstBreak - 1]} → ${rows[firstBreak]}` : `${rows[0]} … ${rows[rows.length - 1]}`
  );
  const top = Math.round((sel.y0 - local.y + START + highest) * dpr);
  check('从滚到的最高处开始', Math.abs(rows[0] - top) <= 2, `第一行 ${rows[0]}，应为 ≈${top}`);
}

// ---------------------------------------------------------------------------

/**
 * A tall page drawn in device pixels: the row-number cells down the left, then
 * lines of pseudo-text — something a person might actually capture.
 */
function pageHTML() {
  return `<!DOCTYPE html><html><head><style>
    html, body { margin: 0; background: #fff; overflow-x: hidden; }
    ::-webkit-scrollbar { display: none; }
    canvas { display: block; }
  </style></head><body><canvas id="c"></canvas><script>
    const dpr = window.devicePixelRatio;
    const cssW = ${PAGE.width}, cssH = 5200;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    const cellsEnd = ${MARGIN} + ${BITS} * ${CELL};
    const c = document.getElementById('c');
    c.width = w; c.height = h; c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
    const x = c.getContext('2d');
    const img = x.createImageData(w, h);
    const d = img.data;
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let y = 0; y < h; y++) {
      const line = Math.floor(y / 22), inLine = y % 22;
      for (let px = 0; px < w; px++) {
        const i = (y * w + px) * 4;
        let v = 255;
        if (px >= ${MARGIN} && px < cellsEnd) {
          v = (y >> Math.floor((px - ${MARGIN}) / ${CELL})) & 1 ? 0 : 255;
        } else if (inLine > 3 && inLine < 16 && px > cellsEnd + 12 && px < w - 40 && ((px >> 5) + line) % 5 && rand() < 0.4) {
          v = 50;
        }
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
  </script></body></html>`;
}

function mouse(type, x, y) {
  overlay.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
}

async function clickOn(selector) {
  const p = await overlay.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!p) throw new Error(`找不到 ${selector}`);
  mouse('mouseMove', p.x, p.y);
  mouse('mouseDown', p.x, p.y);
  mouse('mouseUp', p.x, p.y);
  await wait(250);
}

function visible(selector) {
  return overlay.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    return Boolean(el) && !el.classList.contains('hidden') && el.offsetWidth > 0;
  })()`);
}

function debug() {
  return overlay.webContents.executeJavaScript('window.__tookDebug ? window.__tookDebug() : {}');
}

async function until(test, what, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await wait(80);
  }
  throw new Error(`等不到：${what}`);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

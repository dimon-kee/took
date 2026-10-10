'use strict';

/**
 * Times what the hotkey sets off, step by step, and checks the frozen frame is
 * the screen, pixel for pixel:
 *
 *   - grabbing the display with GDI — main does it at the press
 *   - handing the frame to an overlay that is already loaded, up to its first
 *     paint
 *   - an overlay from scratch: process, page, scripts. The spare overlay pays
 *     this ahead of time, so the press does not.
 *
 * For the whole path as it is felt — a real key press to a visible overlay —
 * see tools/check-hotkey.js.
 *
 *   npx electron tools/check-latency.js [rounds]
 */

const { app, screen, ipcMain } = require('electron');

app.setName('Took');
app.on('window-all-closed', () => {});

const { describeDisplays, grabDisplay } = require('../src/main/capture');
const { createOverlayWindow } = require('../src/main/windows');

const ROUNDS = Number(process.argv[2]) || 3;

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  console.log(`屏幕 ${display.bounds.width}x${display.bounds.height} @ ${display.scaleFactor}x\n`);

  const totals = {};
  const add = (k, ms) => (totals[k] = (totals[k] || []).concat(ms));
  let sample = null;

  try {
    for (let round = 0; round < ROUNDS; round++) {
      const shot = describeDisplays().find((s) => s.displayId === display.id);

      let t = performance.now();
      const win = createOverlayWindow(shot);
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
      add('spare', performance.now() - t);

      t = performance.now();
      shot.frame = grabDisplay(shot.displayId);
      add('grab', performance.now() - t);
      if (!shot.frame) throw new Error('GDI 没抓到画面');

      t = performance.now();
      sample = await paint(win, shot);
      add('paint', performance.now() - t);
      win.destroy();
    }
  } catch (err) {
    check('跑完', false, err.message);
    app.exit(1);
    return;
  }

  const grab = median(totals.grab);
  const paintMs = median(totals.paint);
  console.log('按下快捷键之后（毫秒，中位数）');
  console.log(`  ${ms(grab)}  GDI 抓屏`);
  console.log(`  ${ms(paintMs)}  交给已载好的覆盖层，到画好第一帧`);
  console.log(`  ${ms(grab + paintMs)}  合计（再加上显示窗口，就是 check-hotkey 量到的）`);
  console.log('\n提前做好，不在按键之后');
  console.log(`  ${ms(median(totals.spare))}  从零建一个覆盖层：进程、页面、脚本`);

  console.log('\n画面');
  check(
    '覆盖层画出的就是 GDI 抓到的，逐像素一致',
    sample.matched === sample.points,
    `${sample.size}，${sample.matched}/${sample.points} 个采样点一致`
  );
  check('有真实内容，不是黑屏', sample.colors > 8, `${sample.colors} 种颜色`);

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  app.exit(failures ? 1 : 0);
});

function ms(value) {
  return String(Math.round(value)).padStart(6);
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Hand a loaded overlay its frame, wait for its first paint, then read the
 * canvas back on a grid and compare it with the frame main grabbed.
 */
function paint(win, shot) {
  const { width, height, pixels } = shot.frame;

  return new Promise((resolve, reject) => {
    const onReady = async (event) => {
      if (event.sender !== win.webContents) return;
      ipcMain.removeListener('overlay:ready', onReady);

      const points = [];
      for (let gy = 0; gy < 9; gy++) {
        for (let gx = 0; gx < 16; gx++) {
          points.push([Math.floor(((gx + 0.5) * width) / 16), Math.floor(((gy + 0.5) * height) / 9)]);
        }
      }

      try {
        const read = await win.webContents.executeJavaScript(`(() => {
          const c = document.getElementById('base');
          const x = c.getContext('2d');
          return {
            size: c.width + 'x' + c.height,
            rgba: ${JSON.stringify(points)}.map(([px, py]) => Array.from(x.getImageData(px, py, 1, 1).data)),
          };
        })()`);

        let matched = 0;
        const seen = new Set();
        points.forEach(([px, py], i) => {
          const at = (py * width + px) * 4; // BGRX
          const [r, g, b] = read.rgba[i];
          if (r === pixels[at + 2] && g === pixels[at + 1] && b === pixels[at]) matched++;
          seen.add((r >> 4 << 8) | (g >> 4 << 4) | (b >> 4));
        });
        resolve({ size: read.size, points: points.length, matched, colors: seen.size });
      } catch (err) {
        reject(err);
      }
    };
    ipcMain.on('overlay:ready', onReady);

    win.webContents.send('overlay:init', {
      mode: 'capture',
      isPrimary: true,
      cursor: { x: 0, y: 0 },
      shot,
    });
  });
}

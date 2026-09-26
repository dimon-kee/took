'use strict';

/**
 * Measures the hotkey-to-overlay path so it is obvious which step costs what.
 *
 *   npx electron tools/check-latency.js [rounds]
 */

const path = require('path');
const { app, screen, ipcMain, BrowserWindow } = require('electron');

app.setName('Took');
app.on('window-all-closed', () => {});

const screens = require('../src/main/screens');
const { describeDisplays } = require('../src/main/capture');

const ROUNDS = Number(process.argv[2]) || 3;

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  console.log(`屏幕 ${display.bounds.width}x${display.bounds.height} @ ${display.scaleFactor}x\n`);

  const totals = {};
  const add = (k, ms) => (totals[k] = (totals[k] || []).concat(ms));
  let sample = null;

  // Cold: nothing cached, exactly like the very first hotkey after launch.
  let t = Date.now();
  await describeDisplays();
  const cold = Date.now() - t;

  // From here on the source IDs are cached, which is the steady state once
  // warmUp() has run at startup.
  for (let round = 0; round < ROUNDS; round++) {
    t = Date.now();
    const shots = await describeDisplays();
    add('describeDisplays（已缓存）', Date.now() - t);

    t = Date.now();
    sample = await measureWindow(shots[0]);
    add('建窗 + 载入 + 抓帧 + 首帧', Date.now() - t);
  }

  console.log(`  ${String(cold).padStart(6)} ms  describeDisplays（冷启动，需枚举）`);
  Object.entries(totals).forEach(([label, values]) => {
    console.log(`  ${String(median(values)).padStart(6)} ms  ${label}`);
  });

  const warm = median(totals['describeDisplays（已缓存）']) + median(totals['建窗 + 载入 + 抓帧 + 首帧']);
  console.log(`\n启动后预热过，按下快捷键到画面可见：约 ${warm} ms`);

  console.log(
    `\n抓到的画面 ${sample.size}，采样出 ${sample.colors} 种颜色，平均亮度 ${sample.brightness}` +
      `\n  ${sample.colors > 8 ? '有真实内容' : '!! 颜色几乎单一，可能抓到了黑屏'}`
  );

  app.exit(0);
});

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Stands up a real overlay window and waits for it to report first paint. */
function measureWindow(shot) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      x: shot.bounds.x,
      y: shot.bounds.y,
      width: shot.bounds.width,
      height: shot.bounds.height,
      frame: false,
      show: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'src', 'preload', 'overlay.js'),
        contextIsolation: true,
        sandbox: false,
      },
    });

    ipcMain.once('overlay:ready', async () => {
      // Reaching "ready" only proves loadBase resolved — check the canvas has
      // actual content, so a black or empty frame cannot pass as a success.
      const sample = await win.webContents.executeJavaScript(`(() => {
        const c = document.getElementById('base');
        const x = c.getContext('2d', { willReadFrequently: true });
        const d = x.getImageData(0, 0, Math.min(c.width, 600), Math.min(c.height, 400)).data;
        const seen = new Set();
        let sum = 0;
        for (let i = 0; i < d.length; i += 4 * 37) {
          seen.add((d[i] >> 4 << 8) | (d[i + 1] >> 4 << 4) | (d[i + 2] >> 4));
          sum += d[i] + d[i + 1] + d[i + 2];
        }
        return { size: c.width + 'x' + c.height, colors: seen.size,
                 brightness: Math.round(sum / (d.length / (4 * 37)) / 3) };
      })()`);

      win.destroy();
      resolve(sample);
    });

    win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'index.html'));
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('overlay:init', {
        mode: 'capture',
        isPrimary: true,
        cursor: { x: 0, y: 0 },
        shot,
      });
    });
  });
}

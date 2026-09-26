'use strict';

/**
 * Pins down where desktopCapturer spends its time, and compares it against
 * grabbing a single frame out of a getUserMedia desktop stream.
 *
 *   npx electron tools/check-capture-speed.js [rounds]
 */

const path = require('path');
const { app, desktopCapturer, screen, BrowserWindow } = require('electron');

app.setName('Took');
app.on('window-all-closed', () => {});

const ROUNDS = Number(process.argv[2]) || 3;

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const native = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };

  console.log(`屏幕 ${native.width}x${native.height}\n`);

  const results = {};
  const record = (label, ms) => (results[label] = (results[label] || []).concat(ms));

  for (let i = 0; i < ROUNDS; i++) {
    record('getSources 缩略图 1x1（只枚举）', await time(() =>
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    ));

    record('getSources 缩略图 640x360', await time(() =>
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 640, height: 360 } })
    ));

    record('getSources 缩略图 原生分辨率', await time(() =>
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: native })
    ));
  }

  console.log('desktopCapturer（毫秒，中位数）');
  report(results);

  console.log('\ngetUserMedia 抓单帧');
  const stream = await measureStream(display, native);
  console.log(`  ${String(stream.cold).padStart(6)} ms  首次：开流 + 抓第一帧`);
  console.log(`  ${String(stream.warm).padStart(6)} ms  之后：流已经开着，只抓一帧`);

  app.exit(0);
});

async function time(fn) {
  const t = Date.now();
  await fn();
  return Date.now() - t;
}

function report(results) {
  Object.entries(results).forEach(([label, values]) => {
    const sorted = values.slice().sort((a, b) => a - b);
    console.log(`  ${String(sorted[Math.floor(sorted.length / 2)]).padStart(6)} ms  ${label}`);
  });
}

/**
 * The recorder already proves a desktop MediaStream starts quickly; this checks
 * whether a single still frame can come from the same place.
 */
async function measureStream(display, native) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });
  const sourceId = sources[0].id;

  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadFile(path.join(__dirname, 'probe.html'));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const t0 = performance.now();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: ${JSON.stringify(sourceId)},
        minWidth: ${native.width}, maxWidth: ${native.width},
        minHeight: ${native.height}, maxHeight: ${native.height},
      } },
    });

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => video.requestVideoFrameCallback(() => r()));

    const canvas = document.createElement('canvas');
    canvas.width = ${native.width};
    canvas.height = ${native.height};
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    const cold = performance.now() - t0;

    const t1 = performance.now();
    ctx.drawImage(video, 0, 0);
    const warm = performance.now() - t1;

    stream.getTracks().forEach((t) => t.stop());
    return { cold: Math.round(cold), warm: Math.round(warm) };
  })()`);

  win.destroy();
  return result;
}

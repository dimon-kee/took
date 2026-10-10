'use strict';

/**
 * Looks for a black frame when the overlay appears.
 *
 * "It flashes" is hard to argue about by eye, so this films the screen while a
 * real overlay window opens and reports per-frame brightness. The overlay dims
 * the screen on purpose, so a legitimate appearance is a step down to a stable
 * level; a flash is one or two frames far darker than that level.
 *
 *   npx electron tools/check-flash.js
 */

const path = require('path');
const { app, screen, ipcMain, BrowserWindow } = require('electron');

app.setName('Took');
app.on('window-all-closed', () => {});

const screens = require('../src/main/screens');
const { describeDisplays, grabDisplay } = require('../src/main/capture');
const { createOverlayWindow } = require('../src/main/windows');

const FILM_MS = 1400;

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const shots = describeDisplays();
  const shot = shots.find((s) => s.displayId === display.id) || shots[0];
  // The camera films the screen through a stream, and a stream needs the source.
  shot.sourceId = await screens.sourceIdFor(shot.displayId);

  const camera = await startCamera(shot);
  await wait(350); // let the baseline settle

  // As main does at the press: the frame first, then the overlay.
  shot.frame = grabDisplay(shot.displayId);
  const overlay = await openOverlay(shot);
  await wait(FILM_MS);

  const frames = await camera.stop();
  overlay.destroy();

  report(frames);
  app.exit(0);
});

/** Hidden window filming the screen so we can inspect what the user saw. */
async function startCamera(shot) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'probe.html'));

  await win.webContents.executeJavaScript(`(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: ${JSON.stringify(shot.sourceId)},
        maxFrameRate: 60,
      } },
    });

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    const c = document.createElement('canvas');
    c.width = 240; c.height = 135;
    const x = c.getContext('2d', { willReadFrequently: true });

    window.__frames = [];
    const tick = () => {
      if (window.__stop) return;
      x.drawImage(video, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4 * 11) sum += (d[i] + d[i+1] + d[i+2]) / 3;
      window.__frames.push({
        t: Math.round(performance.now()),
        lum: Math.round(sum / (d.length / (4 * 11))),
      });
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);

    window.__cleanup = () => stream.getTracks().forEach((t) => t.stop());
    return true;
  })()`);

  return {
    async stop() {
      const frames = await win.webContents.executeJavaScript(
        'window.__stop = true; window.__cleanup(); window.__frames'
      );
      win.destroy();
      return frames;
    },
  };
}

function openOverlay(shot) {
  return new Promise((resolve) => {
    const win = createOverlayWindow(shot);

    ipcMain.once('overlay:ready', () => {
      win.show();
      win.focus();
      resolve(win);
    });

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

function report(frames) {
  if (frames.length < 8) {
    console.log(`只录到 ${frames.length} 帧，不足以判断`);
    return;
  }

  const t0 = frames[0].t;
  const baseline = median(frames.slice(0, 6).map((f) => f.lum));
  const settled = median(frames.slice(-8).map((f) => f.lum));

  console.log(`录到 ${frames.length} 帧`);
  console.log(`覆盖层出现前亮度 ${baseline}，稳定后 ${settled}（变暗是设计如此）\n`);

  console.log('亮度时间线');
  frames.forEach((f) => {
    const bar = '█'.repeat(Math.max(0, Math.round(f.lum / 4)));
    console.log(`  ${String(f.t - t0).padStart(5)} ms  ${String(f.lum).padStart(3)}  ${bar}`);
  });

  // A flash is a frame far below both the before and after levels.
  const floor = Math.min(baseline, settled) * 0.5;
  const dark = frames.filter((f) => f.lum < floor);

  console.log('');
  if (!dark.length) {
    console.log(`没有低于 ${Math.round(floor)} 的帧 —— 没有黑闪`);
  } else {
    console.log(`!! ${dark.length} 帧低于 ${Math.round(floor)}，出现黑闪:`);
    dark.forEach((f) => console.log(`     ${f.t - t0} ms 处亮度 ${f.lum}`));
  }
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

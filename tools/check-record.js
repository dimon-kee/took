'use strict';

/**
 * End-to-end check of the recorder worker: records a small region for a few
 * seconds in each format and reports what came back.
 *
 *   npx electron tools/check-record.js [seconds]
 */

const fs = require('fs');
const path = require('path');
const { app, ipcMain, desktopCapturer, screen } = require('electron');
const { createRecorderWindow } = require('../src/main/windows');
const cursorTracker = require('../src/main/cursor');

const SECONDS = Number(process.argv[2]) || 3;
const OUT = path.join(app.getPath('temp'), 'took-record-check');

const CASES = [
  {
    name: 'MP4 + 系统声音 + 鼠标效果',
    settings: {
      format: 'mp4',
      speaker: true,
      mic: false,
      camera: false,
      cursor: true,
      mouseHighlight: true,
      clickEffect: true,
      micId: null,
      cameraId: null,
    },
  },
  {
    name: 'GIF + 鼠标高亮',
    settings: {
      format: 'gif',
      speaker: false,
      mic: false,
      camera: false,
      cursor: true,
      mouseHighlight: true,
      clickEffect: false,
      micId: null,
      cameraId: null,
    },
  },
];

// Destroying the recorder window between cases leaves zero windows open, which
// by default quits the app before the next case runs.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`鼠标钩子: ${cursorTracker.clickSupported() ? '可用' : '不可用'}`);

  let failures = 0;
  for (const testCase of CASES) {
    try {
      const result = await run(testCase);
      report(testCase, result);
      if (!result.ok) failures++;
    } catch (err) {
      console.log(`\n${testCase.name}\n  失败: ${err.message}`);
      failures++;
    }
  }

  console.log(`\n输出目录: ${OUT}`);
  app.exit(failures ? 1 : 0);
});

async function run(testCase) {
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });
  const source = sources[0];
  if (!source) throw new Error('没有屏幕源');

  const region = { x: 120, y: 120, width: 480, height: 270 };
  const win = createRecorderWindow();

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('录制超时')), (SECONDS + 25) * 1000);

    ipcMain.handleOnce('recorder:done', (_e, payload) => {
      clearTimeout(timer);
      resolve(payload);
      return true;
    });
    ipcMain.once('recorder:failed', (_e, message) => {
      clearTimeout(timer);
      reject(new Error(message));
    });
  });

  let lastStatus = null;
  const onStatus = (_e, s) => (lastStatus = s);
  ipcMain.on('recorder:status', onStatus);

  const stopCursor = cursorTracker.track((sample) => {
    if (!win.isDestroyed()) win.webContents.send('recorder:cursor', sample);
  });

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('recorder:start', {
      sourceId: source.id,
      settings: testCase.settings,
      region,
      scaleFactor: display.scaleFactor,
      displayBounds: display.bounds,
      displayPixelSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    });

    setTimeout(() => win.webContents.send('recorder:stop'), SECONDS * 1000);
  });

  const payload = await done;

  stopCursor();
  ipcMain.removeListener('recorder:status', onStatus);
  ipcMain.removeAllListeners('recorder:failed');
  if (!win.isDestroyed()) win.destroy();

  const buffer = Buffer.from(payload.buffer);
  const ext = payload.mime.includes('gif') ? 'gif' : payload.mime.includes('mp4') ? 'mp4' : 'webm';
  const file = path.join(OUT, `check-${testCase.settings.format}.${ext}`);
  fs.writeFileSync(file, buffer);

  return {
    ok: buffer.length > 1024 && looksValid(buffer, ext),
    file,
    bytes: buffer.length,
    mime: payload.mime,
    meta: payload.meta,
    status: lastStatus,
    magic: looksValid(buffer, ext),
  };
}

/** Sniff the container so we know the bytes are not just non-empty. */
function looksValid(buf, ext) {
  if (ext === 'gif') return buf.slice(0, 3).toString('ascii') === 'GIF';
  if (ext === 'mp4') return buf.slice(4, 8).toString('ascii') === 'ftyp';
  if (ext === 'webm') return buf[0] === 0x1a && buf[1] === 0x45;
  return false;
}

/**
 * Walk the GIF blocks for frame count and palette spread. A capture that came
 * back black would still have a valid header but almost no distinct colours.
 */
function inspectGif(buf) {
  if (buf.slice(0, 3).toString('ascii') !== 'GIF') return null;

  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const gctSize = packed & 0x80 ? 2 ** ((packed & 0x07) + 1) : 0;

  let p = 13;
  const colors = new Set();
  for (let i = 0; i < gctSize; i++, p += 3) {
    colors.add((buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2]);
  }

  const skipSubBlocks = (at) => {
    while (at < buf.length && buf[at] !== 0) at += buf[at] + 1;
    return at + 1;
  };

  let frames = 0;
  while (p < buf.length) {
    const marker = buf[p];
    if (marker === 0x3b) break; // trailer
    if (marker === 0x21) {
      p = skipSubBlocks(p + 2); // extension
    } else if (marker === 0x2c) {
      frames++;
      const lct = buf[p + 9];
      p += 10;
      if (lct & 0x80) p += 3 * 2 ** ((lct & 0x07) + 1);
      p = skipSubBlocks(p + 1); // skip LZW min code size, then the data
    } else {
      break;
    }
  }

  return { width, height, colors: colors.size, frames };
}

/** MP4 is opaque here, but an empty capture would have a tiny mdat. */
function inspectMp4(buf) {
  const boxes = [];
  let p = 0;
  while (p + 8 <= buf.length && boxes.length < 12) {
    const size = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('ascii');
    if (size < 8) break;
    boxes.push({ type, size });
    p += size;
  }
  const mdat = boxes.find((b) => b.type === 'mdat');
  return { boxes: boxes.map((b) => b.type).join(' '), mdatKB: mdat ? mdat.size / 1024 : 0 };
}

function report(testCase, r) {
  console.log(`\n${testCase.name}`);
  console.log(`  容器      ${r.mime}  ${r.magic ? '(magic OK)' : '(magic 不匹配!)'}`);
  console.log(`  大小      ${(r.bytes / 1024).toFixed(1)} KB`);
  console.log(`  画面      ${r.meta.width}x${r.meta.height}, ${r.meta.seconds}s`);
  console.log(`  末次状态  ${r.status ? `${r.status.state} @ ${r.status.seconds}s` : '无'}`);

  const buf = fs.readFileSync(r.file);
  if (r.file.endsWith('.gif')) {
    const g = inspectGif(buf);
    console.log(`  GIF 结构  ${g.width}x${g.height}, ${g.frames} 帧, 调色板 ${g.colors} 色`);
    if (g.frames < 2) console.log('  !! 帧数过少');
    if (g.colors < 8) console.log('  !! 调色板几乎单色,可能录到了黑屏');
  } else {
    const m = inspectMp4(buf);
    console.log(`  MP4 结构  ${m.boxes}  mdat=${m.mdatKB.toFixed(1)} KB`);
    if (m.mdatKB < 4) console.log('  !! mdat 过小,可能没有画面');
  }

  console.log(`  文件      ${r.file}`);
  console.log(`  结果      ${r.ok ? 'PASS' : 'FAIL'}`);
}

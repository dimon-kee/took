'use strict';

// 语言可用 TOOK_LANG=zh 覆盖，便于比对两种语言的排版。
const LANG = process.env.TOOK_LANG || 'en';

/**
 * Renders the overlay against a synthetic desktop and writes PNGs of each UI
 * state, so the chrome can be eyeballed without triggering a real capture.
 *
 *   npx electron tools/preview-ui.js [outDir]
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createOcr } = require('../src/main/ocr');

// This harness is its own entry point, so none of the app's IPC exists here.
// Stub the channels the overlay reaches for so previews stay quiet.
['overlay:webcam', 'overlay:copy', 'overlay:save', 'overlay:pin', 'overlay:copy-text',
 'overlay:record', 'overlay:open-link'].forEach((channel) => ipcMain.handle(channel, () => false));

// Text mode reads the fake desktop for real; the states in between — still
// reading, failed, nothing found — are held or answered on cue instead, so
// every run shows the same thing.
let ocr = null;
let ocrAnswer = 'real'; // real | hold | fail | empty
ipcMain.on('overlay:ocr-warm', () => ocr.warm());
ipcMain.handle('overlay:ocr', (event, image) => {
  if (ocrAnswer === 'hold') return new Promise(() => {});
  if (ocrAnswer === 'fail') return { error: 'unavailable' };
  if (ocrAnswer === 'empty') return { lines: [] };
  return ocr.recognize(image);
});

// Windows tells Chromium when other windows cover this one, and it stops
// painting; a capture then hands back whatever was last drawn.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const OUT = process.argv[2] || path.join(app.getPath('temp'), 'took-preview');
const W = 1280;
const H = 720;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  ocr = createOcr({
    modelsDir: path.join(__dirname, '..', 'assets', 'ocr'),
    idleMs: 60000,
    timeoutMs: 30000,
    threads: 4,
  });

  const win = new BrowserWindow({
    width: W,
    height: H,
    // A hidden window stops producing frames, so capturePage would hand back a
    // stale composite. Keep it on screen (but unfocused) while we shoot.
    show: true,
    frame: false,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'overlay.js'),
      additionalArguments: [`--took-lang=${LANG}`],
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (e) => {
    console.log(`  [renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'index.html'));

  // Listener exceptions never reach dispatchEvent's caller — surface them here.
  await win.webContents.executeJavaScript(`
    window.addEventListener('error', (e) =>
      console.error('UNCAUGHT ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
    true;
  `);

  const dataURL = await win.webContents.executeJavaScript(fakeDesktop(W, H));

  // The overlay grabs its own frame from a desktop stream now. With no real
  // source to hand it, let it fail over to the PNG path and serve the fake
  // desktop from there.
  ipcMain.handle('overlay:fallback-shot', () => dataURL);

  win.webContents.send('overlay:init', {
    mode: 'capture',
    isPrimary: true,
    cursor: { x: 420, y: 300 },
    shot: {
      displayId: 1,
      sourceId: null,
      bounds: { x: 0, y: 0, width: W, height: H },
      // Pretend there is a taskbar, so toolbar clamping gets exercised.
      workArea: { x: 0, y: 0, width: W, height: H - 48 },
      scaleFactor: 1,
      pixelSize: { width: W, height: H },
    },
  });

  await wait(700);

  // Opens with the whole display already framed, awaiting a click.
  await shoot(win, 'a-preselect-fullscreen', `
    fire('mousemove', 420, 300);
  `);

  // A click with a little jitter must still read as "accept the default", not
  // collapse the frame to a speck.
  await shoot(win, 'a2-click-confirms', `
    fire('mousedown', 420, 300);
    fire('mousemove', 421, 301);
    fire('mouseup', 421, 301);
  `);

  await shoot(win, 'a3-back-to-idle', `
    menu(420, 300);
    fire('mousemove', 420, 300);
  `);

  await shoot(win, 'b-record-idle', `
    mode('record');
    fire('mousemove', 420, 300);
  `);

  await shoot(win, 'c-dragging', `
    mode('capture');
    fire('mousedown', 300, 180);
    fire('mousemove', 600, 330);
    fire('mousemove', 880, 470);
  `);

  await shoot(win, 'd-selection-ready', `
    fire('mouseup', 880, 470);
  `);

  await shoot(win, 'e-record-panel-mp4', `
    mode('record');
  `);

  await shoot(win, 'f-record-panel-gif', `
    q('.rec-radio[data-format="gif"]');
  `);

  await shoot(win, 'g-cursor-menu', `
    q('.rec-radio[data-format="mp4"]');
    q('.dev[data-key="mic"] .dev-icon');
    q('.dev[data-key="cursor"] .dev-caret');
  `);

  await shoot(win, 'h-tool-rect-subbar', `
    mode('capture');
    click('rect');
  `);

  // The ⋮⋮ handle should pin the stack wherever it is dropped.
  await shoot(win, 'j-toolbar-dragged', `
    const grip = document.querySelector('#toolbar .grip');
    const r = grip.getBoundingClientRect();
    grip.dispatchEvent(new MouseEvent('mousedown',
      { clientX: r.left + 5, clientY: r.top + 8, button: 0, bubbles: true }));
    fire('mousemove', 300, 560);
    fire('mouseup', 300, 560);
  `);

  await shoot(win, 'i-annotated', `
    fire('mousedown', 360, 230);
    fire('mousemove', 560, 320);
    fire('mouseup', 560, 320);
    click('arrow');
    fire('mousedown', 620, 420);
    fire('mousemove', 790, 260);
    fire('mouseup', 790, 260);
    click('mosaic');
    fire('mousedown', 330, 380);
    fire('mousemove', 520, 430);
    fire('mouseup', 520, 430);
    click('marker');
    fire('mousedown', 360, 300);
    fire('mousemove', 480, 302);
    fire('mousemove', 600, 300);
    fire('mouseup', 600, 300);
    click('marker');
  `);

  await shoot(win, 'k-long-card', `
    mode('long');
  `);

  // --- Text mode, over the lines at the foot of the fake document ----------

  await shoot(win, 'l-text-idle', `
    menu(420, 300);
    mode('text');
    fire('mousemove', 420, 300);
  `);

  ocrAnswer = 'hold';
  await shoot(win, 'm-text-reading', `
    fire('mousedown', 170, 512);
    fire('mousemove', 500, 580);
    fire('mousemove', 760, 628);
    fire('mouseup', 760, 628);
  `);

  // Back through Capture: entering Text mode reads the region again.
  ocrAnswer = 'real';
  await shoot(win, 'n-text-result', `
    mode('capture');
    mode('text');
  `, () => win.webContents.executeJavaScript('window.__tookDebug().ocr.state !== "reading"'));

  // The pointer on the first link floats Open above it; the text has the caret.
  await shoot(win, 'o-text-link-hover', `
    const text = document.querySelector('.tp-text');
    text.focus();
    const link = [...CSS.highlights.get('took-link')][0].getBoundingClientRect();
    text.dispatchEvent(new MouseEvent('mousemove', {
      clientX: link.left + link.width / 2, clientY: link.top + link.height / 2, bubbles: true,
    }));
  `);

  ocrAnswer = 'fail';
  await shoot(win, 'p-text-failed', `
    mode('capture');
    mode('text');
  `);

  ocrAnswer = 'empty';
  await shoot(win, 'q-text-empty', `
    q('.tp-retry');
  `);

  // Capture's toolbar, with 提取文字 beside the QR button.
  await shoot(win, 'r-toolbar-ocr', `
    mode('capture');
  `);

  ocr.stop();
  console.log(`\n预览图写在: ${OUT}`);
  app.exit(0);
});

/** Run `script` in the overlay, wait for `settled()` if given, then capture. */
async function shoot(win, name, script, settled) {
  await win.webContents.executeJavaScript(`(() => {
    const fire = (type, x, y) => document.dispatchEvent(
      new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true })
    );
    const click = (id) => document.querySelector('.tool[data-id="' + id + '"]').click();
    const mode = (m) => document.querySelector('.mode[data-mode="' + m + '"]').click();
    const q = (sel) => document.querySelector(sel).click();
    const menu = (x, y) => document.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: x, clientY: y, button: 2, bubbles: true })
    );
    ${script}
    return true;
  })()`);

  // Two frames of slack so the rAF-batched canvas redraw lands before capture.
  await wait(500);
  if (settled) {
    for (let tries = 0; tries < 100 && !(await settled()); tries++) await wait(100);
    await wait(300); // and for that change to reach the screen
  }

  const dump = await win.webContents.executeJavaScript(
    `(() => {
      const active = document.querySelector('.tool.active');
      const d = window.__tookDebug ? window.__tookDebug() : {};
      return {
        tool: active ? active.dataset.id : null,
        shapes: d.shapes,
        mode: d.mode,
        ocr: d.ocr && d.mode === 'text' ? d.ocr.state + ' ' + JSON.stringify(d.ocr.text) : null,
        bar: !document.getElementById('modebar').classList.contains('hidden'),
        toolbar: describeBar(document.getElementById('toolbar')),
      };

      function describeBar(el) {
        if (el.classList.contains('hidden')) return '隐藏';
        const r = el.getBoundingClientRect();
        const onScreen =
          r.top >= 0 && r.left >= 0 &&
          r.bottom <= window.innerHeight && r.right <= window.innerWidth;
        return Math.round(r.left) + ',' + Math.round(r.top) +
          ' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
          (onScreen ? ' 可见' : ' 超出屏幕!');
      }
    })()`
  );
  console.log(
    `      mode=${dump.mode} tool=${dump.tool} shapes=${dump.shapes}` +
      ` modebar=${dump.bar ? '显示' : '隐藏'} 工具栏=${dump.toolbar}` +
      (dump.ocr ? `\n      文字=${dump.ocr}` : '')
  );

  // A change that came back over IPC — a recognition result — can sit
  // unpainted while nothing else is moving; ask for a fresh frame first.
  win.webContents.invalidate();
  await wait(150);
  const image = await win.webContents.capturePage();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`  ${name}.png`);
}

/** A stand-in "desktop" so the overlay has something believable underneath. */
function fakeDesktop(w, h) {
  return `(() => {
    const c = document.createElement('canvas');
    c.width = ${w}; c.height = ${h};
    const x = c.getContext('2d');

    x.fillStyle = '#e9edf4'; x.fillRect(0, 0, ${w}, ${h});
    x.fillStyle = '#2b5797'; x.fillRect(0, 0, ${w}, 52);
    x.fillStyle = '#ffffff';
    x.font = '15px sans-serif';
    x.fillText('文稿 1 — 编辑器', 20, 32);

    x.fillStyle = '#f7f8fa'; x.fillRect(0, 52, ${w}, 46);
    for (let i = 0; i < 14; i++) {
      x.fillStyle = ['#d0d5dd', '#b9c0cc'][i % 2];
      x.fillRect(20 + i * 42, 66, 30, 18);
    }

    x.fillStyle = '#ffffff'; x.fillRect(140, 120, ${w} - 280, ${h} - 190);
    x.strokeStyle = '#cdd3dd'; x.strokeRect(140, 120, ${w} - 280, ${h} - 190);

    x.fillStyle = '#3a3f4a'; x.font = '19px sans-serif';
    x.fillText('区域截图与标注', 180, 170);
    x.fillStyle = '#7b8291'; x.font = '14px sans-serif';
    for (let i = 0; i < 12; i++) {
      x.fillRect(180, 200 + i * 26, 240 + ((i * 97) % 480), 9);
    }

    // A few real lines for Text mode to read: Chinese, English, a link, an address.
    x.fillStyle = '#3a3f4a'; x.font = '16px "Microsoft YaHei UI", sans-serif';
    x.fillText('会议时间：10月18日 14:00，地点：3F 会议室 B', 180, 540);
    x.fillText('资料：https://example.com/agenda  联系 sales@example.com', 180, 570);
    x.fillText('Took 0.1.6 — text extraction preview', 180, 600);

    x.fillStyle = '#ff7a45'; x.fillRect(620, 430, 160, 90);
    x.fillStyle = '#36cfc9'; x.beginPath(); x.arc(860, 470, 46, 0, Math.PI * 2); x.fill();

    return c.toDataURL('image/png');
  })()`;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

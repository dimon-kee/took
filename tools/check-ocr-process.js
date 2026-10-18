'use strict';

/**
 * Runs text recognition the way Took does — in its own process, through
 * src/main/ocr.js — and checks that process's life: it starts when warmed,
 * reads a rendered line of text, says how much memory it holds, goes away by
 * itself once idle, and that a crash, a timeout or missing models each come
 * back as a reason rather than a hang, with the next request starting afresh.
 *
 *   npx electron tools/check-ocr-process.js
 */

const path = require('path');
const { app, BrowserWindow } = require('electron');

// Anything thrown outside the checks would otherwise surface as Electron's
// modal error box, on whoever's screen this runs.
process.on('uncaughtException', (err) => {
  console.error(err.stack);
  app.exit(1);
});

const ROOT = path.join(__dirname, '..');
const MODELS = path.join(ROOT, 'assets', 'ocr');
const IDLE_MS = 3000;

const TEXT = ['Took 0.1.6 https://example.com/a', '你好，文字提取 2026-10-18'];

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

app.on('window-all-closed', () => {});

let createOcr;

app.whenReady().then(async () => {
  try {
    ({ createOcr } = require('../src/main/ocr'));
    const image = await render(TEXT);
    await lifecycle(image);
    await crash(image);
    await timeout(image);
    await missingModels(image);
  } catch (err) {
    check('没有意外的异常', false, err.stack);
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  app.exit(failures ? 1 : 0);
});

async function lifecycle(image) {
  console.log('启动、识别、闲置退出');
  const ocr = createOcr({ modelsDir: MODELS, idleMs: IDLE_MS, timeoutMs: 30000, threads: 4 });

  ocr.warm();
  const started = await waitFor(() => worker(), 5000);
  check('预热就启动识别进程', Boolean(started));

  const t = Date.now();
  const result = await ocr.recognize(image);
  const ms = Date.now() - t;
  check('认出渲染的两行字', JSON.stringify(result.lines) === JSON.stringify(TEXT), `${JSON.stringify(result)}，${ms} ms`);

  const proc = worker();
  const mb = proc ? Math.round(proc.memory.workingSetSize / 1024) : NaN;
  console.log(`        识别进程占用 ${mb} MB`);

  const gone = await waitFor(() => !worker(), IDLE_MS + 3000);
  check(`闲置 ${IDLE_MS / 1000} 秒后自己退出`, gone);

  const again = await ocr.recognize(image);
  check('退出后再识别，重新启动', JSON.stringify(again.lines) === JSON.stringify(TEXT), JSON.stringify(again));
  ocr.stop();
  check('stop() 结束识别进程', await waitFor(() => !worker(), 3000));
}

async function crash(image) {
  console.log('崩溃');
  const ocr = createOcr({ modelsDir: MODELS, idleMs: 60000, timeoutMs: 30000, threads: 4 });
  ocr.warm();
  await waitFor(() => worker(), 5000);
  const early = ocr.recognize(image);
  process.kill(worker().pid);
  const whileLoading = await early;
  check('加载模型时进程没了，报告 crashed', whileLoading.error === 'crashed', JSON.stringify(whileLoading));

  await ocr.recognize(image); // loaded and warm from here on
  const mid = ocr.recognize(image);
  process.kill((await waitFor(() => worker(), 3000)).pid);
  const whileReading = await mid;
  check('识别中进程没了，报告 crashed', whileReading.error === 'crashed', JSON.stringify(whileReading));

  const next = await ocr.recognize(image);
  check('下一次重新启动并认出来', JSON.stringify(next.lines) === JSON.stringify(TEXT), JSON.stringify(next));
  ocr.stop();
  await waitFor(() => !worker(), 3000);
}

async function timeout(image) {
  console.log('超时');
  const ocr = createOcr({ modelsDir: MODELS, idleMs: 60000, timeoutMs: 1, threads: 4 });
  const result = await ocr.recognize(image);
  check('超时报告 timeout', result.error === 'timeout', JSON.stringify(result));
  check('超时的进程被结束', await waitFor(() => !worker(), 3000));
}

async function missingModels(image) {
  console.log('没有模型');
  const ocr = createOcr({ modelsDir: path.join(ROOT, 'no-such-dir'), idleMs: 60000, timeoutMs: 30000, threads: 4 });
  const result = await ocr.recognize(image);
  check('报告 unavailable', result.error === 'unavailable', JSON.stringify(result));
  ocr.stop();
  await waitFor(() => !worker(), 3000);
}

/**
 * The OCR utility process, from Electron's own list of this app's processes.
 * The serviceName given to fork() is listed as its `name`.
 */
function worker() {
  return app.getAppMetrics().find((p) => p.type === 'Utility' && p.name === 'Took OCR') || null;
}

async function waitFor(test, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const value = test();
    if (value) return value;
    if (Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Lines of text drawn on a canvas, as the RGBA pixels the overlay would send. */
async function render(lines) {
  const win = new BrowserWindow({ show: false, width: 800, height: 200 });
  await win.loadURL('data:text/html,<body></body>');
  const pixels = await win.webContents.executeJavaScript(`(() => {
    const lines = ${JSON.stringify(lines)};
    const c = document.createElement('canvas');
    c.width = 640; c.height = 40 + lines.length * 44;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#222'; g.font = '24px "Microsoft YaHei UI", "Segoe UI", sans-serif';
    lines.forEach((l, i) => g.fillText(l, 20, 48 + i * 44));
    const d = g.getImageData(0, 0, c.width, c.height);
    return { width: d.width, height: d.height, data: Array.from(d.data) };
  })()`);
  win.destroy();
  return { width: pixels.width, height: pixels.height, data: Uint8Array.from(pixels.data) };
}

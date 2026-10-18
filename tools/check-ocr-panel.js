'use strict';

/**
 * Works the recognised-text panel in the real overlay, recording what it asks
 * main to do: Enter copies everything and finishes — but not the Enter that
 * picks an input method's candidate, nor Shift+Enter; Ctrl+C copies what is
 * selected; Esc and ✕ cancel; editing finds the links again; the Open button
 * that floats over a link opens it.
 *
 *   npx electron tools/check-ocr-panel.js
 */

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (err) => {
  console.error(err.stack);
  app.exit(1);
});
app.on('window-all-closed', () => {});

const W = 1280;
const H = 720;
const LINES = ['会议时间：10月18日 14:00', '资料：https://example.com/agenda 联系 sales@example.com'];

const calls = [];
ipcMain.handle('overlay:ocr', () => ({ lines: LINES }));
ipcMain.on('overlay:ocr-warm', () => {});
ipcMain.handle('overlay:copy-text', (event, text, options) => calls.push(['copy', text, options && options.close]));
ipcMain.handle('overlay:open-link', (event, href) => calls.push(['open', href]));
ipcMain.on('overlay:cancel', () => calls.push(['cancel']));
ipcMain.on('overlay:ready', () => {});
// No desktop to stream from or camera to place here; the overlay falls back.
ipcMain.handle('overlay:source-id', () => null);
ipcMain.handle('overlay:webcam', () => false);
['overlay:claim', 'overlay:release'].forEach((c) => ipcMain.on(c, () => {}));

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'overlay.js'),
      additionalArguments: ['--took-lang=zh'],
      contextIsolation: true,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'index.html'));
  const page = (js) => win.webContents.executeJavaScript(js);

  // A blank screen is enough: what is "recognised" comes from the stub above.
  const shot = await page(`(() => {
    const c = document.createElement('canvas'); c.width = ${W}; c.height = ${H};
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, ${W}, ${H});
    return c.toDataURL('image/png');
  })()`);
  ipcMain.handle('overlay:fallback-shot', () => shot);
  win.webContents.send('overlay:init', {
    mode: 'text',
    isPrimary: true,
    cursor: { x: 300, y: 300 },
    shot: {
      displayId: 1,
      sourceId: null,
      bounds: { x: 0, y: 0, width: W, height: H },
      workArea: { x: 0, y: 0, width: W, height: H },
      scaleFactor: 1,
      pixelSize: { width: W, height: H },
    },
  });
  await wait(800);

  // Drag a region; letting go reads it.
  await page(`(() => {
    const fire = (type, x, y) => document.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    fire('mousedown', 200, 200); fire('mousemove', 500, 300); fire('mousemove', 700, 400); fire('mouseup', 700, 400);
  })()`);
  await wait(300);

  const key = (init) =>
    page(`document.querySelector('.tp-text').dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({
      bubbles: true,
      cancelable: true,
      ...init,
    })}))`);
  const take = () => calls.splice(0);

  console.log('键盘');
  check('识别结果进了面板', (await page(`document.querySelector('.tp-text').textContent`)) === LINES.join('\n'));

  await key({ key: 'Enter', isComposing: true });
  check('输入法选词的 Enter 不算', take().length === 0);

  await key({ key: 'Enter', shiftKey: true });
  check('Shift+Enter 是换行，不复制', take().length === 0);

  await key({ key: 'Enter' });
  check('Enter 复制全部并结束', JSON.stringify(take()) === JSON.stringify([['copy', LINES.join('\n'), true]]));

  await page(`(() => {
    const node = document.querySelector('.tp-text').firstChild;
    const r = document.createRange(); r.setStart(node, 0); r.setEnd(node, 4);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  })()`);
  await key({ key: 'c', ctrlKey: true });
  check('Ctrl+C 只复制选中的部分', JSON.stringify(take()) === JSON.stringify([['copy', '会议时间', true]]));

  await key({ key: 'Escape' });
  check('Esc 取消', JSON.stringify(take()) === JSON.stringify([['cancel']]));

  await page(`document.querySelector('.tp-close').click()`);
  check('✕ 取消', JSON.stringify(take()) === JSON.stringify([['cancel']]));

  console.log('链接');
  const links = () => page(`[...CSS.highlights.get('took-link')].map((r) => r.toString())`);
  check('认出的链接都标出来了', JSON.stringify(await links()) === JSON.stringify(['https://example.com/agenda', 'sales@example.com']), JSON.stringify(await links()));

  // Typing at the end, as a person would, through the editing commands.
  await page(`(() => {
    const t = document.querySelector('.tp-text'); t.focus();
    const s = getSelection(); s.selectAllChildren(t); s.collapseToEnd();
    document.execCommand('insertText', false, ' 官网 www.took.app');
  })()`);
  check('改了文字，链接重新找', (await links()).includes('www.took.app'), JSON.stringify(await links()));
  check('改过的文字照样能复制', (await page(`window.__tookDebug().ocr.text`)).endsWith('官网 www.took.app'));

  await page(`(() => {
    const r = [...CSS.highlights.get('took-link')][0].getBoundingClientRect();
    document.querySelector('.tp-text').dispatchEvent(new MouseEvent('mousemove', {
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
  })()`);
  const shown = await page(`!document.querySelector('.tp-open').classList.contains('hidden')`);
  check('指着链接，浮出「打开」', shown);
  await page(`document.querySelector('.tp-open').click()`);
  check('点「打开」打开那个链接', JSON.stringify(take()) === JSON.stringify([['open', 'https://example.com/agenda']]));

  await page(`document.querySelector('.tp-text').dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))`);
  await wait(400);
  check('指针离开后「打开」收起来', await page(`document.querySelector('.tp-open').classList.contains('hidden')`));

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  app.exit(failures ? 1 : 0);
});

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

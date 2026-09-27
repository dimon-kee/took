'use strict';

/**
 * Copies through src/main/clipboard.js for real and reads the result back from
 * a separate process (.NET, via PowerShell) — i.e. what an app pasting it
 * actually gets. Also scans src/ for the synchronous clipboard helpers
 * Electron 44 removed: a call to one throws at runtime, and nothing else
 * notices until someone clicks the button behind it.
 *
 * The clipboard's current contents are put back afterwards.
 *
 *   npx electron tools/check-clipboard.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, clipboard, ClipboardItem, nativeImage } = require('electron');
const { pngFromDataURL, copyImage, copyFile, copyText } = require('../src/main/clipboard');

const ROOT = path.join(__dirname, '..');

const REMOVED = [
  'availableFormats', 'readBookmark', 'writeBookmark', 'readBuffer', 'writeBuffer',
  'readFindText', 'writeFindText', 'readHTML', 'writeHTML', 'readImage', 'writeImage',
  'readRTF', 'writeRTF',
];

// Reports what any other program sees on the clipboard right now.
const INSPECT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$c = [System.Windows.Forms.Clipboard]
$r = @{ formats = @($c::GetDataObject().GetFormats()); image = $null; files = @() }
if ($c::ContainsImage()) { $i = $c::GetImage(); $r.image = '' + $i.Width + 'x' + $i.Height }
if ($c::ContainsFileDropList()) { $r.files = @($c::GetFileDropList()) }
$r | ConvertTo-Json -Compress
`;

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

app.whenReady().then(async () => {
  scanForRemovedCalls();

  if (process.platform === 'win32') {
    const saved = await snapshot();
    try {
      await roundTrip();
    } catch (err) {
      check('写剪贴板', false, err.message);
    } finally {
      await restore(saved);
    }
  }

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  app.exit(failures ? 1 : 0);
});

function scanForRemovedCalls() {
  console.log('Electron 44 删掉的同步接口');
  const pattern = new RegExp(`\\bclipboard\\.(${REMOVED.join('|')})\\b`);
  const hits = [];

  for (const file of walk(path.join(ROOT, 'src'))) {
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
  }

  check('src/ 里没有调用', hits.length === 0, hits.join(', '));
}

async function roundTrip() {
  console.log('\n实际写入，再从另一个进程读回来');

  const png = solid(320, 200);
  const dataURL = `data:image/png;base64,${png.toString('base64')}`;
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'took-clipboard-check-'));
  const file = path.join(dir, '录屏 check.gif');
  fs.writeFileSync(file, png);

  try {
    await copyImage(pngFromDataURL(dataURL));
    let seen = inspect();
    check('截图：别的程序能读到图片', seen.image === '320x200', seen.image || seen.formats.join(', '));

    await copyFile(file);
    seen = inspect();
    check('录屏：粘贴出来是文件', seen.files.length === 1 && seen.files[0] === file, seen.files.join(';'));
    check('录屏：带 CF_HDROP', seen.formats.includes('FileDrop'), seen.formats.join(', '));

    const text = 'took ✓ 二维码 https://example.com';
    await copyText(text);
    check('文字', (await clipboard.readText()) === text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function inspect() {
  const out = execFileSync('powershell', ['-NoProfile', '-STA', '-Command', INSPECT], { encoding: 'utf8' });
  const r = JSON.parse(out.trim());
  return { formats: [].concat(r.formats || []), image: r.image, files: [].concat(r.files || []) };
}

/** A flat-colour PNG of the given size. */
function solid(width, height) {
  const raw = Buffer.alloc(width * height * 4, 0x80);
  return nativeImage.createFromBuffer(raw, { width, height }).toPNG();
}

// Items from clipboard.read() fetch their data lazily, from whatever is on the
// clipboard by then — so pull every type out now, before the checks overwrite it.
async function snapshot() {
  const items = [];
  for (const item of await clipboard.read()) {
    const data = {};
    for (const type of item.types) {
      try {
        data[type] = await item.getType(type);
      } catch {
        // advertised but not readable; nothing to put back
      }
    }
    if (Object.keys(data).length) items.push(new ClipboardItem(data));
  }
  return items;
}

async function restore(items) {
  try {
    if (items.length) await clipboard.write(items);
    else await clipboard.clear();
  } catch (err) {
    console.log(`\n  !!  没能还原剪贴板原来的内容: ${err.message}`);
  }
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

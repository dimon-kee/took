'use strict';

/**
 * Checks text recognition in the packaged app that `task dist` left in
 * dist/win-unpacked: the runtime and models are there and unpacked from the
 * asar (onnxruntime opens them itself and cannot look inside it), nothing it
 * does not need came along, every DLL it imports beyond Windows' own sits
 * beside it or beside Took.exe, and the worker — run from inside app.asar, as
 * the app runs it — reads a rendered line.
 *
 *   npx electron tools/check-ocr-package.js [dist/win-unpacked]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, utilityProcess } = require('electron');

process.on('uncaughtException', (err) => {
  console.error(err.stack);
  app.exit(1);
});
app.on('window-all-closed', () => {});

const ROOT = path.join(__dirname, '..');
const APP = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('-')) || path.join(ROOT, 'dist', 'win-unpacked'));
const RESOURCES = path.join(APP, 'resources');
const UNPACKED = path.join(RESOURCES, 'app.asar.unpacked');
const BIN = path.join(UNPACKED, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64');
const MODELS = path.join(UNPACKED, 'assets', 'ocr');

// Imports Windows always has. Anything else must come with the app.
const SYSTEM = /^(api-ms-win-|ext-ms-)|^(kernel32|user32|advapi32|shell32|ole32|oleaut32|setupapi|dbghelp|ws2_32|bcrypt|ntdll|gdi32|d3d12|dxgi|shlwapi|version|psapi|crypt32|secur32|winmm|iphlpapi|rpcrt4|userenv|dwmapi|uxtheme|imm32|comctl32|comdlg32|winspool\.drv|node\.exe)(\.dll)?$/i;

// Latin only: CI's Windows Server may have no CJK font to draw with, and this
// is about the packaging, not about reading Chinese — check:ocr covers that.
const TEXT = 'Took text recognition https://example.com/a';

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

app.whenReady().then(async () => {
  console.log(`打包版: ${APP}\n`);
  if (!fs.existsSync(path.join(APP, 'Took.exe'))) {
    check('找到打包版', false, '先跑 task dist');
  } else {
    files();
    loadedFrom(imports());
    await recognise();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  app.exit(failures ? 1 : 0);
});

function files() {
  console.log('文件');
  const present = (p) => fs.existsSync(p);
  check('识别引擎解包在 asar 外', ['onnxruntime.dll', 'onnxruntime_binding.node'].every((f) => present(path.join(BIN, f))));
  check(
    '模型和字表解包在 asar 外',
    ['PP-OCRv6_det_tiny.onnx', 'PP-OCRv6_rec_small.onnx', 'PP-OCRv6_rec_small.keys.json'].every((f) => present(path.join(MODELS, f)))
  );

  const unwanted = [
    path.join(BIN, 'DirectML.dll'),
    path.join(BIN, 'dxcompiler.dll'),
    path.join(BIN, '..', 'arm64'),
    path.join(BIN, '..', '..', 'linux'),
    path.join(BIN, '..', '..', 'darwin'),
  ].filter(present);
  check('没带用不上的东西（DirectML、别的平台）', unwanted.length === 0, unwanted.map((p) => path.relative(APP, p)).join(', '));

  const size = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
      const p = path.join(dir, e.name);
      return sum + (e.isDirectory() ? size(p) : fs.statSync(p).size);
    }, 0);
  console.log(`        onnxruntime-node 解包后 ${(size(path.join(UNPACKED, 'node_modules', 'onnxruntime-node')) / 2 ** 20).toFixed(1)} MB`);
}

/**
 * Every DLL the runtime imports beyond Windows' own must sit beside it. Not
 * beside Took.exe: Node loads native modules with LOAD_WITH_ALTERED_SEARCH_PATH,
 * under which Windows looks in the module's own folder and then System32 —
 * the application's folder is never searched.
 */
function imports() {
  console.log('依赖的 DLL');
  const all = new Set();
  for (const file of ['onnxruntime_binding.node', 'onnxruntime.dll']) {
    // Delay-loaded imports are only looked for when first used — DirectML.dll
    // for GPU inference, which Took never asks for, so it is left out.
    const needed = peImports(path.join(BIN, file)).imports.filter((dll) => !SYSTEM.test(dll));
    const missing = needed.filter((dll) => !fs.existsSync(path.join(BIN, dll)));
    check(`${file} 要的都在它旁边：${needed.join(', ')}`, missing.length === 0, missing.length ? `缺 ${missing.join(', ')}` : '');
    needed.forEach((dll) => all.add(dll.toLowerCase()));
  }
  return [...all].filter((dll) => !dll.startsWith('onnxruntime'));
}

/**
 * Where the packaged Took.exe actually loads those DLLs from, run as Node:
 * loading onnxruntime through app.asar as the app does, then listing the
 * process's own modules. A copy in System32 must not be what gets used — a
 * clean Windows has none there.
 */
function loadedFrom(dlls) {
  console.log('实际从哪里加载');
  const script = path.join(os.tmpdir(), `took-ocr-loaded-${process.pid}.js`);
  fs.writeFileSync(
    script,
    `
    const path = require('path');
    const resources = path.join(path.dirname(process.execPath), 'resources');
    const asar = path.join(resources, 'app.asar');
    (async () => {
      const ort = require(path.join(asar, 'node_modules', 'onnxruntime-node'));
      await ort.InferenceSession.create(path.join(resources, 'app.asar.unpacked', 'assets', 'ocr', 'PP-OCRv6_det_tiny.onnx'));
      const koffi = require(path.join(asar, 'node_modules', 'koffi'));
      const psapi = koffi.load('psapi.dll');
      const current = koffi.load('kernel32.dll').func('void* __stdcall GetCurrentProcess()');
      const list = psapi.func('bool __stdcall EnumProcessModulesEx(void*, _Out_ uint64_t*, uint32, _Out_ uint32_t*, uint32)');
      const name = psapi.func('uint32 __stdcall GetModuleFileNameExW(void*, uint64, _Out_ uint16_t*, uint32)');
      const mods = new BigUint64Array(4096);
      const needed = new Uint32Array(1);
      list(current(), mods, mods.byteLength, needed, 3);
      const buf = new Uint16Array(1024);
      const files = [];
      for (let i = 0; i < needed[0] / 8; i++) {
        files.push(String.fromCharCode(...buf.subarray(0, name(current(), mods[i], buf, buf.length))));
      }
      console.log(JSON.stringify(files));
    })().catch((err) => { console.error(err.stack); process.exit(1); });`
  );

  const run = spawnSync(path.join(APP, 'Took.exe'), [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60000,
  });
  fs.rmSync(script, { force: true });

  let files = [];
  try {
    files = JSON.parse(run.stdout.trim().split('\n').pop());
  } catch {
    check('打包版的 Took.exe 能加载识别引擎', false, (run.stderr || run.error || '').toString().trim());
    return;
  }
  const bin = BIN.toLowerCase();
  for (const dll of dlls) {
    const file = files.find((f) => path.basename(f).toLowerCase() === dll);
    const where = file ? path.dirname(file.replace(/^\\\\\?\\/, '')).toLowerCase() : null;
    check(`${dll} 用的是自带的那份`, where === bin, file || '没加载');
  }
}

async function recognise() {
  console.log('从 app.asar 里跑识别');
  const image = await render(TEXT);
  const worker = path.join(RESOURCES, 'app.asar', 'src', 'ocr', 'worker.js');
  const proc = utilityProcess.fork(worker, [], { serviceName: 'Took OCR' });

  const reply = (type) =>
    new Promise((resolve) => {
      const onMessage = (msg) => {
        if (msg.type === type || msg.type === 'failed' || msg.type === 'error') {
          proc.off('message', onMessage);
          resolve(msg);
        }
      };
      proc.on('message', onMessage);
      proc.once('exit', (code) => resolve({ type: 'exit', code }));
    });

  proc.postMessage({ type: 'init', modelsDir: MODELS, threads: 4 });
  const ready = await reply('ready');
  check('识别进程加载了模型', ready.type === 'ready', ready.message || (ready.code !== undefined ? `进程退出 ${ready.code}` : ''));

  if (ready.type === 'ready') {
    proc.postMessage({ type: 'recognize', id: 1, image });
    const result = await reply('result');
    check('认出渲染的那行字', result.type === 'result' && result.lines.join('\n') === TEXT, JSON.stringify(result.lines || result));
  }
  proc.kill();
}

/** The DLLs a PE file imports: `{ imports, delayed }`. */
function peImports(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  const sections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const dirs = opt + (buf.readUInt16LE(opt) === 0x20b ? 112 : 96);

  const table = [];
  for (let i = 0; i < sections; i++) {
    const s = opt + optSize + i * 40;
    table.push({ va: buf.readUInt32LE(s + 12), size: buf.readUInt32LE(s + 8), raw: buf.readUInt32LE(s + 20) });
  }
  const offset = (rva) => {
    const s = table.find((x) => rva >= x.va && rva < x.va + x.size);
    return s ? rva - s.va + s.raw : -1;
  };
  const name = (rva) => {
    const at = offset(rva);
    return buf.toString('latin1', at, buf.indexOf(0, at));
  };
  const walk = (rva, stride, nameAt) => {
    const out = [];
    for (let at = rva ? offset(rva) : -1; at >= 0; at += stride) {
      const n = buf.readUInt32LE(at + nameAt);
      if (!n) break;
      out.push(name(n));
    }
    return out;
  };
  // Directory entries 1 (imports, 20-byte descriptors) and 13 (delay-loaded, 32).
  return {
    imports: walk(buf.readUInt32LE(dirs + 8), 20, 12),
    delayed: walk(buf.readUInt32LE(dirs + 13 * 8), 32, 4),
  };
}

/** A line of text drawn on a canvas, as the RGBA pixels the overlay would send. */
async function render(text) {
  const win = new BrowserWindow({ show: false, width: 800, height: 200 });
  await win.loadURL('data:text/html,<body></body>');
  const pixels = await win.webContents.executeJavaScript(`(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 80;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#222'; g.font = '24px "Microsoft YaHei UI", "Segoe UI", sans-serif';
    g.fillText(${JSON.stringify(text)}, 20, 50);
    const d = g.getImageData(0, 0, c.width, c.height);
    return { width: d.width, height: d.height, data: Array.from(d.data) };
  })()`);
  win.destroy();
  return { width: pixels.width, height: pixels.height, data: Uint8Array.from(pixels.data) };
}

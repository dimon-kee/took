'use strict';

/**
 * Starts recordings the way they are started — the record hotkey, a click to
 * take the whole screen it frames, Enter — and times the wait for the
 * recording bar. Main has to stay responsive throughout: its tray window is
 * asked to answer a message every few milliseconds, and the longest stretch
 * it does not is the freeze you would feel. Then Enter on the bar stops it,
 * and the preview has to open on a real clip.
 *
 * Keys only go out while one of Took's windows has the focus, so a stray
 * Enter can never land in whatever else is open.
 *
 * Every round starts Took afresh on a data folder, temp folder and hotkeys of
 * its own, and records the screen, sound included, for a moment; the
 * recording goes into that temp folder and is deleted with it.
 *
 *   node tools/check-record-start.js [rounds]
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const koffi = require('koffi');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron'); // from plain Node: the path to electron.exe

const ROUNDS = Number(process.argv[2]) || 3;
// The bar needs a window of its own, so a few hundred ms is fair; a stall is
// main doing nothing else — window creation costs tens of ms, not hundreds.
const MAX_BAR_MS = 1000;
const MAX_STALL_MS = 250;

const user32 = koffi.load('user32.dll');
koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const keybd_event = user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const mouse_event = user32.func('void __stdcall mouse_event(uint32 flags, int32 dx, int32 dy, int32 data, uintptr extra)');
const FindWindowExW = user32.func('uintptr __stdcall FindWindowExW(uintptr parent, uintptr after, const char16_t *cls, const char16_t *title)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr hwnd, _Out_ uint32 *pid)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr hwnd)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr hwnd, _Out_ uint8_t *name, int max)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(uintptr hwnd, _Out_ RECT *rect)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
const GetForegroundWindow = user32.func('uintptr __stdcall GetForegroundWindow()');
const SendMessageTimeoutW = user32.func(
  'intptr __stdcall SendMessageTimeoutW(uintptr hwnd, uint32 msg, uintptr wparam, intptr lparam, uint32 flags, uint32 timeout, _Out_ uintptr *result)'
);

const VK = { SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, RETURN: 0x0d, F12: 0x7b };
const KEYUP = 0x0002;
const MOUSE_LEFTDOWN = 0x0002;
const MOUSE_LEFTUP = 0x0004;
const WM_NULL = 0x0000;
const SMTO_ABORTIFHUNG = 0x0002;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

main();

function main() {
  const results = [];
  for (let round = 0; round < ROUNDS; round++) {
    try {
      const r = round1();
      console.log(
        `  第 ${round + 1} 次  录制条 ${ms(r.bar)} ms 后出现，主进程最长 ${ms(r.stall)} ms 没响应，` +
          (r.clip ? `录到 ${Math.round(r.clip / 1024)} KB` : '没录到东西')
      );
      results.push(r);
    } catch (err) {
      check(`第 ${round + 1} 次跑完`, false, err.message);
    }
  }

  if (results.length) {
    const bar = median(results.map((r) => r.bar));
    const stall = Math.max(...results.map((r) => r.stall));
    console.log('');
    check(`按下开始后 ${MAX_BAR_MS} ms 内出现录制条`, bar <= MAX_BAR_MS, `中位数 ${ms(bar)} ms`);
    check(`主进程没有卡住超过 ${MAX_STALL_MS} ms`, stall <= MAX_STALL_MS, `最长 ${ms(stall)} ms`);
    check('每次停下都打开预览，录到了东西', results.every((r) => r.clip > 0));
  }

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  process.exitCode = failures ? 1 : 0;
}

/** One recording started from scratch: the timings, or a throw. */
function round1() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'took-record-start-'));
  const data = path.join(dir, 'data');
  const temp = path.join(dir, 'temp');
  fs.mkdirSync(data);
  fs.mkdirSync(temp);
  fs.writeFileSync(
    path.join(data, 'settings.json'),
    JSON.stringify({
      language: 'en',
      shortcuts: { capture: 'CommandOrControl+Alt+Shift+F11', record: 'CommandOrControl+Alt+Shift+F12' },
      autoUpdate: false,
    })
  );

  const env = { ...process.env, TEMP: temp, TMP: temp };
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${data}`, '--autostart'], { cwd: ROOT, env, stdio: 'ignore' });

  try {
    if (!until(() => trayOf(child.pid), 30000)) throw new Error('Took 没起来');
    const tray = trayOf(child.pid);
    // Start-up leaves work running in the background; let it finish.
    sleep(4000);

    chord([VK.CONTROL, VK.MENU, VK.SHIFT, VK.F12]);
    if (!until(() => fullScreenWindowsOf(child.pid).length > 0, 10000)) throw new Error('录屏取景层没出现');
    sleep(600);

    // A click keeps the whole screen it opened with; Enter then starts.
    mouse_event(MOUSE_LEFTDOWN, 0, 0, 0, 0);
    mouse_event(MOUSE_LEFTUP, 0, 0, 0, 0);
    sleep(300);

    focused(child.pid);
    const start = performance.now();
    chord([VK.RETURN]);

    let lastAnswer = start;
    let stall = 0;
    let bar = null;
    while (performance.now() - start < 15000) {
      const asked = [0];
      if (SendMessageTimeoutW(tray, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 100, asked)) {
        const now = performance.now();
        stall = Math.max(stall, now - lastAnswer);
        lastAnswer = now;
      }
      if (bar === null && barOf(child.pid)) bar = performance.now() - start;
      // Keep watching a while past the bar: main still has work queued.
      if (bar !== null && performance.now() - start > bar + 1500) break;
      sleep(5);
    }
    stall = Math.max(stall, performance.now() - lastAnswer);

    if (bar === null) throw new Error('录制条一直没出现');

    // Record a moment, then stop from the bar, which takes the focus.
    sleep(1500);
    focused(child.pid);
    chord([VK.RETURN]);
    if (!until(() => previewOf(child.pid), 15000)) throw new Error('停下后没有打开预览');

    const parked = path.join(temp, 'Took');
    const clips = fs.existsSync(parked) ? fs.readdirSync(parked).filter((f) => f.startsWith('took_')) : [];
    const clip = clips.length ? fs.statSync(path.join(parked, clips[0])).size : 0;
    return { bar, stall, clip };
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    sleep(1000);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {}
  }
}

/** Refuse to type unless Took has the focus: the keys would go to another app. */
function focused(pid) {
  if (!until(() => windowsOf(pid).includes(GetForegroundWindow()), 3000)) {
    throw new Error('Took 的窗口没拿到焦点，不按键');
  }
}

function chord(keys) {
  keys.forEach((vk) => keybd_event(vk, 0, 0, 0));
  keys.slice().reverse().forEach((vk) => keybd_event(vk, 0, KEYUP, 0));
}

function windowsOf(pid) {
  const found = [];
  let hwnd = 0;
  while ((hwnd = FindWindowExW(0, hwnd, null, null))) {
    const owner = [0];
    GetWindowThreadProcessId(hwnd, owner);
    if (owner[0] === pid) found.push(hwnd);
  }
  return found;
}

function classOf(hwnd) {
  const name = Buffer.alloc(512);
  const length = GetClassNameW(hwnd, name, 256);
  return name.toString('utf16le', 0, length * 2);
}

function rectOf(hwnd) {
  const rect = {};
  GetWindowRect(hwnd, rect);
  return { width: rect.right - rect.left, height: rect.bottom - rect.top };
}

/** The tray icon's window: it belongs to main's UI thread. */
function trayOf(pid) {
  return windowsOf(pid).find((hwnd) => /NotifyIcon/.test(classOf(hwnd))) || 0;
}

function fullScreenWindowsOf(pid) {
  const width = GetSystemMetrics(0); // SM_CXSCREEN
  return windowsOf(pid).filter((hwnd) => IsWindowVisible(hwnd) && rectOf(hwnd).width >= width);
}

/** The recording bar: the one small window showing while it records. */
function barOf(pid) {
  const width = GetSystemMetrics(0);
  return windowsOf(pid).some((hwnd) => {
    if (!IsWindowVisible(hwnd)) return false;
    const r = rectOf(hwnd);
    return r.width > 0 && r.width < width / 2 && r.height < 200;
  });
}

/** The preview a finished recording opens in: a regular, mid-sized window. */
function previewOf(pid) {
  const width = GetSystemMetrics(0);
  return windowsOf(pid).some((hwnd) => {
    if (!IsWindowVisible(hwnd)) return false;
    const r = rectOf(hwnd);
    return r.width >= 400 && r.width < width && r.height >= 300;
  });
}

function until(test, ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (test()) return true;
    sleep(5);
  }
  return false;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function ms(value) {
  return String(Math.round(value)).padStart(5);
}

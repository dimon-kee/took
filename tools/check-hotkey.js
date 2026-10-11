'use strict';

/**
 * Times the real hotkey, end to end: starts Took on a data folder, temp folder
 * and hotkey of its own, presses that hotkey as real keyboard input, and
 * measures how long until the overlay is on screen.
 *
 * --trim empties the working set of every Took process before each press —
 * what Windows does to an app idling in the tray once memory runs short — so
 * the press has to page Took back in first.
 *
 *   node tools/check-hotkey.js [rounds] [--trim]
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const koffi = require('koffi');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron'); // from plain Node: the path to electron.exe

const ROUNDS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 5;
const TRIM = process.argv.includes('--trim');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const keybd_event = user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)');
const FindWindowExW = user32.func('uintptr __stdcall FindWindowExW(uintptr parent, uintptr after, const char16_t *cls, const char16_t *title)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr hwnd, _Out_ uint32 *pid)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr hwnd)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr hwnd, _Out_ uint8_t *name, int max)');
const GetForegroundWindow = user32.func('uintptr __stdcall GetForegroundWindow()');
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const K32EmptyWorkingSet = kernel32.func('bool __stdcall K32EmptyWorkingSet(void *process)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *handle)');

const VK = { SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, ESCAPE: 0x1b, F11: 0x7a };
const KEYUP = 0x0002;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_INFORMATION = 0x0400;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);

main();

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'took-hotkey-check-'));
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
  // Main echoes the overlay's warnings and errors to its own output.
  const logFile = path.join(os.tmpdir(), 'took-hotkey-check.log');
  const log = fs.openSync(logFile, 'w');
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${data}`, '--autostart'], { cwd: ROOT, env, stdio: ['ignore', log, log] });

  try {
    // Its first hidden windows come long before start-up is done; the tray
    // icon comes at the end of it.
    if (!until(() => windowsOf(child.pid).some((hwnd) => /NotifyIcon/.test(classOf(hwnd))), 30000)) {
      throw new Error('Took 没起来');
    }
    // What start-up leaves running in the background — resolving the screen
    // sources, loading the spare overlays — gets to finish first, so the
    // presses below measure the steady state.
    sleep(3000);

    console.log(`快捷键到取景层出现（${TRIM ? '每次按之前先清空 Took 的工作集' : '常态'}）`);
    const times = [];
    for (let round = 0; round < ROUNDS + 1; round++) {
      if (TRIM) trim(child.pid);
      const ms = press(child.pid);
      if (ms == null) throw new Error(`第 ${round + 1} 次：取景层没出现`);
      console.log(`  ${round === 0 ? '首次' : `第 ${round} 次`}  ${ms.toFixed(0).padStart(5)} ms`);
      if (round > 0) times.push(ms);
      dismiss(child.pid);
    }
    console.log(`  中位数（不算首次）  ${median(times).toFixed(0)} ms`);
  } catch (err) {
    console.log(`  失败：${err.message}`);
    process.exitCode = 1;
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    fs.closeSync(log);
    const output = fs.readFileSync(logFile, 'utf8').trim();
    if (output) console.log(`
Took 的输出：
${output}`);
    sleep(1000);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {}
  }
}

/** Press the hotkey; returns ms until one of Took's windows is visible. */
function press(pid) {
  const start = performance.now();
  chord([VK.CONTROL, VK.MENU, VK.SHIFT, VK.F11]);
  const shown = until(() => visibleWindowsOf(pid).length > 0, 10000);
  return shown ? performance.now() - start : null;
}

/**
 * Esc closes the overlay — but only once it is ready, and a window the safety
 * net revealed early may not be yet. Keep asking.
 */
function dismiss(pid) {
  for (let i = 0; i < 10; i++) {
    sleep(400);
    // Esc goes wherever the focus is; only press it while that is Took.
    if (!windowsOf(pid).includes(GetForegroundWindow())) continue;
    chord([VK.ESCAPE]);
    if (until(() => visibleWindowsOf(pid).length === 0, 600)) {
      sleep(1000);
      return;
    }
  }
  throw new Error('取景层关不掉');
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

function visibleWindowsOf(pid) {
  return windowsOf(pid).filter((hwnd) => IsWindowVisible(hwnd));
}

/** Empty the working set of `pid` and every process it started. */
function trim(pid) {
  const listed = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`],
    { encoding: 'utf8' }
  );
  const pids = [pid, ...listed.stdout.split(/\s+/).filter(Boolean).map(Number)];
  pids.forEach((p) => {
    const handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION, false, p);
    if (!handle) return;
    K32EmptyWorkingSet(handle);
    CloseHandle(handle);
  });
  sleep(300);
}

function until(test, ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (test()) return true;
    sleep(1);
  }
  return false;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

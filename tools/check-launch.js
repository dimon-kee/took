'use strict';

/**
 * Starts Took every way it gets started, and checks what shows up:
 *
 *   - by the Start with Windows entry (--autostart) or after an update
 *     (--updated): the tray only, no window
 *   - the first time ever, as after a fresh install: the settings window
 *   - by hand from then on — the Start menu, a shortcut: the tray only
 *   - by hand while it already runs: the running copy opens its settings
 *     rather than a capture, and the new copy quits without starting up — its
 *     start-up would sweep the temp folder, deleting the recording the running
 *     copy is holding
 *
 * and that the settings window saves a change as soon as it is made, with no
 * Save button: one is flipped through the debugging protocol, and settings.json
 * has to follow.
 *
 * Every copy gets a data folder, a temp folder and hotkeys of its own, so a
 * real Took — its lock, settings, parked recording and hotkeys — is never
 * touched. Their tray icons and settings windows show for a few seconds.
 *
 *   node tools/check-launch.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron'); // from plain Node: the path to electron.exe

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

main()
  .catch((err) => check('跑完', false, err.message))
  .finally(() => {
    console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
    process.exitCode = failures ? 1 : 0;
  });

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'took-launch-check-'));
  const data = path.join(dir, 'data');
  const temp = path.join(dir, 'temp');
  fs.mkdirSync(data);
  fs.mkdirSync(temp);
  const settingsFile = path.join(data, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      language: 'en',
      shortcuts: { capture: 'CommandOrControl+Alt+Shift+F11', record: 'CommandOrControl+Alt+Shift+F12' },
      autoUpdate: false,
    })
  );

  const base = ['.', `--user-data-dir=${data}`];
  // No settings.json in here: Took has never run on it.
  const fresh = path.join(dir, 'fresh');
  fs.mkdirSync(fresh);
  // app.getPath('temp') follows TMP and TEMP, so the sweep stays in here too.
  const env = { ...process.env, TEMP: temp, TMP: temp };
  const running = [];
  const startIn = (userData, ...args) => {
    const child = spawn(ELECTRON, ['.', `--user-data-dir=${userData}`, ...args], { cwd: ROOT, env, stdio: 'ignore' });
    running.push(child);
    return child;
  };
  const start = (...args) => startIn(data, ...args);

  try {
    console.log('装好后第一次启动');
    const newcomer = startIn(fresh);
    let seen = watch(newcomer.pid, 30000, '^1\t.*\tSettings$');
    check('打开设置', seen.some((w) => w.visible && w.title === 'Settings'), shown(seen) || '没有窗口');
    stop(newcomer);

    console.log('\n之后再启动');
    const later = startIn(fresh);
    seen = watch(later.pid, 30000, 'NotifyIcon');
    seen = seen.concat(watch(later.pid, 3000, '^1\t'));
    check('只进托盘，不弹窗口', seen.some((w) => /NotifyIcon/.test(w.cls)) && !seen.some((w) => w.visible), shown(seen));
    stop(later);

    console.log('\n开机自启');
    const first = start('--autostart', '--remote-debugging-port=0');
    seen = watch(first.pid, 30000, 'NotifyIcon');
    const up = seen.some((w) => /NotifyIcon/.test(w.cls));
    check('进了托盘', up, up ? '' : '等不到托盘图标');
    if (!up) return;
    seen = watch(first.pid, 3000, '^1\t');
    check('不弹任何窗口', !seen.some((w) => w.visible), shown(seen));

    console.log('\n已经在运行时再手动启动一次');
    // A finished recording, parked where the editor plays it from.
    const parked = path.join(temp, 'Took', 'took_20260101_000000.mp4');
    fs.mkdirSync(path.dirname(parked), { recursive: true });
    fs.writeFileSync(parked, 'recording');

    const began = Date.now();
    const second = spawnSync(ELECTRON, base, { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
    check('新启动的那个自己退出了', second.status === 0, second.error ? second.error.message : `${Date.now() - began} ms，退出码 ${second.status}`);
    check('它没有跑启动流程：存着的录屏还在', fs.existsSync(parked));

    seen = watch(first.pid, 6000, '^1\t.*\tSettings$');
    check('在跑的那个打开了设置', seen.some((w) => w.visible && w.title === 'Settings'), shown(seen) || '没有窗口');
    check('没有打开截图', !seen.some((w) => w.visible && /Screenshot/.test(w.title)));

    console.log('\n设置改了就保存');
    const port = Number(fs.readFileSync(path.join(data, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    const page = (expression) => evaluate(port, 'settings/index.html', expression);
    check('没有保存按钮', (await page(`!document.getElementById('btn-save')`)) === true);
    await page(`document.getElementById('auto-update').click()`);
    const saved = await until(() => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).autoUpdate === true, 5000);
    check('勾一下「自动更新」，settings.json 马上跟着变', saved);
    // Main writes the file a moment before the window hears back.
    let status = '';
    for (let i = 0; i < 20 && status !== 'Saved'; i++) {
      status = await page(`document.getElementById('status').textContent`);
      if (status !== 'Saved') await new Promise((r) => setTimeout(r, 100));
    }
    check('底部显示「已保存」', status === 'Saved', status);
    stop(first);

    console.log('\n没在运行时手动启动');
    const third = start();
    seen = watch(third.pid, 30000, 'NotifyIcon');
    seen = seen.concat(watch(third.pid, 3000, '^1\t'));
    check('只进托盘，不弹窗口', seen.some((w) => /NotifyIcon/.test(w.cls)) && !seen.some((w) => w.visible), shown(seen));
    stop(third);

    console.log('\n更新装好后重新启动（--updated）');
    const fourth = start('--updated');
    seen = watch(fourth.pid, 30000, 'NotifyIcon');
    seen = seen.concat(watch(fourth.pid, 3000, '^1\t'));
    check('只进托盘，不弹窗口', seen.some((w) => /NotifyIcon/.test(w.cls)) && !seen.some((w) => w.visible), shown(seen));
  } finally {
    running.forEach(stop);
    await Promise.all(running.map((c) => new Promise((r) => (c.exitCode === null ? c.once('exit', r) : r()))));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

function stop(child) {
  if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function until(test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (test()) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Run `expression` in the page whose URL contains `urlPart`, over the debugging protocol. */
async function evaluate(port, urlPart, expression) {
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((t) => t.type === 'page' && t.url.includes(urlPart));
    if (!target) await new Promise((r) => setTimeout(r, 100));
  }
  if (!target) throw new Error(`没有 ${urlPart} 这个页面`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error('连不上调试端口'));
  });
  const reply = await new Promise((ok) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === 1) ok(msg);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.text);
  return reply.result.result.value;
}

function shown(windows) {
  const visible = windows.filter((w) => w.visible);
  return visible.length ? `看得见的窗口：${visible.map((w) => `${w.cls} "${w.title}"`).join('，')}` : '';
}

/**
 * Every top-level window the process owns, collected for `ms` — or until one
 * matches `stop`, a regex over "<visible 1|0>\t<class>\t<title>".
 */
function watch(pid, ms, stop) {
  const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class TookWindows {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lparam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  public static List<string> Of(uint target) {
    var found = new List<string>();
    EnumWindows((hwnd, lparam) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner == target) {
        var cls = new StringBuilder(256);
        var title = new StringBuilder(256);
        GetClassName(hwnd, cls, cls.Capacity);
        GetWindowText(hwnd, title, title.Capacity);
        found.Add((IsWindowVisible(hwnd) ? "1" : "0") + "\\t" + cls + "\\t" + title);
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$seen = New-Object System.Collections.Generic.List[string]
$deadline = (Get-Date).AddMilliseconds(${ms})
do {
  $hit = $false
  foreach ($line in [TookWindows]::Of(${pid})) {
    if (-not $seen.Contains($line)) { $seen.Add($line) }
    if ($line -match '${stop}') { $hit = $true }
  }
  if ($hit) { break }
  Start-Sleep -Milliseconds 100
} while ((Get-Date) -lt $deadline)
$seen
`;
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: ms + 60000 }
  );
  if (result.status !== 0) throw new Error(`枚举窗口失败：${(result.stderr || result.error || '').toString().trim()}`);
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [visible, cls, title = ''] = line.split('\t');
      return { visible: visible === '1', cls, title };
    });
}

'use strict';

/**
 * Launches Took a second time while it is already running — a Start-menu
 * click, or the installer's "Run Took" with a copy still in the tray. The
 * running copy must stay in the tray rather than open a capture, and the new
 * copy must quit without starting up: its start-up sweeps the temp folder,
 * which would delete the recording the running copy is holding.
 *
 * Both copies get a data folder, a temp folder and hotkeys of their own, so a
 * real Took — its lock, settings, parked recording and hotkeys — is never
 * touched. The running copy's tray icon shows for a few seconds, and so does
 * its "already running" notice.
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
  fs.writeFileSync(
    path.join(data, 'settings.json'),
    JSON.stringify({
      shortcuts: { capture: 'CommandOrControl+Alt+Shift+F11', record: 'CommandOrControl+Alt+Shift+F12' },
      autoUpdate: false,
    })
  );

  const args = ['.', `--user-data-dir=${data}`];
  // app.getPath('temp') follows TMP and TEMP, so the sweep stays in here too.
  const env = { ...process.env, TEMP: temp, TMP: temp };

  console.log('已经在运行时再启动一次');
  const first = spawn(ELECTRON, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  first.stdout.on('data', (chunk) => (output += chunk));
  first.stderr.on('data', (chunk) => (output += chunk));

  try {
    const seen = watch(first.pid, 30000, 'NotifyIcon');
    const up = seen.some((w) => /NotifyIcon/.test(w.cls));
    check('第一个启动了，只进托盘', up && !seen.some((w) => w.visible), up ? shown(seen) : '等不到托盘图标');
    if (!up) return;

    // A finished recording, parked where the editor plays it from.
    const parked = path.join(temp, 'Took', 'took_20260101_000000.mp4');
    fs.mkdirSync(path.dirname(parked), { recursive: true });
    fs.writeFileSync(parked, 'recording');

    const started = Date.now();
    const second = spawnSync(ELECTRON, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
    check(
      '第二个自己退出了',
      second.status === 0,
      second.error ? second.error.message : `${Date.now() - started} ms，退出码 ${second.status}`
    );
    check('第二个没有跑启动流程：第一个存着的录屏还在', fs.existsSync(parked));

    // An overlay would be on screen within 1.5 s of being asked for, even if
    // its page never reported back.
    const after = watch(first.pid, 4000, '^1\t');
    check('第一个没有打开截图', !after.some((w) => w.visible), shown(after));
    check('第一个还在运行', first.exitCode === null);
  } finally {
    spawnSync('taskkill', ['/PID', String(first.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise((r) => (first.exitCode === null ? first.once('exit', r) : r()));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }

  const errors = output.split(/\r?\n/).filter((l) => /Uncaught|(Type|Reference|Range|Syntax)Error/.test(l));
  check('第一个没有报错', !errors.length, errors.slice(0, 3).join(' | '));
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

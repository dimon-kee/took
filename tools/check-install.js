'use strict';

/**
 * Installs, updates and uninstalls Took for real, then checks nothing is left
 * behind — not the program, its shortcuts or registry entries, not
 * %APPDATA%\Took, the updater's cache, Start with Windows, a parked recording
 * or an empty default save folder — while an update in the middle keeps
 * settings and Start with Windows exactly as they were.
 *
 *   node tools/check-install.js [<installer>] [--from <older installer>]
 *
 * The installer defaults to the one `task dist` just built. With --from it
 * installs the older one first and then updates over it the way the updater
 * does (--updated /S). Anything of yours it has to disturb —
 * %APPDATA%\Took, a parked recording, the Start with Windows entries — is
 * backed up first and put back afterwards; captures in Pictures\Took are only
 * ever read. Every copy of Took, dev runs included, has to be closed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const from = args.indexOf('--from');
const older = from >= 0 && args[from + 1] ? path.resolve(args[from + 1]) : null;
const positional = args.filter((a, i) => i !== from && i !== from + 1);
const installer = path.resolve(
  positional[0] || path.join(__dirname, '..', 'dist', `Took-Setup-${require('../package.json').version}.exe`)
);

const APPDATA = process.env.APPDATA;
const LOCAL = process.env.LOCALAPPDATA;
const TEMP = os.tmpdir();
const INSTALL = path.join(LOCAL, 'Programs', 'Took');
const USER_DATA = path.join(APPDATA, 'Took');
const UPDATER_CACHE = path.join(LOCAL, 'took-updater');
const PARKED = path.join(TEMP, 'Took');
const LOOSE = path.join(TEMP, 'took_20260101_000000.mp4'); // as versions before 0.1.2 left them
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const UNINSTALL = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

main();

function main() {
  if (!fs.existsSync(installer) || (older && !fs.existsSync(older))) {
    console.log('用法: node tools/check-install.js [<安装包，默认 dist 里这一版的>] [--from <用来更新的旧安装包>]');
    console.log(`找不到: ${!fs.existsSync(installer) ? installer : older}（先 task dist）`);
    process.exit(2);
  }
  const running = tookProcesses();
  if (running.length) {
    console.log(`先关掉所有 Took（包括开发版，task stop）: ${running.join(', ')}`);
    process.exit(2);
  }
  if (fs.existsSync(INSTALL) || uninstallKey()) {
    console.log(`这台机器上已经装着 Took（${INSTALL}），不在装好的上面做试验。`);
    process.exit(2);
  }

  const folders = knownFolders();
  const pictures = path.join(folders.pictures, 'Took');
  const backup = fs.mkdtempSync(path.join(TEMP, 'took-install-check-'));
  const saved = save(backup);
  const picturesBefore = listing(pictures);
  const before = topLevel();

  try {
    run(pictures, folders);
  } catch (err) {
    check('跑完', false, err.message);
  } finally {
    restore(backup, saved);
    // An empty save folder the uninstaller rightly removed, but it was there.
    if (picturesBefore && !fs.existsSync(pictures)) fs.mkdirSync(pictures, { recursive: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }

  console.log('\n放回原样');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('开机自启的值和原来一字不差', same(regValue(RUN, 'Took'), saved.run), saved.run ? saved.run.data : '原来没有');
  check('启动项记录和原来一样', same(regValue(APPROVED, 'Took'), saved.approved));
  check('%APPDATA%\\Took 放回来了', fs.existsSync(USER_DATA) === saved.userData);

  console.log('\n别的东西');
  const after = listing(pictures);
  check(
    '图片\\Took 里原来的东西一样没少',
    picturesBefore === null || picturesBefore.every((f) => after && after.includes(f)),
    picturesBefore ? `${picturesBefore.length} 个文件` : '原来没有这个文件夹'
  );
  // Windows paths ignore case, and so must this comparison.
  const had = new Set(before.map((e) => e.toLowerCase()));
  const leftover = topLevel().filter((e) => !had.has(e.toLowerCase()) && /took/i.test(e));
  check('%APPDATA% / %LOCALAPPDATA% / %TEMP% 里没有多出带 took 的东西', leftover.length === 0, leftover.join(', '));

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  process.exit(failures ? 1 : 0);
}

function run(pictures, folders) {
  console.log(`安装${older ? `（先装 ${path.basename(older)}，再更新）` : ''}`);
  install(older || installer, []);
  check('装好了', fs.existsSync(path.join(INSTALL, 'Took.exe')), INSTALL);

  if (older) {
    // What a session of the older version leaves: settings, Start with Windows.
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({ language: 'zh', marker: process.pid }));
    reg(['add', RUN, '/v', 'Took', '/t', 'REG_SZ', '/d', `"${path.join(INSTALL, 'Took.exe')}"`, '/f']);

    console.log('\n更新');
    install(installer, ['--updated']);
    check('换成了新版本', installedVersion() === versionOf(installer), `${installedVersion()}`);
    const kept = readJson(path.join(USER_DATA, 'settings.json'));
    check('设置还在', kept && kept.marker === process.pid);
    check('开机自启还在', regValue(RUN, 'Took') !== null);
  }

  // Run it for a moment, so its own data is really there to clean up.
  const app = spawn(path.join(INSTALL, 'Took.exe'), [], { detached: true, stdio: 'ignore' });
  sleep(8000);
  execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  sleep(1500);
  check('运行过，有了自己的数据', fs.existsSync(USER_DATA), USER_DATA);

  // And what using it leaves elsewhere.
  reg(['add', RUN, '/v', 'Took', '/t', 'REG_SZ', '/d', `"${path.join(INSTALL, 'Took.exe')}"`, '/f']);
  reg(['add', APPROVED, '/v', 'Took', '/t', 'REG_BINARY', '/d', '030000000000000000000000', '/f']);
  fs.mkdirSync(PARKED, { recursive: true });
  fs.writeFileSync(path.join(PARKED, 'took_20260101_000000.mp4'), 'clip');
  fs.writeFileSync(LOOSE, 'clip');
  fs.mkdirSync(path.join(UPDATER_CACHE, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(UPDATER_CACHE, 'pending', 'Took-Setup-9.9.9.exe'), 'update');
  const madePictures = !fs.existsSync(pictures);
  if (madePictures) fs.mkdirSync(pictures, { recursive: true });

  console.log('\n卸载');
  uninstall();
  check('程序删了', !fs.existsSync(INSTALL));
  check('开始菜单的快捷方式删了', !fs.existsSync(path.join(folders.programs, 'Took.lnk')));
  check('桌面的快捷方式删了', !fs.existsSync(path.join(folders.desktop, 'Took.lnk')));
  check('卸载信息从注册表删了', !uninstallKey());
  check('开机自启删了', regValue(RUN, 'Took') === null);
  check('任务管理器里的启动项记录删了', regValue(APPROVED, 'Took') === null);
  check('%APPDATA%\\Took 删了', !fs.existsSync(USER_DATA));
  check('更新缓存删了', !fs.existsSync(UPDATER_CACHE), UPDATER_CACHE);
  check('暂存的录屏删了', !fs.existsSync(PARKED) && !fs.existsSync(LOOSE));
  if (madePictures) check('空的图片\\Took 删了', !fs.existsSync(pictures));
}

// ---------------------------------------------------------------------------

function install(file, flags) {
  const r = spawnSync(file, [...flags, '/S'], { stdio: 'ignore', timeout: 5 * 60000 });
  if (r.status !== 0) throw new Error(`${path.basename(file)} 退出码 ${r.status}`);
  sleep(1500);
}

/** The uninstaller copies itself to temp and carries on from there — wait for it. */
function uninstall() {
  spawnSync(path.join(INSTALL, 'Uninstall Took.exe'), ['/S'], { stdio: 'ignore', timeout: 5 * 60000 });
  for (let i = 0; i < 120 && (fs.existsSync(INSTALL) || uninstallKey()); i++) sleep(500);
  sleep(1500);
}

function installedVersion() {
  const asar = require('@electron/asar');
  return JSON.parse(asar.extractFile(path.join(INSTALL, 'resources', 'app.asar'), 'package.json')).version;
}

function versionOf(file) {
  return /(\d+\.\d+\.\d+)/.exec(path.basename(file))[1];
}

/** Everything of the user's this touches, copied aside. */
function save(dir) {
  const saved = { run: regValue(RUN, 'Took'), approved: regValue(APPROVED, 'Took') };
  saved.userData = copyAside(USER_DATA, path.join(dir, 'userData'));
  // Put it back under the name it had — an early dev run may have made it "took".
  saved.userDataName = (listing(APPDATA) || []).find((n) => n.toLowerCase() === 'took') || 'Took';
  saved.parked = copyAside(PARKED, path.join(dir, 'parked'));
  return saved;
}

function restore(dir, saved) {
  putBack(path.join(dir, 'userData'), path.join(APPDATA, saved.userDataName), saved.userData);
  putBack(path.join(dir, 'parked'), PARKED, saved.parked);
  fs.rmSync(LOOSE, { force: true });
  regRestore(RUN, 'Took', saved.run);
  regRestore(APPROVED, 'Took', saved.approved);
  if (!saved.approved && regValue(APPROVED, 'Took')) reg(['delete', APPROVED, '/v', 'Took', '/f']);
  console.log('\n  （你的 %APPDATA%\\Took 和开机自启已经原样放回）');
}

function copyAside(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.cpSync(from, to, { recursive: true });
  return true;
}

function putBack(from, to, had) {
  fs.rmSync(to, { recursive: true, force: true });
  if (had) fs.cpSync(from, to, { recursive: true });
}

function reg(args) {
  return execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** { type, data } for a registry value, or null if there is none. */
function regValue(key, name) {
  try {
    const line = reg(['query', key, '/v', name]).split(/\r?\n/).find((l) => l.trim().startsWith(name));
    const [, type, ...rest] = line.trim().split(/\s{2,}|\t/);
    return { type, data: rest.join(' ') };
  } catch {
    return null;
  }
}

function regRestore(key, name, value) {
  if (!value) {
    try {
      reg(['delete', key, '/v', name, '/f']);
    } catch {}
    return;
  }
  reg(['add', key, '/v', name, '/t', value.type, '/d', value.data, '/f']);
}

function uninstallKey() {
  try {
    return /DisplayName\s+REG_SZ\s+Took\b/.test(reg(['query', UNINSTALL, '/s', '/f', 'Took', '/d']));
  } catch {
    return false;
  }
}

function tookProcesses() {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Took.exe' -or ($_.Name -eq 'electron.exe' -and $_.CommandLine -match 'took') } | ForEach-Object { $_.Name + ' ' + $_.ProcessId }"],
    { encoding: 'utf8' }
  );
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function knownFolders() {
  const ps = (name) =>
    execFileSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetFolderPath('${name}')`], { encoding: 'utf8' }).trim();
  return { pictures: ps('MyPictures'), desktop: ps('Desktop'), programs: ps('Programs') };
}

function topLevel() {
  return [APPDATA, LOCAL, TEMP].flatMap((d) => {
    try {
      return fs.readdirSync(d).map((e) => path.join(d, e));
    } catch {
      return [];
    }
  });
}

function listing(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

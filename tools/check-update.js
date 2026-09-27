'use strict';

/**
 * Runs src/main/updater.js against a stand-in for GitHub: a local HTTP server
 * with a latest.yml and an "installer". Every path goes through the real
 * module — the dev build that cannot update, already up to date, the server
 * failing, a download that does not match its checksum, an update found then
 * downloaded and verified, automatic mode, and clearing the cache once an
 * update has installed — without touching the real releases or installing
 * anything.
 *
 *   npx electron tools/check-update.js
 *   npx electron tools/check-update.js --live
 *
 * --live asks the real GitHub releases instead and downloads the newest
 * installer, proving latest.yml, the asset's name and its checksum on the
 * release all agree. Run it after publishing one.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

app.on('window-all-closed', () => {});

// A cache of its own, so a real pending update is never touched.
const CACHE_NAME = 'took-updater-check';
const CACHE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), CACHE_NAME);
const CONFIG = path.join(os.tmpdir(), `took-update-check-${process.pid}.yml`);

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

app.whenReady().then(async () => {
  try {
    if (process.argv.includes('--live')) await live();
    else await local();
  } catch (err) {
    check('跑完', false, err.message);
  } finally {
    // The downloaded "installer" must never look like an update to run on quit.
    autoUpdater.autoInstallOnAppQuit = false;
    fs.rmSync(CACHE, { recursive: true, force: true });
    fs.rmSync(CONFIG, { force: true });
  }

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  app.exit(failures ? 1 : 0);
});

async function local() {
  console.log('更新（本地假服务器）');
  const { server, routes, url } = await serve();
  fs.writeFileSync(CONFIG, `provider: generic\nurl: ${url}\nupdaterCacheDirName: ${CACHE_NAME}\n`);
  autoUpdater.updateConfigPath = CONFIG;
  const installer = crypto.randomBytes(256 * 1024);

  try {
    autoUpdater.forceDevUpdateConfig = false;
    let u = fresh();
    check('开发版说明只有安装版能更新', u.updater.check().status === 'unsupported');

    autoUpdater.forceDevUpdateConfig = true;
    publish(routes, '0.0.1', installer);
    u = fresh();
    u.updater.check();
    check('已经是最新', (await u.until('latest', 'error')).status === 'latest');

    routes.clear();
    u.updater.check();
    const down = await u.until('error', 'latest');
    check('服务器出错时报错，不崩', down.status === 'error', down.message);

    publish(routes, '999.0.0', installer, { tamper: true });
    u = fresh();
    u.updater.check();
    await u.until('available', 'error');
    u.updater.download();
    const bad = await u.until('error', 'ready');
    check('下载的文件对不上校验值就拒绝', bad.status === 'error' && /sha512|checksum/i.test(bad.message), bad.message);

    publish(routes, '999.0.1', installer);
    u = fresh();
    u.updater.check();
    const found = await u.until('available', 'error');
    check('发现新版本', found.status === 'available' && found.version === '999.0.1', found.version);
    await wait(600);
    check('自动更新关着时，不问就不下载', u.updater.get().status === 'available');
    u.updater.download();
    const ready = await u.until('ready', 'error');
    check('下载完并通过校验', ready.status === 'ready', ready.message);
    check('通知可以重启安装了', u.ready.includes('999.0.1'), JSON.stringify(u.ready));
    check('下载过程有进度', u.seen.some((s) => s.status === 'downloading'));
    check('已经下载好时再检查，不重复', u.updater.check().status === 'ready');

    publish(routes, '999.0.2', installer);
    u = fresh({ autoUpdate: true, firstCheck: 50 });
    const auto = await u.until('ready', 'error');
    check('自动更新开着：自己检查、自己下载', auto.status === 'ready' && auto.version === '999.0.2', auto.message || auto.version);
    check('没有可装的更新时，不会去装', fresh().updater.install() === false);

    console.log('\n更新装好之后');
    const pending = path.join(CACHE, 'pending');
    check('装好的这一版，安装包从缓存里清掉', u.updater.sweepInstalled(CACHE, '999.0.2') && !fs.existsSync(pending));
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify({ fileName: 'Took-Setup-999.1.0.exe' }));
    check('还没装的更新留着', u.updater.sweepInstalled(CACHE, '999.0.2') === false && fs.existsSync(pending));
  } finally {
    server.close();
  }
}

async function live() {
  console.log('更新（真的 GitHub Releases）');
  fs.writeFileSync(CONFIG, `provider: github\nowner: dimon-kee\nrepo: took\nupdaterCacheDirName: ${CACHE_NAME}\n`);
  autoUpdater.updateConfigPath = CONFIG;
  autoUpdater.forceDevUpdateConfig = true;
  // Run as a script, "the running version" is Electron's own, which outranks
  // every Took release — so the newest one counts as a downgrade.
  autoUpdater.allowDowngrade = true;

  const u = fresh();
  u.updater.check();
  const found = await u.until('available', 'error', 60000);
  check('找到最新的发布', found.status === 'available', found.version || found.message);
  if (found.status !== 'available') return;

  u.updater.download();
  const ready = await u.until('ready', 'error', 15 * 60000);
  check('安装包下载下来，校验值对得上', ready.status === 'ready', ready.message || `v${ready.version}`);
}

/** A fresh copy of the updater module, wired to a fresh set of listeners. */
function fresh(opts = {}) {
  autoUpdater.removeAllListeners();
  delete require.cache[require.resolve('../src/main/updater')];
  const updater = require('../src/main/updater');

  const seen = [];
  const ready = [];
  updater.init({ autoUpdate: false, onChange: (s) => seen.push(s), onReady: (v) => ready.push(v), ...opts });

  /** Wait for any of the given statuses, starting from the next change. */
  async function until(...args) {
    const ms = typeof args[args.length - 1] === 'number' ? args.pop() : 20000;
    const from = seen.length;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = seen.slice(from).find((s) => args.includes(s.status));
      if (hit) return hit;
      await wait(25);
    }
    throw new Error(`等不到 ${args.join(' / ')}，最后是 ${JSON.stringify(seen[seen.length - 1])}`);
  }

  return { updater, seen, ready, until };
}

/** Put a release up: its latest.yml, and the installer it names. */
function publish(routes, version, installer, { tamper = false } = {}) {
  const name = `Took-Setup-${version}.exe`;
  const sha512 = crypto.createHash('sha512').update(tamper ? Buffer.from('something else') : installer).digest('base64');
  routes.set(
    '/latest.yml',
    Buffer.from(
      `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${installer.length}\n` +
        `path: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`
    )
  );
  routes.set(`/${name}`, installer);
}

function serve() {
  const routes = new Map();
  const server = http.createServer((req, res) => {
    const body = routes.get(decodeURIComponent(req.url.split('?')[0]));
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, routes, url: `http://127.0.0.1:${server.address().port}/` }))
  );
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

/**
 * Updates from the GitHub releases, through electron-updater. The installed
 * app knows where to look from resources/app-update.yml, which electron-builder
 * writes from the `publish` block in package.json; every release carries a
 * latest.yml naming its installer and checksum.
 *
 * With automatic updates on, it checks a little after start and every few
 * hours, downloads in the background, and offers a restart once the update is
 * ready — installing on the next quit if the offer is ignored. Off, nothing
 * touches the network until someone presses Check for updates, and an update
 * found that way waits for a second click before it downloads.
 *
 * An unpacked dev run has no app-update.yml and cannot check at all, so it
 * says so instead of failing.
 */

const RECHECK = 6 * 60 * 60 * 1000;

// electron-updater's cache, named by electron-builder after the package:
// "<name>-updater". The uninstaller removes it too (build/installer.nsh).
const CACHE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'took-updater');

// idle | checking | latest | available | downloading | ready | error | unsupported
let state = { status: 'idle' };
let hooks = { onChange() {}, onReady() {} };
let auto = false;
let timer = null;

/**
 * @param opts.autoUpdate  check and download without being asked
 * @param opts.onChange    (state) => void, on every change
 * @param opts.onReady     (version) => void, once an update is downloaded
 * @param opts.firstCheck  ms after start before the first automatic check
 */
function init({ autoUpdate, onChange, onReady, firstCheck = 15000 }) {
  hooks = { onChange, onReady };
  if (app.isPackaged) sweepInstalled();

  // electron-updater narrates every step to the console; only trouble is
  // worth a line in ours.
  autoUpdater.logger = {
    info() {},
    debug() {},
    warn: (message) => console.warn('[took] 更新:', message),
    error: (message) => console.error('[took] 更新:', message),
  };
  // Downloads are started from here, so that a manual check can ask first.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Releases carry the full installer; there is no web installer to look for.
  autoUpdater.disableWebInstaller = true;

  autoUpdater.on('checking-for-update', () => update({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => update({ status: 'latest' }));
  autoUpdater.on('update-available', (info) => {
    update({ status: 'available', version: info.version });
    if (auto) download();
  });
  autoUpdater.on('download-progress', (progress) =>
    update({ status: 'downloading', version: state.version, percent: Math.floor(progress.percent) })
  );
  autoUpdater.on('update-downloaded', (info) => {
    update({ status: 'ready', version: info.version });
    hooks.onReady(info.version);
  });
  autoUpdater.on('error', (err) => update({ status: 'error', message: brief(err) }));

  setAuto(autoUpdate, firstCheck);
}

/** Automatic updates on or off. On means a check shortly, then every few hours. */
function setAuto(on, delay = 3000) {
  auto = Boolean(on);
  clearTimeout(timer);
  timer = null;
  if (!auto || !supported()) return;

  const tick = () => {
    check();
    timer = setTimeout(tick, RECHECK);
  };
  timer = setTimeout(tick, delay);
}

function supported() {
  return autoUpdater.isUpdaterActive();
}

/** Ask the server. How it went arrives through the events above. */
function check() {
  if (!supported()) return update({ status: 'unsupported' });
  // Already at it, or already holding an update: a new check adds nothing.
  if (['checking', 'downloading', 'ready'].includes(state.status)) return get();

  autoUpdater.checkForUpdates().catch(() => {}); // failures also arrive as 'error'
  return get();
}

function download() {
  if (state.status !== 'available') return get();
  update({ status: 'downloading', version: state.version, percent: 0 });
  autoUpdater.downloadUpdate().catch(() => {});
  return get();
}

/**
 * Quit and run the downloaded installer — silently, since this is an update
 * the user has already chosen, not a fresh install.
 * @param relaunch  start Took again afterwards
 * @returns false when there is nothing to install
 */
function install(relaunch = true) {
  if (state.status !== 'ready') return false;
  autoUpdater.quitAndInstall(true, relaunch);
  return true;
}

function get() {
  return { ...state };
}

/**
 * Once an update has installed, the installer it ran stays in the cache until
 * a later update replaces it — a hundred-odd megabytes doing nothing. Clear it
 * unless it holds something newer than what is running. (installer.exe beside
 * it is this version's own, kept on purpose: the next update diffs against it
 * and downloads only the blocks that changed.)
 * @returns whether the pending folder was cleared
 */
function sweepInstalled(cache = CACHE, current = app.getVersion()) {
  const pending = path.join(cache, 'pending');
  try {
    const { fileName } = JSON.parse(fs.readFileSync(path.join(pending, 'update-info.json'), 'utf8'));
    const version = /(\d+)\.(\d+)\.(\d+)/.exec(fileName || '');
    if (version && newer(version.slice(1, 4).map(Number), current.split('.').map(Number))) return false;
  } catch {
    // Nothing pending, or a half-finished download: nothing worth keeping.
  }
  try {
    fs.rmSync(pending, { recursive: true, force: true });
  } catch {}
  return true;
}

function newer(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function update(next) {
  state = next;
  hooks.onChange(get());
  return get();
}

/** electron-updater errors can carry a whole HTTP response; the first line says enough. */
function brief(err) {
  const text = String((err && err.message) || err).split('\n')[0];
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

module.exports = { init, setAuto, check, download, install, get, supported, sweepInstalled };

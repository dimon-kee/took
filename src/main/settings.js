'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

/**
 * User preferences, persisted as JSON in the app's userData directory.
 *
 * Reads are served from memory; every write goes straight to disk so a crash
 * cannot lose a setting the user just changed.
 */

const { normalize: normalizeLanguage, DEFAULT_LANGUAGE } = require('../shared/i18n');

const DEFAULTS = {
  language: DEFAULT_LANGUAGE,
  shortcuts: {
    capture: 'CommandOrControl+Shift+S',
    record: 'CommandOrControl+Shift+R',
  },
  // null means "wherever saveDir() lands", i.e. Pictures/Took
  saveDir: null,
  // Check, download and install updates without being asked.
  autoUpdate: true,
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;

  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = {
      language: normalizeLanguage(raw.language),
      shortcuts: { ...DEFAULTS.shortcuts, ...(raw.shortcuts || {}) },
      saveDir: typeof raw.saveDir === 'string' && raw.saveDir ? raw.saveDir : null,
      autoUpdate: typeof raw.autoUpdate === 'boolean' ? raw.autoUpdate : DEFAULTS.autoUpdate,
    };
  } catch {
    // Missing or corrupt — fall back to defaults rather than refusing to start.
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

function get() {
  return structuredClone(load());
}

function set(patch) {
  const next = load();

  if (patch.language) next.language = normalizeLanguage(patch.language);
  if (patch.shortcuts) Object.assign(next.shortcuts, patch.shortcuts);
  if ('saveDir' in patch) next.saveDir = patch.saveDir || null;
  if (typeof patch.autoUpdate === 'boolean') next.autoUpdate = patch.autoUpdate;

  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('[took] 写入设置失败:', err);
  }
  return get();
}

/** Where captures land. Falls back to 图片/Took, then the home directory. */
function saveDir() {
  const configured = load().saveDir;
  if (configured) {
    try {
      fs.mkdirSync(configured, { recursive: true });
      return configured;
    } catch (err) {
      // Drive unplugged, folder deleted, permissions changed — do not lose the
      // capture over it, just fall back.
      console.warn('[took] 保存目录不可用，退回默认:', err.message);
    }
  }

  try {
    const dir = path.join(app.getPath('pictures'), 'Took');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.homedir();
  }
}

/** Can we actually write there? Used to validate before accepting a new path. */
function checkWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.took-write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/**
 * True only the very first time Took starts on this account, and from then on
 * false. A settings.json also counts as having started before, so updating
 * from a version without the marker does not look like a fresh install.
 * Uninstalling deletes the whole data folder, so a reinstall starts afresh.
 */
function firstLaunch() {
  const marker = path.join(app.getPath('userData'), 'launched');
  if (fs.existsSync(marker) || fs.existsSync(file())) return false;

  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
  } catch (err) {
    console.error('[took] 写入首次启动标记失败:', err);
  }
  return true;
}

module.exports = { DEFAULTS, get, set, saveDir, checkWritable, file, firstLaunch };

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
    ocr: 'CommandOrControl+Shift+X',
  },
  // null means "wherever saveDir() lands", i.e. Pictures/Took
  saveDir: null,
  // 'direct' writes captures straight into saveDir; 'ask' shows a save dialog
  // every time. Direct is what a set save location suggests, and it is what was
  // asked for once the dialog turned out to be the only way to save.
  saveMode: 'direct',
  // Check, download and install updates without being asked.
  autoUpdate: true,
};

const SAVE_MODES = ['direct', 'ask'];

let cache = null;
// The file is there but could not be read — a hand edit with a typo, say. Only
// a change made in the settings window may write over it, not a save that
// merely went somewhere.
let unreadable = false;

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
      saveDir: nonEmpty(raw.saveDir),
      saveMode: SAVE_MODES.includes(raw.saveMode) ? raw.saveMode : DEFAULTS.saveMode,
      autoUpdate: typeof raw.autoUpdate === 'boolean' ? raw.autoUpdate : DEFAULTS.autoUpdate,
      // Not a preference: the folder the last save went into, so a save dialog
      // can open there. Kept out of get(), so the settings window never sees
      // it — and never sends back a stale copy.
      lastSaveDir: nonEmpty(raw.lastSaveDir),
    };
  } catch (err) {
    // Missing or corrupt — fall back to defaults rather than refusing to start.
    cache = { ...structuredClone(DEFAULTS), lastSaveDir: null };
    unreadable = err.code !== 'ENOENT';
  }
  return cache;
}

function nonEmpty(value) {
  return typeof value === 'string' && value ? value : null;
}

/** The preferences, as the settings window shows them. */
function get() {
  const { lastSaveDir, ...prefs } = load();
  return structuredClone(prefs);
}

function set(patch) {
  const next = load();

  if (patch.language) next.language = normalizeLanguage(patch.language);
  if (patch.shortcuts) Object.assign(next.shortcuts, patch.shortcuts);
  if ('saveDir' in patch) {
    const dir = patch.saveDir || null;
    // Choosing a save location says where saving should start from now on —
    // not wherever the last save happened to go.
    if (dir !== next.saveDir) next.lastSaveDir = null;
    next.saveDir = dir;
  }
  if (SAVE_MODES.includes(patch.saveMode)) next.saveMode = patch.saveMode;
  if (typeof patch.autoUpdate === 'boolean') next.autoUpdate = patch.autoUpdate;

  persist();
  return get();
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(load(), null, 2), 'utf8');
    unreadable = false;
  } catch (err) {
    console.error('[took] 写入设置失败:', err);
  }
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
  return defaultSaveDir();
}

/** 图片/Took, or the home directory should even that not be possible. */
function defaultSaveDir() {
  try {
    const dir = path.join(app.getPath('pictures'), 'Took');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.homedir();
  }
}

/** Remember the folder a save just went into, across restarts. */
function rememberSaveDir(dir) {
  const next = load();
  if (!dir || next.lastSaveDir === dir) return;
  next.lastSaveDir = dir;
  // Still remembered until Took quits, just not written over a broken file.
  if (!unreadable) persist();
}

/**
 * Where a save dialog opens: the folder the last save went into, while it is
 * still there; otherwise the save location.
 */
function dialogDir() {
  const last = load().lastSaveDir;
  if (last) {
    try {
      if (fs.statSync(last).isDirectory()) return last;
    } catch {
      // Gone since — renamed, deleted, drive unplugged.
    }
  }
  return saveDir();
}

/**
 * Of the hotkeys that would not register, the ones a save has to be refused
 * over: those it changed. One that was already unavailable before — taken by
 * another program in the meantime — must not stop every other setting from
 * saving.
 */
function refusedShortcuts(conflicts, before, after) {
  return conflicts.filter((action) => before.shortcuts[action] !== after.shortcuts[action]);
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

module.exports = {
  DEFAULTS,
  get,
  set,
  saveDir,
  defaultSaveDir,
  dialogDir,
  rememberSaveDir,
  checkWritable,
  refusedShortcuts,
  file,
  firstLaunch,
};

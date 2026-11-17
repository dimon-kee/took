'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Saving a capture the way the settings ask: straight into the save location,
 * or through a dialog that opens in the folder the last save went into.
 *
 * Screenshots, scrolling screenshots, pinned images and recordings all save
 * through here, so they behave alike. Kept out of src/main/index.js so
 * `task check:settings` can drive it with a stand-in dialog.
 */

/**
 * Write `source` into `dir` as `<name>.<ext>` — or `<name> (2).<ext>` and so
 * on, should that be taken. Creates the folder if it is missing. Never
 * replaces anything: each name is claimed by creating the file exclusively, so
 * two saves in the same second each get a file of their own.
 * @param source the bytes, or `{ copyFrom }` a file to copy
 * @returns the path written
 */
function writeNew(dir, name, ext, source) {
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const file = path.join(dir, n === 1 ? `${name}.${ext}` : `${name} (${n}).${ext}`);
    try {
      write(file, source, true);
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`No free file name for ${name}.${ext} in ${dir}`);
}

/**
 * @param exclusive fail with EEXIST rather than replace a file already there
 */
function write(file, source, exclusive) {
  if (!Buffer.isBuffer(source)) {
    fs.copyFileSync(source.copyFrom, file, exclusive ? fs.constants.COPYFILE_EXCL : 0);
    return;
  }

  // Opened before writing, so a write that fails part way only ever takes
  // back a file this call created — never one that was there before.
  const fd = fs.openSync(file, exclusive ? 'wx' : 'w');
  let written = false;
  try {
    fs.writeFileSync(fd, source);
    written = true;
  } finally {
    fs.closeSync(fd);
    if (!written && exclusive) fs.rmSync(file, { force: true });
  }
}

/**
 * @param deps.settings        src/main/settings.js, or a stand-in for it
 * @param deps.showSaveDialog  `(win, options) => Promise<{ canceled, filePath }>`
 * @param deps.t               the translator
 */
function createSaver({ settings, showSaveDialog, t }) {
  /**
   * @param win the window asking — the dialog opens over it
   * @param job.name    file name, without the extension
   * @param job.ext     extension, without the dot
   * @param job.title   the dialog's title
   * @param job.filter  the dialog's name for the file type
   * @param job.source  the bytes, or `{ copyFrom }` a file to copy
   * @returns `{ file, asked, movedFrom }` once it is written, or null if the
   *          dialog was cancelled. `movedFrom` is the save location when it
   *          could not be reached, so the file went to Pictures/Took instead.
   *          Throws if the file cannot be written where the dialog said.
   */
  async function save(win, job) {
    let failedDir = null;

    if (settings.get().saveMode === 'direct') {
      const wanted = settings.get().saveDir;
      // Falls back to Pictures/Took if the folder cannot even be created.
      const dir = settings.saveDir();
      try {
        const file = writeNew(dir, job.name, job.ext, job.source);
        settings.rememberSaveDir(dir);
        return { file, asked: false, movedFrom: wanted && wanted !== dir ? wanted : null };
      } catch (err) {
        // There, but not writable — read-only, full, a file in the way. Ask
        // where else to put it rather than lose the capture.
        console.warn('[took] 直接保存失败，改为询问:', err.message);
        failedDir = dir;
      }
    }

    let start = settings.dialogDir();
    if (start === failedDir) start = settings.defaultSaveDir();

    const { canceled, filePath } = await showSaveDialog(win, {
      title: failedDir ? t('dialog.saveFailed', { dir: failedDir }) : job.title,
      defaultPath: path.join(start, `${job.name}.${job.ext}`),
      filters: [{ name: job.filter, extensions: [job.ext] }],
    });
    if (canceled || !filePath) return null;

    // The dialog has already asked before replacing a file that is there.
    write(filePath, job.source, false);
    settings.rememberSaveDir(path.dirname(filePath));
    return { file: filePath, asked: true, movedFrom: null };
  }

  return { save };
}

module.exports = { createSaver, writeNew };

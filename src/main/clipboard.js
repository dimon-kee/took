'use strict';

const { clipboard, ClipboardItem } = require('electron');

/**
 * Clipboard writes, on the promise-based API Electron 44 moved to. The old
 * synchronous helpers (writeImage, writeBuffer, …) are gone from the module,
 * and calling one throws — which left the screenshot ✓ doing nothing at all.
 *
 * Formats that belong together have to go into one ClipboardItem: every write
 * replaces the whole clipboard, so two writes in a row keep only the second.
 */

// Windows' registered "FileNameW" format. Given that, the system also offers
// the CF_HDROP file drop that Explorer and chat apps paste from.
const FILE_NAME_W = 'electron application/osclipboard;format="FileNameW"';

/** The bytes behind a PNG data URL — which is what every renderer sends. */
function pngFromDataURL(dataURL) {
  return Buffer.from(dataURL.slice(dataURL.indexOf(',') + 1), 'base64');
}

function copyImage(png) {
  return clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

/** Put a file on the clipboard, so it pastes as the file itself. */
function copyFile(file) {
  return clipboard.write([
    new ClipboardItem({ [FILE_NAME_W]: new Blob([Buffer.from(`${file}\0`, 'ucs2')]) }),
  ]);
}

function copyText(text) {
  return clipboard.writeText(String(text));
}

module.exports = { pngFromDataURL, copyImage, copyFile, copyText };

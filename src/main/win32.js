'use strict';

/**
 * Small Win32 bits that Electron does not expose.
 *
 * Every entry point degrades to a no-op when the FFI binding is unavailable, so
 * a missing or broken koffi never stops the app from running — it just loses
 * the polish.
 */

const DWMWA_TRANSITIONS_FORCEDISABLED = 3;

let DwmSetWindowAttribute = null;

if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const dwmapi = koffi.load('dwmapi.dll');
    DwmSetWindowAttribute = dwmapi.func(
      'int32 __stdcall DwmSetWindowAttribute(uint64 hwnd, uint32 attr, void *value, uint32 size)'
    );
  } catch (err) {
    console.warn('[took] dwmapi 不可用，窗口动画无法关闭:', err.message);
  }
}

function handleOf(win) {
  if (!win || win.isDestroyed()) return null;
  const buffer = win.getNativeWindowHandle();
  // HWND is pointer-sized: 8 bytes on the x64 builds we ship.
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
}

/**
 * Suppress the open/close animation for a window.
 *
 * The overlay covers the whole screen, so Windows' default fade-and-scale is
 * very visible — it reads as the app "launching" every time you hit the hotkey
 * rather than a screenshot freezing instantly.
 *
 * @returns true when the attribute was applied
 */
function disableWindowAnimations(win) {
  if (!DwmSetWindowAttribute) return false;

  const hwnd = handleOf(win);
  if (hwnd === null) return false;

  try {
    const value = Buffer.alloc(4);
    value.writeInt32LE(1, 0); // TRUE — force transitions off
    const hr = DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, value, 4);
    return hr === 0;
  } catch (err) {
    console.warn('[took] 关闭窗口动画失败:', err.message);
    return false;
  }
}

module.exports = { disableWindowAnimations, available: () => Boolean(DwmSetWindowAttribute) };

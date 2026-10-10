'use strict';

/**
 * Small Win32 bits that Electron does not expose.
 *
 * Every entry point degrades to a no-op when the FFI binding is unavailable, so
 * a missing or broken koffi never stops the app from running — it just loses
 * the polish.
 */

const DWMWA_TRANSITIONS_FORCEDISABLED = 3;
const SRCCOPY = 0x00cc0020;
// Includes layered windows — menus, tooltips, anything with a drop shadow.
const CAPTUREBLT = 0x40000000;

let DwmSetWindowAttribute = null;
let gdi = null;

if (process.platform === 'win32') {
  let koffi = null;
  try {
    koffi = require('koffi');
    const dwmapi = koffi.load('dwmapi.dll');
    DwmSetWindowAttribute = dwmapi.func(
      'int32 __stdcall DwmSetWindowAttribute(uint64 hwnd, uint32 attr, void *value, uint32 size)'
    );
  } catch (err) {
    console.warn('[took] dwmapi 不可用，窗口动画无法关闭:', err.message);
  }

  try {
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    koffi.struct('BITMAPINFOHEADER', {
      biSize: 'uint32',
      biWidth: 'int32',
      biHeight: 'int32',
      biPlanes: 'uint16',
      biBitCount: 'uint16',
      biCompression: 'uint32',
      biSizeImage: 'uint32',
      biXPelsPerMeter: 'int32',
      biYPelsPerMeter: 'int32',
      biClrUsed: 'uint32',
      biClrImportant: 'uint32',
    });
    gdi = {
      GetDC: user32.func('void * __stdcall GetDC(void *hwnd)'),
      ReleaseDC: user32.func('int __stdcall ReleaseDC(void *hwnd, void *hdc)'),
      CreateCompatibleDC: gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)'),
      CreateCompatibleBitmap: gdi32.func('void * __stdcall CreateCompatibleBitmap(void *hdc, int w, int h)'),
      SelectObject: gdi32.func('void * __stdcall SelectObject(void *hdc, void *obj)'),
      BitBlt: gdi32.func(
        'bool __stdcall BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32 rop)'
      ),
      GetDIBits: gdi32.func(
        'int __stdcall GetDIBits(void *hdc, void *bitmap, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ BITMAPINFOHEADER *info, uint32 usage)'
      ),
      DeleteObject: gdi32.func('bool __stdcall DeleteObject(void *obj)'),
      DeleteDC: gdi32.func('bool __stdcall DeleteDC(void *hdc)'),
    };
  } catch (err) {
    console.warn('[took] GDI 不可用，截屏改用抓流:', err && err.message);
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

/**
 * Copy a rectangle of the desktop, in physical pixels, straight out of GDI.
 *
 * About 35 ms for a 1080p display. The desktop MediaStream the overlay used to
 * open for every screenshot took ~330 ms to start and deliver its first frame
 * — the larger half of the wait between the hotkey and the overlay.
 *
 * @returns {{ width: number, height: number, pixels: Buffer } | null}
 *          top-down BGRX rows; the fourth byte of each pixel is undefined
 */
function grabScreen({ x, y, width, height }) {
  if (!gdi || width <= 0 || height <= 0) return null;

  const screenDC = gdi.GetDC(null);
  if (!screenDC) return null;
  const memDC = gdi.CreateCompatibleDC(screenDC);
  const bitmap = gdi.CreateCompatibleBitmap(screenDC, width, height);

  try {
    if (!memDC || !bitmap) return null;

    const previous = gdi.SelectObject(memDC, bitmap);
    const copied = gdi.BitBlt(memDC, 0, 0, width, height, screenDC, x, y, SRCCOPY | CAPTUREBLT);
    // GetDIBits wants the bitmap out of every DC first.
    gdi.SelectObject(memDC, previous);
    if (!copied) return null;

    const pixels = Buffer.allocUnsafe(width * height * 4);
    const info = {
      biSize: 40,
      biWidth: width,
      biHeight: -height, // negative: rows top-down, the way canvas wants them
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0, // BI_RGB
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    };
    const lines = gdi.GetDIBits(memDC, bitmap, 0, height, pixels, info, 0 /* DIB_RGB_COLORS */);
    return lines === height ? { width, height, pixels } : null;
  } catch (err) {
    console.warn('[took] GDI 截屏失败:', err.message);
    return null;
  } finally {
    if (bitmap) gdi.DeleteObject(bitmap);
    if (memDC) gdi.DeleteDC(memDC);
    gdi.ReleaseDC(null, screenDC);
  }
}

module.exports = {
  disableWindowAnimations,
  grabScreen,
  available: () => Boolean(DwmSetWindowAttribute),
};

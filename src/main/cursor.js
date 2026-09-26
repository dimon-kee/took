'use strict';

const { screen } = require('electron');

/**
 * Global cursor position and left-button edges, for the 鼠标高亮 / 增加点击效果
 * overlays drawn into a recording.
 *
 * Electron exposes the pointer position but has no global mouse hook, so the
 * button state comes from user32!GetAsyncKeyState via FFI. If that binding is
 * unavailable we still report positions and simply never fire clicks.
 */

const VK_LBUTTON = 0x01;
const POLL_MS = 16; // ~60Hz, fast enough not to miss a click

let getAsyncKeyState = null;
let ffiError = null;

try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  getAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
} catch (err) {
  ffiError = err;
  console.warn('[took] 无法加载鼠标钩子,点击效果将不可用:', err.message);
}

function isDown() {
  if (!getAsyncKeyState) return false;
  // High bit set means the button is currently down.
  return (getAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
}

/**
 * @param onSample called with { x, y, down, clicked } in global screen coords
 * @returns stop function
 */
function track(onSample) {
  let wasDown = isDown();

  const timer = setInterval(() => {
    let point;
    try {
      point = screen.getCursorScreenPoint();
    } catch {
      return; // can throw while displays are being reconfigured
    }

    const down = isDown();
    const clicked = down && !wasDown;
    wasDown = down;

    onSample({ x: point.x, y: point.y, down, clicked });
  }, POLL_MS);

  return () => clearInterval(timer);
}

module.exports = { track, clickSupported: () => Boolean(getAsyncKeyState), ffiError };

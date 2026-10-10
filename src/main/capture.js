'use strict';

const { desktopCapturer, screen } = require('electron');
const screens = require('./screens');
const win32 = require('./win32');

/**
 * Describes every display for the overlay.
 *
 * Carries no pixels: those come from grabDisplay below, as raw rows rather
 * than a PNG, so nothing is encoded in main or decoded in the renderer.
 */
function describeDisplays() {
  return screen.getAllDisplays().map((display) => ({
    displayId: display.id,
    // Only the stream fallback and a scrolling screenshot use it, and they
    // ask main when it is missing: the hotkey must never wait on getSources.
    sourceId: screens.cachedSourceId(display.id),
    bounds: display.bounds,
    // Display-local work area: the overlay keeps its toolbars inside this so
    // they never end up buried under the taskbar.
    workArea: {
      x: display.workArea.x - display.bounds.x,
      y: display.workArea.y - display.bounds.y,
      width: display.workArea.width,
      height: display.workArea.height,
    },
    scaleFactor: display.scaleFactor,
    // Expected native size. The overlay trusts the frame it actually gets
    // over this, but it is the right size to ask the stream for.
    pixelSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
  }));
}

/**
 * The display as it is right now, grabbed with GDI the moment the hotkey fires
 * — before any window of ours can appear on it.
 *
 * Null when GDI is unavailable or refuses (the secure desktop, for one); the
 * overlay then grabs its own frame from a desktop MediaStream, the old and
 * slower way.
 */
function grabDisplay(displayId) {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (!display) return null;
  // Main is per-monitor DPI aware, so the screen DC is in physical pixels.
  return win32.grabScreen(screen.dipToScreenRect(null, display.bounds));
}

/**
 * Slow path: a PNG data URL straight from desktopCapturer. Only used when the
 * overlay's MediaStream grab fails, so a broken stream still yields a usable
 * screenshot instead of nothing.
 */
async function captureDisplayImage(displayId) {
  const displays = screen.getAllDisplays();
  const index = displays.findIndex((d) => d.id === displayId);
  const display = displays[index] || screen.getPrimaryDisplay();

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    },
    fetchWindowIcons: false,
  });

  const source =
    sources.find((s) => String(s.display_id) === String(displayId)) || sources[index] || sources[0];
  if (!source) return null;

  // The ID list may be stale if the layout changed behind our back.
  screens.invalidate();
  return source.thumbnail.toDataURL();
}

module.exports = { describeDisplays, grabDisplay, captureDisplayImage };

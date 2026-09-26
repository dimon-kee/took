'use strict';

const { desktopCapturer, screen } = require('electron');
const screens = require('./screens');

/**
 * Describes every display for the overlay.
 *
 * Deliberately carries no pixels: the overlay grabs its own frame straight from
 * a desktop MediaStream, which skips a PNG encode in main, the IPC transfer of
 * a multi-megabyte data URL, and a decode in the renderer.
 */
async function describeDisplays() {
  const displays = screen.getAllDisplays();

  return Promise.all(
    displays.map(async (display) => ({
      displayId: display.id,
      sourceId: await screens.sourceIdFor(display.id),
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
    }))
  );
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

module.exports = { describeDisplays, captureDisplayImage };

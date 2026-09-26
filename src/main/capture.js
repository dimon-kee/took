'use strict';

const { desktopCapturer, screen } = require('electron');

/**
 * Grab every display at its native pixel resolution.
 *
 * desktopCapturer downscales to thumbnailSize, so we ask for the largest
 * display's device-pixel size and let the per-display match sort the rest out.
 * Returns one entry per display, ordered the same as screen.getAllDisplays().
 */
async function captureAllDisplays() {
  const displays = screen.getAllDisplays();

  const maxWidth = Math.max(...displays.map((d) => d.size.width * d.scaleFactor));
  const maxHeight = Math.max(...displays.map((d) => d.size.height * d.scaleFactor));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(maxWidth), height: Math.round(maxHeight) },
    fetchWindowIcons: false,
  });

  return displays.map((display, index) => {
    const source = matchSource(sources, display, index);
    const thumb = source ? source.thumbnail : null;

    return {
      displayId: display.id,
      sourceId: source ? source.id : null,
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
      // Native size of the bitmap we actually got back, which can differ from
      // bounds * scaleFactor when the OS reports a scaled desktop.
      pixelSize: thumb ? thumb.getSize() : { width: 0, height: 0 },
      dataURL: thumb ? thumb.toDataURL() : null,
    };
  });
}

function matchSource(sources, display, index) {
  const byId = sources.find((s) => String(s.display_id) === String(display.id));
  if (byId) return byId;

  // Windows sometimes leaves display_id empty; fall back to ordering, which
  // matches getAllDisplays() in practice.
  return sources[index] || null;
}

module.exports = { captureAllDisplays };

'use strict';

const { desktopCapturer, screen } = require('electron');

/**
 * Cache of desktopCapturer source IDs, one per display.
 *
 * desktopCapturer.getSources costs roughly a second on Windows no matter how
 * small a thumbnail you ask for — the price is the enumeration itself, not the
 * pixels. Paying that on every hotkey press is what made the overlay take two
 * seconds to appear, so the IDs are resolved once at startup and refreshed
 * whenever the display layout changes. Capture then only pays for the frame.
 */

let cache = new Map(); // displayId -> sourceId
let inFlight = null;

async function resolve() {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        // We only want the IDs; a 1x1 thumbnail is the cheapest ask, even
        // though it barely moves the total.
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });

      const next = new Map();
      screen.getAllDisplays().forEach((display, index) => {
        const match =
          sources.find((s) => String(s.display_id) === String(display.id)) || sources[index];
        if (match) next.set(display.id, match.id);
      });

      cache = next;
      return cache;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Kick off resolution without blocking; call once the app is ready. */
function warmUp() {
  resolve().catch((err) => console.warn('[took] 预解析屏幕源失败:', err.message));

  const invalidate = () => {
    cache = new Map();
    resolve().catch(() => {});
  };
  screen.on('display-added', invalidate);
  screen.on('display-removed', invalidate);
  screen.on('display-metrics-changed', invalidate);
}

/** Cached ID if we have one, otherwise resolve now. */
async function sourceIdFor(displayId) {
  if (cache.has(displayId)) return cache.get(displayId);
  const resolved = await resolve();
  return resolved.get(displayId) || null;
}

/** Drop the cache so the next lookup re-enumerates. */
function invalidate() {
  cache = new Map();
}

module.exports = { warmUp, sourceIdFor, invalidate };

'use strict';

const { desktopCapturer, screen } = require('electron');

/**
 * Cache of desktopCapturer source IDs, one per display.
 *
 * desktopCapturer.getSources blocks the main thread on Windows — one to three
 * seconds a call, every call, however small the thumbnail — and a hotkey
 * pressed meanwhile waits it out. So the IDs are resolved once at startup, and
 * after that only when something needs one the cache does not hold. Screenshots
 * no longer do (main grabs their pixels with GDI); a scrolling screenshot and
 * the stream fallback still do, and ask for theirs as they start.
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

  // Re-resolving straight away would stall main again at a moment someone may
  // well reach for the hotkey (just woken up, monitor plugged in) — so only
  // forget, and leave the next ask to resolve.
  screen.on('display-added', invalidate);
  screen.on('display-removed', invalidate);
  screen.on('display-metrics-changed', (_e, _display, changed) => {
    // The taskbar resizing changes nothing about which source is which.
    if (changed.some((metric) => metric !== 'workArea')) invalidate();
  });
}

/** The cached ID, or null — never waits. */
function cachedSourceId(displayId) {
  return cache.get(displayId) || null;
}

/** Cached ID if we have one, otherwise resolve now — which stalls main. */
async function sourceIdFor(displayId) {
  if (cache.has(displayId)) return cache.get(displayId);
  const resolved = await resolve();
  return resolved.get(displayId) || null;
}

/** Drop the cache so the next lookup re-enumerates. */
function invalidate() {
  cache = new Map();
}

module.exports = { warmUp, cachedSourceId, sourceIdFor, invalidate };

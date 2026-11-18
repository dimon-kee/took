'use strict';

/**
 * Decisions main makes for the overlays — one per display — as a choice made
 * on one of them carries over to the others. Kept apart from index.js so the
 * two-display check can run the very same code.
 */

const SWITCHES = ['speaker', 'mic', 'camera', 'cursor', 'mouseHighlight', 'clickEffect'];
const DEVICES = ['micId', 'cameraId'];

/**
 * The 录屏 card's options as one overlay sends them to be passed on to the
 * others. The others assign them straight into their own, so only a set of
 * exactly these keys, each of the right type, gets through.
 * @returns the card's options with nothing else, or null if any is malformed
 */
function cleanRecOptions(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.format !== 'mp4' && rec.format !== 'gif') return null;
  const clean = { format: rec.format };
  for (const key of SWITCHES) {
    if (typeof rec[key] !== 'boolean') return null;
    clean[key] = rec[key];
  }
  for (const key of DEVICES) {
    if (rec[key] !== null && typeof rec[key] !== 'string') return null;
    clean[key] = rec[key];
  }
  return clean;
}

/**
 * Whether the webcam bubble already up can stay as it is for a request to
 * show it: the same camera, asked for by the overlay it was placed for —
 * which may have moved it. Once the selection is on another display the
 * camera choice follows it there, and so must the bubble: one left behind
 * sits outside what gets filmed.
 * @param {{ owner: number, deviceId: string|null }|null} bubble
 * @param {{ owner: number, deviceId: string|null }} request
 */
function webcamStays(bubble, request) {
  return Boolean(bubble) && bubble.owner === request.owner && bubble.deviceId === request.deviceId;
}

module.exports = { cleanRecOptions, webcamStays };

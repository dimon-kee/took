'use strict';

/**
 * Text recognition on a screenshot: PP-OCRv6 finds the lines of text, then
 * reads each one, both run through onnxruntime.
 *
 * The steps are RapidOCR's (Apache-2.0) — the pipeline the models were picked
 * with — so they score the same here. Two things a screenshot never needs are
 * left out: text is never upside down, so there is no direction classifier,
 * and screen text runs straight across, so a line's box is taken square to the
 * screen instead of as a rotated rectangle.
 *
 * Added on top: the crop gets a margin of its own background first (text that
 * touches the edge reads badly), and pieces of one line that detection split —
 * around an inline code chip, say — are joined back together.
 *
 * Pixels travel as tightly packed BGR, the order the models were trained on.
 */

const MARGIN = 32;

// RapidOCR's defaults.
const MIN_SIDE = 30;
const MAX_SIDE = 2000;
const WIDE_RATIO = 8;
const MIN_HEIGHT = 30;
const DET_SIDE = 736;
const DET_THRESH = 0.3;
const BOX_THRESH = 0.5;
const UNCLIP_RATIO = 1.6;
const MIN_BOX = 3;
const REC_HEIGHT = 48;
const REC_WIDTH = 320;
const REC_BATCH = 6;

// Higher than RapidOCR's 0.5: what scores below this is mostly an icon read as
// a character or two.
const MIN_SCORE = 0.8;

// ---------------------------------------------------------------------------
// recogniser
// ---------------------------------------------------------------------------

/**
 * Load both models. Resolves to `recognize(image)`, which takes RGBA pixels
 * `{ width, height, data }` and resolves to the text, one string per line.
 */
async function createRecognizer({ detModel, recModel, keys, threads }) {
  const ort = require('onnxruntime-node');

  const options = {
    executionProviders: ['cpu'],
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    // The arena keeps whatever the largest image needed for as long as the
    // session lives; without it, memory goes back after each image.
    enableCpuMemArena: false,
  };
  const det = await ort.InferenceSession.create(detModel, options);
  const rec = await ort.InferenceSession.create(recModel, options);

  async function recognize({ width, height, data }) {
    let img = padImage(data, width, height, MARGIN);

    const bounds = boundsSize(img.width, img.height);
    if (bounds.width !== img.width || bounds.height !== img.height) {
      img = {
        data: resizeBilinear(img.data, img.width, img.height, 3, bounds.width, bounds.height),
        width: bounds.width,
        height: bounds.height,
      };
    }

    const pad = verticalPadding(img.width, img.height);
    if (pad) img = padRows(img, pad);

    const boxes = await detect(img);
    if (!boxes.length) return [];

    const crops = boxes.map((b) => cropBox(img, b));
    const read = await readCrops(crops);

    const kept = [];
    read.forEach((r, i) => {
      if (r.text.trim() && r.score >= MIN_SCORE) kept.push({ ...boxes[i], text: r.text });
    });
    return mergeLines(kept);
  }

  async function detect(img) {
    const size = detSize(img.width, img.height);
    const resized = resizeBilinear(img.data, img.width, img.height, 3, size.width, size.height);
    const input = toTensorData(resized, size.width, size.height, size.width);

    const feeds = { [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size.height, size.width]) };
    const out = (await det.run(feeds))[det.outputNames[0]];
    const [, , mapH, mapW] = out.dims;
    return findBoxes(out.data, mapW, mapH, img.width, img.height);
  }

  /** Recognise crops in batches of similar shape, as RapidOCR does. */
  async function readCrops(crops) {
    const order = crops.map((c, i) => i).sort((a, b) => ratio(crops[a]) - ratio(crops[b]));
    const results = new Array(crops.length);

    for (let start = 0; start < order.length; start += REC_BATCH) {
      const batch = order.slice(start, start + REC_BATCH);
      const maxRatio = Math.max(REC_WIDTH / REC_HEIGHT, ...batch.map((i) => ratio(crops[i])));
      const width = Math.trunc(REC_HEIGHT * maxRatio);

      const input = new Float32Array(batch.length * 3 * REC_HEIGHT * width);
      batch.forEach((i, n) => {
        const crop = crops[i];
        const fit = Math.min(Math.ceil(REC_HEIGHT * ratio(crop)), width);
        const resized = resizeBilinear(crop.data, crop.width, crop.height, 3, fit, REC_HEIGHT);
        // Left-aligned; the rest of the row stays 0, i.e. mid-grey once normalised.
        input.set(toTensorData(resized, fit, REC_HEIGHT, width), n * 3 * REC_HEIGHT * width);
      });

      const feeds = { [rec.inputNames[0]]: new ort.Tensor('float32', input, [batch.length, 3, REC_HEIGHT, width]) };
      const out = (await rec.run(feeds))[rec.outputNames[0]];
      const [n, steps, classes] = out.dims;
      ctcDecode(out.data, n, steps, classes, keys).forEach((r, k) => {
        results[batch[k]] = r;
      });
    }
    return results;
  }

  return {
    recognize,
    release: () => Promise.all([det.release(), rec.release()]),
  };
}

const ratio = (img) => img.width / img.height;

// ---------------------------------------------------------------------------
// image steps
// ---------------------------------------------------------------------------

/**
 * RGBA in, BGR out, with `pad` pixels added on every side in the colour most
 * of the border has — the background, nearly always.
 */
function padImage(rgba, width, height, pad) {
  const counts = new Map();
  const tally = (x, y) => {
    const i = (y * width + x) * 4;
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (let x = 0; x < width; x++) {
    tally(x, 0);
    tally(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    tally(0, y);
    tally(width - 1, y);
  }
  let bg = 0;
  let best = -1;
  for (const [key, n] of counts) {
    if (n > best) {
      best = n;
      bg = key;
    }
  }

  const w = width + pad * 2;
  const h = height + pad * 2;
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    out[i * 3] = bg & 0xff;
    out[i * 3 + 1] = (bg >> 8) & 0xff;
    out[i * 3 + 2] = (bg >> 16) & 0xff;
  }
  for (let y = 0; y < height; y++) {
    let o = ((y + pad) * w + pad) * 3;
    let s = y * width * 4;
    for (let x = 0; x < width; x++, o += 3, s += 4) {
      out[o] = rgba[s + 2];
      out[o + 1] = rgba[s + 1];
      out[o + 2] = rgba[s];
    }
  }
  return { data: out, width: w, height: h };
}

/** Black rows above and below — RapidOCR's letterbox for wide or short images. */
function padRows(img, pad) {
  const rowBytes = img.width * 3;
  const out = new Uint8Array(rowBytes * (img.height + pad * 2));
  out.set(img.data, rowBytes * pad);
  return { data: out, width: img.width, height: img.height + pad * 2 };
}

/**
 * Resize interleaved 8-bit pixels the way OpenCV's INTER_LINEAR does: pixel
 * centres aligned, edges clamped, two-by-two neighbours only.
 */
function resizeBilinear(src, sw, sh, channels, dw, dh) {
  const out = new Uint8Array(dw * dh * channels);
  const sx = sw / dw;
  const sy = sh / dh;

  const xs = new Int32Array(dw * 2);
  const xw = new Float64Array(dw);
  for (let x = 0; x < dw; x++) {
    const f = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), sw - 1);
    const x0 = Math.floor(f);
    xs[x * 2] = x0;
    xs[x * 2 + 1] = Math.min(x0 + 1, sw - 1);
    xw[x] = f - x0;
  }

  for (let y = 0; y < dh; y++) {
    const f = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), sh - 1);
    const y0 = Math.floor(f);
    const y1 = Math.min(y0 + 1, sh - 1);
    const wy = f - y0;
    const row0 = y0 * sw * channels;
    const row1 = y1 * sw * channels;

    for (let x = 0; x < dw; x++) {
      const a = xs[x * 2] * channels;
      const b = xs[x * 2 + 1] * channels;
      const wx = xw[x];
      const o = (y * dw + x) * channels;
      for (let c = 0; c < channels; c++) {
        const top = src[row0 + a + c] + (src[row0 + b + c] - src[row0 + a + c]) * wx;
        const bottom = src[row1 + a + c] + (src[row1 + b + c] - src[row1 + a + c]) * wx;
        out[o + c] = Math.round(top + (bottom - top) * wy);
      }
    }
  }
  return out;
}

/** BGR bytes → normalised planar floats, `stride` wide (any extra stays 0). */
function toTensorData(bgr, width, height, stride) {
  const plane = stride * height;
  const out = new Float32Array(plane * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const o = y * stride + x;
      out[o] = (bgr[s] / 255 - 0.5) / 0.5;
      out[plane + o] = (bgr[s + 1] / 255 - 0.5) / 0.5;
      out[plane * 2 + o] = (bgr[s + 2] / 255 - 0.5) / 0.5;
    }
  }
  return out;
}

/** The whole image kept between 30 and 2000 px a side, in multiples of 32 when resized. */
function boundsSize(width, height) {
  let w = width;
  let h = height;
  if (Math.max(w, h) > MAX_SIDE) ({ width: w, height: h } = scaled(w, h, MAX_SIDE / (h > w ? h : w)));
  if (Math.min(w, h) < MIN_SIDE) ({ width: w, height: h } = scaled(w, h, MIN_SIDE / (h < w ? h : w)));
  return { width: w, height: h };
}

/** Padding above and below, so the detector never sees a sliver. */
function verticalPadding(width, height) {
  if (height > MIN_HEIGHT && width / height <= WIDE_RATIO) return 0;
  const target = Math.max(Math.trunc(width / WIDE_RATIO), MIN_HEIGHT) * 2;
  return Math.trunc(Math.abs(target - height) / 2);
}

/** The detector's input: short side brought up to 736, both sides multiples of 32. */
function detSize(width, height) {
  const r = Math.min(width, height) < DET_SIDE ? DET_SIDE / (height < width ? height : width) : 1;
  return scaled(width, height, r);
}

function scaled(width, height, r) {
  return {
    width: pyRound(Math.trunc(width * r) / 32) * 32,
    height: pyRound(Math.trunc(height * r) / 32) * 32,
  };
}

/** Crop a box out of the image; one standing on end is turned to lie flat. */
function cropBox(img, { x0, y0, x1, y1 }) {
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * img.width + x0) * 3;
    data.set(img.data.subarray(s, s + w * 3), y * w * 3);
  }
  if (h / w < 1.5) return { data, width: w, height: h };

  // A quarter turn anticlockwise, as numpy's rot90.
  const turned = new Uint8Array(w * h * 3);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < h; x++) {
      const s = (x * w + (w - 1 - y)) * 3;
      const o = (y * h + x) * 3;
      turned[o] = data[s];
      turned[o + 1] = data[s + 1];
      turned[o + 2] = data[s + 2];
    }
  }
  return { data: turned, width: h, height: w };
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

/**
 * The text boxes in a detection probability map (`mapW`×`mapH`), in the
 * coordinates of the `destW`×`destH` image it came from.
 *
 * DB post-processing: threshold, grow each blob a pixel right and down, keep
 * blobs big and confident enough, push each box out by a margin proportional
 * to its size.
 */
function findBoxes(prob, mapW, mapH, destW, destH) {
  const n = mapW * mapH;
  const on = new Uint8Array(n);
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const i = y * mapW + x;
      on[i] =
        prob[i] > DET_THRESH ||
        (x > 0 && prob[i - 1] > DET_THRESH) ||
        (y > 0 && prob[i - mapW] > DET_THRESH) ||
        (x > 0 && y > 0 && prob[i - mapW - 1] > DET_THRESH)
          ? 1
          : 0;
    }
  }

  const boxes = [];
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);

  for (let start = 0; start < n; start++) {
    if (!on[start] || seen[start]) continue;

    // Eight-connected, like the contours OpenCV traces.
    let x0 = mapW;
    let y0 = mapH;
    let x1 = -1;
    let y1 = -1;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const i = stack[--top];
      const x = i % mapW;
      const y = (i - x) / mapW;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= mapH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= mapW) continue;
          const j = ny * mapW + nx;
          if (on[j] && !seen[j]) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }

    // Measured between pixel centres, as a contour's points are.
    const w = x1 - x0;
    const h = y1 - y0;
    if (Math.min(w, h) < MIN_BOX) continue;

    let sum = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) sum += prob[y * mapW + x];
    }
    const score = sum / ((w + 1) * (h + 1));
    if (score < BOX_THRESH) continue;

    // Clipper's offset, which lands on whole pixels.
    const d = (w * h * UNCLIP_RATIO) / (2 * (w + h));
    const ex0 = clipperRound(x0 - d);
    const ey0 = clipperRound(y0 - d);
    const ex1 = clipperRound(x1 + d);
    const ey1 = clipperRound(y1 + d);
    if (Math.min(ex1 - ex0, ey1 - ey0) < MIN_BOX + 2) continue;

    const sx = (v) => Math.min(Math.max(pyRound((v / mapW) * destW), 0), destW - 1);
    const sy = (v) => Math.min(Math.max(pyRound((v / mapH) * destH), 0), destH - 1);
    const b = { x0: sx(ex0), y0: sy(ey0), x1: sx(ex1), y1: sy(ey1), score };
    if (b.x1 - b.x0 <= MIN_BOX || b.y1 - b.y0 <= MIN_BOX) continue;
    boxes.push(b);
  }
  return boxes;
}

/** Python's round(): halves go to the even neighbour. */
function pyRound(v) {
  return Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : Math.round(v);
}

/** Clipper's Round(): halves go away from zero. */
function clipperRound(v) {
  return v < 0 ? Math.trunc(v - 0.5) : Math.trunc(v + 0.5);
}

// ---------------------------------------------------------------------------
// recognition
// ---------------------------------------------------------------------------

/**
 * Greedy CTC decoding of `n` rows of `steps`×`classes` probabilities. Class 0
 * is the blank, then `keys` in order, then a space. A line scores the mean
 * probability of the characters it kept.
 */
function ctcDecode(probs, n, steps, classes, keys) {
  const results = [];
  for (let b = 0; b < n; b++) {
    let text = '';
    const confs = [];
    let prev = -1;
    for (let t = 0; t < steps; t++) {
      const base = (b * steps + t) * classes;
      let best = 0;
      let max = probs[base];
      for (let c = 1; c < classes; c++) {
        if (probs[base + c] > max) {
          max = probs[base + c];
          best = c;
        }
      }
      if (best !== 0 && best !== prev) {
        text += best === keys.length + 1 ? ' ' : keys[best - 1];
        confs.push(round5(max));
      }
      prev = best;
    }
    const score = confs.length ? round5(confs.reduce((a, c) => a + c, 0) / confs.length) : 0;
    results.push({ text, score });
  }
  return results;
}

const round5 = (v) => Number(v.toFixed(5));

// ---------------------------------------------------------------------------
// lines
// ---------------------------------------------------------------------------

// CJK scripts and punctuation, Hangul, and full-width forms.
const CJK = new RegExp('[\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef]');

/**
 * Join recognised pieces `{ text, x0, y0, x1, y1 }` into lines, top to bottom.
 * Pieces that share most of their height are one line, read left to right.
 * Chinese meeting Chinese is joined directly, anything else with a space.
 */
function mergeLines(pieces) {
  const rows = [];
  [...pieces]
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .forEach((p) => {
      let best = null;
      let bestOverlap = 0;
      rows.forEach((row) => {
        const overlap = Math.min(row.y1, p.y1) - Math.max(row.y0, p.y0);
        const share = overlap / Math.min(row.y1 - row.y0, p.y1 - p.y0);
        if (share >= 0.5 && share > bestOverlap) {
          best = row;
          bestOverlap = share;
        }
      });
      if (best) {
        best.pieces.push(p);
        best.y0 = Math.min(best.y0, p.y0);
        best.y1 = Math.max(best.y1, p.y1);
      } else {
        rows.push({ y0: p.y0, y1: p.y1, pieces: [p] });
      }
    });

  return rows
    .sort((a, b) => a.y0 - b.y0)
    .map((row) =>
      row.pieces
        .sort((a, b) => a.x0 - b.x0)
        .reduce((line, p) => {
          if (!line) return p.text;
          const joined = CJK.test(line[line.length - 1]) && CJK.test(p.text[0]);
          return line + (joined ? '' : ' ') + p.text;
        }, '')
    );
}

module.exports = {
  createRecognizer,
  padImage,
  resizeBilinear,
  boundsSize,
  verticalPadding,
  detSize,
  findBoxes,
  ctcDecode,
  mergeLines,
};

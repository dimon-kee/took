'use strict';

/**
 * Stitches a scrolling capture together. Pure logic over RGBA frames — no DOM
 * — so tools/check-stitch.js can run it headless against synthetic pages.
 *
 * Every frame is the same crop of the screen. Each one is compared with the
 * last accepted frame to find how far the content moved — up or down — and
 * rows that come into view beyond what has been captured are added at that
 * end. push() only works out which rows of the frame go where in the result;
 * the caller does the copying.
 *
 * What makes that harder than it sounds:
 *   - Fixed bars (a sticky header, a chat input box) do not scroll. Rows that
 *     stay identical at the same height, counted in from the top and from the
 *     bottom, are treated as fixed: the header rides along at the top of the
 *     result and the footer at the bottom, however far it grows either way.
 *   - The mouse pointer is in the captured frames, sitting still over content
 *     that moves. Rows it covers are written anyway, so the image never has a
 *     gap, but marked dirty and redone from a later frame where the pointer is
 *     somewhere else.
 *   - A blank row matches every other blank row, so only rows with more than
 *     one colour get a vote when working out the offset.
 */
window.TookStitch = (() => {
  // Signatures leave out this many pixels on the right, where a scrollbar
  // thumb slides as the content moves and would spoil every row it spans.
  const SCROLLBAR = 20;
  // A signature that turns up this often in one frame (a table rule, a
  // repeated border) says nothing about where a row came from — no vote.
  const COMMON = 6;
  // An offset must be borne out by at least this many different rows — four
  // distinct lines of text agreeing is proof, four copies of one rule is not...
  const MIN_DISTINCT = 4;
  // ...and by this share of the rows the two frames have in common. Rows are
  // compared exactly, so the true offset agrees on nearly all of them; a page
  // that repeats itself — the same picture twice, identical list items — can
  // line up on the repeat alone, and that has to fall short of this.
  const MIN_MATCH = 0.85;
  // How many of the most-voted offsets get checked against the whole overlap.
  const CANDIDATES = 4;

  /**
   * One hash per row, over pixels cut to 5 bits a channel so a one-step
   * antialiasing difference usually still matches. `info` marks rows with more
   * than one colour — the only ones that can say where they came from.
   */
  function signatures(rgba, width, height) {
    const sig = new Uint32Array(height);
    const info = new Uint8Array(height);
    const used = width > SCROLLBAR * 8 ? width - SCROLLBAR : width;

    for (let y = 0; y < height; y++) {
      const start = y * width * 4;
      const end = start + used * 4;
      const first = pack(rgba, start);
      let hash = 0x811c9dc5;
      let varied = 0;

      for (let i = start; i < end; i += 4) {
        const v = pack(rgba, i);
        hash = Math.imul(hash ^ v, 0x01000193);
        if (v !== first) varied = 1;
      }

      sig[y] = hash >>> 0;
      info[y] = varied;
    }

    return { sig, info };
  }

  function pack(rgba, i) {
    return ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
  }

  function within(y, range) {
    return Boolean(range) && y >= range[0] && y < range[1];
  }

  /**
   * The result grows at either end: scroll down past what has been captured
   * and rows are added at the bottom, scroll up past it and they are added at
   * the top. Rows are numbered from the first frame's top edge, so they go
   * negative when the capture grows upward — ops carry those numbers, and
   * `lo`/`hi` say which range currently makes up the image.
   *
   * @param width,height  size of every frame, in pixels
   * @param maxLength     tallest the result may grow
   */
  function create(width, height, maxLength) {
    // Indexed by row + maxLength, so rows down to -maxLength fit.
    const dirty = new Uint8Array(maxLength * 2);
    // What the image holds, row by row: the signature of whichever frame row
    // was written there. A new position can then be checked against the whole
    // image, not just against the one frame before it.
    const known = new Uint32Array(maxLength * 2);
    const knownInfo = new Uint8Array(maxLength * 2);
    // Anything that changes less than this between two frames is a hover or a
    // blinking caret, not a scroll.
    const minBand = Math.max(12, Math.round(height * 0.12));

    let last = null; // the frame the stitcher is lined up with
    let lo = 0; // the result is rows [lo, hi)
    let hi = 0;
    let pos = 0; // where `last` sits: its row y is result row pos + y
    let top = 0; // fixed header height, as of the latest scroll...
    let bottom = 0; // ...and fixed footer height

    /**
     * @param rgba     the frame's pixels
     * @param pointer  [from, to) — rows the pointer may cover, or null
     * @returns {{ kind: string, ops: {from: number, rows: number, to: number}[],
     *             lo: number, hi: number, pos: number, length: number, dy?: number }}
     *   kind is one of first | appended | moved | cleaned | same | changed |
     *   lost | full. Each op copies `rows` rows of this frame, starting at
     *   `from`, into the result at row `to`.
     */
    function push(rgba, pointer) {
      const cur = { ...signatures(rgba, width, height), pointer };

      if (!last) return begin(cur);

      const skip = (y) => within(y, cur.pointer) || within(y, last.pointer);

      if (onlyPointerMoved(cur, skip)) {
        const ops = clean(cur);
        last = cur;
        return report(ops.length ? 'cleaned' : 'same', ops);
      }

      // Fixed bars: rows unchanged at the same height, in from each edge, up to
      // the first row that moved. Only a row with something on it proves the
      // bar reaches that far — on a mostly white page, blank rows line up
      // between any two frames — and the pointer's rows prove nothing either.
      let head = 0;
      for (let y = 0; y < height; y++) {
        if (skip(y)) continue;
        if (cur.sig[y] !== last.sig[y]) break;
        if (cur.info[y]) head = y + 1;
      }

      let foot = 0;
      for (let k = 0; k < height - head; k++) {
        const y = height - 1 - k;
        if (skip(y)) continue;
        if (cur.sig[y] !== last.sig[y]) break;
        if (cur.info[y]) foot = k + 1;
      }

      if (height - head - foot < minBand) return report('changed', []);

      // Nothing to line up against: the frame we are lined up with is blank
      // where things moved. While that frame is all there is, start over from
      // this one instead of staying lost for good.
      if (hi - lo === height && informative(last, head, height - foot) < MIN_DISTINCT) return begin(cur);

      const dy = offset(last, cur, head, height - foot);
      if (dy === null) return report('lost', []);

      // The frame must also agree with everything the image already holds
      // where it would go. After a run of lost frames the page may be far past
      // anything captured, and a page that repeats itself can line up with the
      // frame before on the repeat alone — but not with the rest of the image.
      const next = pos + dy;
      if (!agreesWithImage(cur, next, head, foot)) return report('lost', []);

      // How far this frame reaches past what has been captured — at most one
      // end, since the result is never shorter than a frame.
      const below = Math.max(0, next + height - hi);
      const above = Math.max(0, lo - next);
      if (hi - lo + below + above > maxLength) return report('full', []);

      pos = next;
      top = head;
      bottom = foot;
      const ops = [];

      if (below) {
        // The rows that came into view at the bottom, with the footer again
        // after them — written over the old footer, so it always ends the
        // result.
        ops.push(write(cur, height - foot - below, hi - foot, below + foot));
        hi += below;
      } else if (above) {
        // The mirror image at the top: the header, then the rows that came
        // into view under it — written over the old header.
        lo -= above;
        ops.push(write(cur, 0, lo, head + above));
      }

      ops.push(...clean(cur));
      last = cur;
      return report(below || above ? 'appended' : 'moved', ops, dy);
    }

    /** Make `frame` the whole result. */
    function begin(frame) {
      last = frame;
      lo = 0;
      hi = height;
      pos = 0;
      top = 0;
      bottom = 0;
      dirty.fill(0);
      return report('first', [write(frame, 0, 0, height)]);
    }

    function report(kind, ops, dy) {
      return { kind, ops, lo, hi, pos, length: hi - lo, dy };
    }

    /** One op: `rows` rows of `frame` from `from`, to result row `to`. */
    function write(frame, from, to, rows) {
      dirty.fill(0, to + maxLength, to + rows + maxLength);
      known.set(frame.sig.subarray(from, from + rows), to + maxLength);
      knownInfo.set(frame.info.subarray(from, from + rows), to + maxLength);
      soil(frame.pointer, from, to, rows);
      return { from, rows, to };
    }

    /**
     * Would the frame, placed with its top edge at result row `at`, agree with
     * what the image already holds there? Only the rows between the fixed
     * bars count — the bars just found in this frame as well as the ones the
     * image has: until the first scroll nobody knew there were any, so the
     * image still has the first frame's bars where content will go. Rows
     * under the pointer and rows blank on both sides say nothing either way.
     */
    function agreesWithImage(frame, at, head, foot) {
      let seen = 0;
      let same = 0;
      const a = Math.max(head, lo + Math.max(top, head) - at);
      const b = Math.min(height - foot, hi - Math.max(bottom, foot) - at);

      for (let y = a; y < b; y++) {
        const r = at + y + maxLength;
        if (within(y, frame.pointer) || dirty[r] || (!frame.info[y] && !knownInfo[r])) continue;
        seen++;
        if (frame.sig[y] === known[r]) same++;
      }

      return same >= seen * MIN_MATCH;
    }

    function informative(frame, from, to) {
      let n = 0;
      for (let y = from; y < to; y++) if (frame.info[y] && !within(y, frame.pointer)) n++;
      return n;
    }

    function onlyPointerMoved(cur, skip) {
      for (let y = 0; y < height; y++) {
        if (cur.sig[y] !== last.sig[y] && !skip(y)) return false;
      }
      return true;
    }

    /**
     * How far the content moved up between two frames, within rows [from, to).
     * Each row of `cur` votes for every place its signature appears in `prev`;
     * the leading offsets then have to hold up across the whole overlap.
     *
     * If more than one does, the frames alone cannot say which — a page that
     * repeats a block can line up on the repeat as well as on the truth, and
     * the repeat can even win the vote. Better to skip the frame than to
     * guess: the scroll carries on, and the next frame usually settles it.
     */
    function offset(prev, cur, from, to) {
      const skipPrev = (y) => within(y, prev.pointer);
      const skipCur = (y) => within(y, cur.pointer);

      const where = new Map();
      for (let j = from; j < to; j++) {
        if (!prev.info[j] || skipPrev(j)) continue;
        const list = where.get(prev.sig[j]);
        if (list) list.push(j);
        else where.set(prev.sig[j], [j]);
      }

      const votes = new Map();
      for (let i = from; i < to; i++) {
        if (!cur.info[i] || skipCur(i)) continue;
        const list = where.get(cur.sig[i]);
        if (!list || list.length > COMMON) continue;
        for (const j of list) {
          if (j !== i) votes.set(j - i, (votes.get(j - i) || 0) + 1);
        }
      }

      const leading = [...votes.entries()]
        .sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))
        .slice(0, CANDIDATES)
        .map(([dy]) => dy);

      const fits = leading.filter((dy) => holds(dy));
      return fits.length === 1 ? fits[0] : null;

      /** Does `dy` explain the whole overlap, not just the rows that voted for it? */
      function holds(dy) {
        let seen = 0;
        let same = 0;
        const agreeing = new Set();
        for (let i = Math.max(from, from - dy); i < Math.min(to, to - dy); i++) {
          const j = i + dy;
          if (skipCur(i) || skipPrev(j) || (!cur.info[i] && !prev.info[j])) continue;
          seen++;
          if (cur.sig[i] === prev.sig[j]) {
            same++;
            agreeing.add(cur.sig[i]);
          }
        }
        return agreeing.size >= MIN_DISTINCT && same >= seen * MIN_MATCH;
      }
    }

    /** Mark result rows that were written from frame rows under the pointer. */
    function soil(pointer, from, to, rows) {
      if (!pointer) return;
      const a = Math.max(from, pointer[0]);
      const b = Math.min(from + rows, pointer[1]);
      if (a < b) dirty.fill(1, to + a - from + maxLength, to + b - from + maxLength);
    }

    /**
     * Where a row of the frame we are lined up with belongs in the result: the
     * header rides at the top, the footer at the bottom, and everything else
     * sits wherever the scroll has got to.
     */
    function rowOf(y) {
      if (y < top) return lo + y;
      if (y >= height - bottom) return hi - height + y;
      return pos + y;
    }

    /** Redo dirty rows from this frame wherever the pointer is not over them. */
    function clean(frame) {
      const ops = [];
      let run = null;

      for (let y = 0; y < height; y++) {
        const r = rowOf(y);
        if (!dirty[r + maxLength] || within(y, frame.pointer)) continue;

        dirty[r + maxLength] = 0;
        known[r + maxLength] = frame.sig[y];
        knownInfo[r + maxLength] = frame.info[y];
        if (run && run.from + run.rows === y && run.to + run.rows === r) run.rows++;
        else ops.push((run = { from: y, rows: 1, to: r }));
      }

      return ops;
    }

    return {
      push,
      get length() {
        return hi - lo;
      },
      /** Rows of the image, counted from its top, that may still show the pointer — for the checks. */
      dirtyRows() {
        const rows = [];
        for (let r = lo; r < hi; r++) if (dirty[r + maxLength]) rows.push(r - lo);
        return rows;
      },
    };
  }

  return { create, signatures };
})();

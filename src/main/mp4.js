'use strict';

const fs = require('fs');

/**
 * MediaRecorder writes MP4 as a fragmented file: a header that lists no frames
 * and gives no length, then a fragment a second, each indexing only itself.
 * Chromium reads every fragment and plays it fine. Windows reads the header,
 * takes the length as unknown and treats the file like a live stream — it
 * plays, but cannot be skipped through, and Explorer shows no length.
 *
 * regular() lays the same file out the ordinary way: one index at the front
 * with every frame's duration, size and place, which frames are keyframes and
 * the real length, then the very same media data. Nothing is re-encoded.
 */

// tfhd and trun flags (ISO/IEC 14496-12, 8.8.7 and 8.8.8).
const TFHD_BASE_OFFSET = 0x1;
const TFHD_DESCRIPTION = 0x2;
const TFHD_DURATION = 0x8;
const TFHD_SIZE = 0x10;
const TFHD_FLAGS = 0x20;
const TFHD_BASE_IS_MOOF = 0x20000;
const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_FLAGS = 0x4;
const TRUN_DURATION = 0x100;
const TRUN_SIZE = 0x200;
const TRUN_FLAGS = 0x400;
const TRUN_CTS = 0x800;
// In a sample's flags: "this is not a sync sample", i.e. not a keyframe.
const NON_SYNC = 0x10000;

const U32 = 0xffffffff;

/**
 * @param {Buffer} input  the recording as MediaRecorder produced it
 * @param {{ large?: boolean }} [opts]  large: 64-bit sizes and offsets even
 *        when 32 bits would do — files past 4 GB need them; the check uses
 *        this to exercise them
 * @returns {{ head: Buffer, runs: Array<[number, number]> }} the regular file
 *          is `head` followed by input[start, end) for each run. An input with
 *          no fragments comes back as it was.
 * @throws when the input is not a fragmented MP4 this understands
 */
function regular(input, opts = {}) {
  const top = boxes(input, 0, input.length);
  if (!top.some((b) => b.type === 'moof')) return { head: Buffer.alloc(0), runs: [[0, input.length]] };

  const ftyp = find(top, 'ftyp');
  const moov = find(top, 'moov');
  if (!ftyp || !moov) throw new Error('no ftyp or moov');

  const movie = readMovie(input, moov);
  const chunks = [];
  for (const b of top) {
    if (b.type === 'moof') readFragment(input, b, movie.tracks, chunks);
  }

  const kept = [...movie.tracks.values()].filter((t) => t.sizes.length);
  if (!kept.length) throw new Error('no samples');
  for (const t of kept) {
    t.mediaDuration = t.end - t.first;
    // A track that starts late waits behind an empty edit; see edits().
    t.movieDuration = Math.round((t.end * movie.timescale) / t.timescale);
  }
  const used = chunks.filter((c) => c.track.sizes.length);
  const data = used.reduce((n, c) => n + c.length, 0);

  // The index sits in front of the data, so the data's place depends on the
  // index's size — which does not depend on the offsets, only on their width.
  const mdatHeader = opts.large || 8 + data > U32 ? 16 : 8;
  let large = Boolean(opts.large);
  let index = movieBox(input, moov, movie, large);
  if (!large && ftyp.end - ftyp.start + index.length + mdatHeader + data > U32) {
    large = true;
    index = movieBox(input, moov, movie, large);
  }

  let at = ftyp.end - ftyp.start + index.length + mdatHeader;
  for (const c of used) {
    c.track.offsets.push(at);
    at += c.length;
  }
  index = movieBox(input, moov, movie, large);

  const mdat = Buffer.alloc(mdatHeader);
  if (mdatHeader === 16) {
    mdat.writeUInt32BE(1, 0);
    mdat.write('mdat', 4, 'latin1');
    mdat.writeBigUInt64BE(BigInt(16 + data), 8);
  } else {
    mdat.writeUInt32BE(8 + data, 0);
    mdat.write('mdat', 4, 'latin1');
  }

  const runs = [];
  for (const c of used) {
    const last = runs[runs.length - 1];
    if (last && last[1] === c.start) last[1] += c.length;
    else runs.push([c.start, c.start + c.length]);
  }
  return { head: Buffer.concat([input.subarray(ftyp.start, ftyp.end), index, mdat]), runs };
}

/** Write a recording to `file` as a regular MP4. Throws as regular() does. */
function writeRegular(file, input, opts) {
  const { head, runs } = regular(input, opts);
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, head);
    for (const [start, end] of runs) {
      for (let p = start; p < end; ) p += fs.writeSync(fd, input, p, end - p);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// reading

function boxes(buf, start, end) {
  const list = [];
  for (let p = start; p < end; ) {
    if (end - p < 8) throw new Error(`stray bytes at ${p}`);
    let size = buf.readUInt32BE(p);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size < header || p + size > end) throw new Error(`${type} box at ${p} runs past its end`);
    list.push({ type, start: p, body: p + header, end: p + size });
    p += size;
  }
  return list;
}

function children(buf, box) {
  return boxes(buf, box.body, box.end);
}

function find(list, type) {
  return list.find((b) => b.type === type);
}

function readMovie(buf, moov) {
  const parts = children(buf, moov);
  const mvhd = find(parts, 'mvhd');
  if (!mvhd) throw new Error('no mvhd');

  const tracks = new Map();
  for (const trak of parts.filter((b) => b.type === 'trak')) {
    const inside = children(buf, trak);
    const tkhd = find(inside, 'tkhd');
    const mdia = find(inside, 'mdia');
    const mdhd = mdia && find(children(buf, mdia), 'mdhd');
    if (!tkhd || !mdhd) throw new Error('track without tkhd or mdhd');
    const id = buf.readUInt32BE(tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12));
    tracks.set(id, {
      id,
      timescale: buf.readUInt32BE(mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12)),
      defaults: { description: 1, duration: 0, size: 0, flags: 0 },
      first: null, // decode time of the first sample
      end: 0, // decode time just past the last sample
      durations: [],
      sizes: [],
      syncs: [], // 1-based numbers of the keyframes
      cts: [],
      chunks: [], // [samples, description] per run, for stsc
      offsets: [], // where each run lands in the new file
    });
  }

  const mvex = find(parts, 'mvex');
  for (const trex of mvex ? children(buf, mvex).filter((b) => b.type === 'trex') : []) {
    const track = tracks.get(buf.readUInt32BE(trex.body + 4));
    if (!track) continue;
    track.defaults = {
      description: buf.readUInt32BE(trex.body + 8),
      duration: buf.readUInt32BE(trex.body + 12),
      size: buf.readUInt32BE(trex.body + 16),
      flags: buf.readUInt32BE(trex.body + 20),
    };
  }

  return { tracks, timescale: buf.readUInt32BE(mvhd.body + (buf[mvhd.body] === 1 ? 20 : 12)) };
}

function readFragment(buf, moof, tracks, chunks) {
  // Where a track fragment's data starts when its header does not say.
  let previousEnd = moof.start;

  for (const traf of children(buf, moof).filter((b) => b.type === 'traf')) {
    const parts = children(buf, traf);
    const tfhd = find(parts, 'tfhd');
    if (!tfhd) throw new Error('traf without tfhd');
    const flags = buf.readUIntBE(tfhd.body + 1, 3);
    const track = tracks.get(buf.readUInt32BE(tfhd.body + 4));
    if (!track) throw new Error('fragment of an unknown track');

    let q = tfhd.body + 8;
    let base = flags & TFHD_BASE_IS_MOOF ? moof.start : previousEnd;
    const d = { ...track.defaults };
    if (flags & TFHD_BASE_OFFSET) {
      base = Number(buf.readBigUInt64BE(q));
      q += 8;
    }
    if (flags & TFHD_DESCRIPTION) (d.description = buf.readUInt32BE(q)), (q += 4);
    if (flags & TFHD_DURATION) (d.duration = buf.readUInt32BE(q)), (q += 4);
    if (flags & TFHD_SIZE) (d.size = buf.readUInt32BE(q)), (q += 4);
    if (flags & TFHD_FLAGS) (d.flags = buf.readUInt32BE(q)), (q += 4);

    const tfdt = find(parts, 'tfdt');
    startAt(track, tfdt ? (buf[tfdt.body] === 1 ? Number(buf.readBigUInt64BE(tfdt.body + 4)) : buf.readUInt32BE(tfdt.body + 4)) : null);

    let dataAt = base;
    for (const trun of parts.filter((b) => b.type === 'trun')) {
      dataAt = readRun(buf, trun, base, dataAt, d, track, chunks);
    }
    previousEnd = dataAt;
  }
}

/**
 * A fragment says when its first sample is decoded. Samples carry durations,
 * not times, so a gap (or overlap) before it is absorbed by the sample before.
 */
function startAt(track, time) {
  if (track.first === null) {
    track.first = time || 0;
    track.end = track.first;
    return;
  }
  const last = track.durations.length - 1;
  if (time === null || time === track.end || last < 0) return;
  const fixed = Math.max(0, track.durations[last] + time - track.end);
  track.end += fixed - track.durations[last];
  track.durations[last] = fixed;
}

/** @returns where the data of the next run starts, if it does not say */
function readRun(buf, trun, base, dataAt, d, track, chunks) {
  const version = buf[trun.body];
  const flags = buf.readUIntBE(trun.body + 1, 3);
  const count = buf.readUInt32BE(trun.body + 4);
  let q = trun.body + 8;
  if (flags & TRUN_DATA_OFFSET) {
    dataAt = base + buf.readInt32BE(q);
    q += 4;
  }
  let firstFlags = null;
  if (flags & TRUN_FIRST_FLAGS) {
    firstFlags = buf.readUInt32BE(q);
    q += 4;
  }
  const fields = [TRUN_DURATION, TRUN_SIZE, TRUN_FLAGS, TRUN_CTS].filter((f) => flags & f).length;
  if (q + count * fields * 4 > trun.end) throw new Error('trun lists more samples than it holds');

  let bytes = 0;
  for (let i = 0; i < count; i++) {
    let duration = d.duration;
    let size = d.size;
    let sampleFlags = i === 0 && firstFlags !== null ? firstFlags : d.flags;
    let cts = 0;
    if (flags & TRUN_DURATION) (duration = buf.readUInt32BE(q)), (q += 4);
    if (flags & TRUN_SIZE) (size = buf.readUInt32BE(q)), (q += 4);
    if (flags & TRUN_FLAGS) {
      if (!(i === 0 && firstFlags !== null)) sampleFlags = buf.readUInt32BE(q);
      q += 4;
    }
    if (flags & TRUN_CTS) (cts = version === 0 ? buf.readUInt32BE(q) : buf.readInt32BE(q)), (q += 4);

    track.durations.push(duration);
    track.sizes.push(size);
    track.cts.push(cts);
    if (!(sampleFlags & NON_SYNC)) track.syncs.push(track.sizes.length);
    track.end += duration;
    bytes += size;
  }

  if (dataAt < 0 || dataAt + bytes > buf.length) throw new Error('sample data lies outside the file');
  if (count) {
    chunks.push({ track, start: dataAt, length: bytes });
    track.chunks.push([count, d.description]);
  }
  return dataAt + bytes;
}

// ---------------------------------------------------------------------------
// writing

function box(type, ...payload) {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function fullBox(type, version, flags, ...payload) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version << 24) | flags) >>> 0, 0);
  return box(type, vf, ...payload);
}

/** A copy of a box, rebuilt from its children with `swap` deciding each one. */
function rebuilt(buf, b, swap) {
  const parts = [];
  for (const c of children(buf, b)) {
    const out = swap(c);
    if (out === undefined) parts.push(buf.subarray(c.start, c.end));
    else if (out) parts.push(...[].concat(out));
  }
  return box(b.type, ...parts);
}

function movieBox(buf, moov, movie, large) {
  const tracks = [...movie.tracks.values()].filter((t) => t.sizes.length);
  const longest = Math.max(...tracks.map((t) => t.movieDuration));

  return rebuilt(buf, moov, (b) => {
    if (b.type === 'mvhd') return withDuration(buf, b, longest, 'mvhd');
    if (b.type === 'mvex') return null; // marks the file as fragmented
    if (b.type !== 'trak') return undefined;

    const tkhd = find(children(buf, b), 'tkhd');
    const track = movie.tracks.get(buf.readUInt32BE(tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12)));
    if (!track.sizes.length) return null;

    return rebuilt(buf, b, (c) => {
      if (c.type === 'tkhd') {
        const out = [withDuration(buf, c, track.movieDuration, 'tkhd')];
        if (track.first > 0) out.push(edits(track, movie.timescale));
        return out;
      }
      if (c.type === 'edts') return track.first > 0 ? null : undefined;
      if (c.type !== 'mdia') return undefined;
      return rebuilt(buf, c, (m) => {
        if (m.type === 'mdhd') return withDuration(buf, m, track.mediaDuration, 'mdhd');
        if (m.type !== 'minf') return undefined;
        return rebuilt(buf, m, (s) => (s.type === 'stbl' ? sampleTables(buf, s, track, large) : undefined));
      });
    });
  });
}

/** mvhd, tkhd or mdhd with the duration filled in. */
function withDuration(buf, b, duration, type) {
  const out = Buffer.from(buf.subarray(b.start, b.end));
  const body = b.body - b.start;
  const v1 = out[body] === 1;
  const at = body + { mvhd: v1 ? 24 : 16, tkhd: v1 ? 28 : 20, mdhd: v1 ? 24 : 16 }[type];
  if (v1) out.writeBigUInt64BE(BigInt(duration), at);
  else if (duration > U32) throw new Error(`${type} cannot hold the duration`);
  else out.writeUInt32BE(duration, at);
  return out;
}

/** Hold a late-starting track back by its start time, then play it whole. */
function edits(track, movieScale) {
  const delay = Math.round((track.first * movieScale) / track.timescale);
  const length = Math.round((track.mediaDuration * movieScale) / track.timescale);
  const b = Buffer.alloc(4 + 2 * 20);
  b.writeUInt32BE(2, 0);
  b.writeBigUInt64BE(BigInt(delay), 4);
  b.writeBigInt64BE(-1n, 12); // an empty edit: nothing plays
  b.writeInt16BE(1, 20);
  b.writeBigUInt64BE(BigInt(length), 24);
  b.writeBigInt64BE(0n, 32);
  b.writeInt16BE(1, 40);
  return box('edts', fullBox('elst', 1, 0, b));
}

function sampleTables(buf, stbl, track, large) {
  const stsd = find(children(buf, stbl), 'stsd');
  if (!stsd) throw new Error('no stsd');
  const n = track.sizes.length;
  const tables = [buf.subarray(stsd.start, stsd.end), table('stts', 0, runLength(track.durations), 2)];

  // Composition offsets, only when frames are reordered; version 1 is signed.
  if (track.cts.some((c) => c !== 0)) {
    tables.push(table('ctts', track.cts.some((c) => c < 0) ? 1 : 0, runLength(track.cts), 2, true));
  }
  if (track.syncs.length < n) tables.push(table('stss', 0, track.syncs, 1));

  const stsc = [];
  track.chunks.forEach(([samples, description], i) => {
    const last = stsc[stsc.length - 1];
    if (!last || last[1] !== samples || last[2] !== description) stsc.push([i + 1, samples, description]);
  });
  tables.push(table('stsc', 0, stsc.flat(), 3));

  const stsz = Buffer.alloc(8 + 4 * n);
  stsz.writeUInt32BE(0, 0); // sizes differ, so each is listed
  stsz.writeUInt32BE(n, 4);
  track.sizes.forEach((s, i) => stsz.writeUInt32BE(s, 8 + 4 * i));
  tables.push(fullBox('stsz', 0, 0, stsz));

  const offsets = track.offsets.length ? track.offsets : track.chunks.map(() => 0);
  if (large) {
    const co64 = Buffer.alloc(4 + 8 * offsets.length);
    co64.writeUInt32BE(offsets.length, 0);
    offsets.forEach((o, i) => co64.writeBigUInt64BE(BigInt(o), 4 + 8 * i));
    tables.push(fullBox('co64', 0, 0, co64));
  } else {
    tables.push(table('stco', 0, offsets, 1));
  }
  return box('stbl', ...tables);
}

/** A table box: an entry count, then `width` 32-bit values per entry. */
function table(type, version, values, width, signed = false) {
  const b = Buffer.alloc(4 + 4 * values.length);
  b.writeUInt32BE(values.length / width, 0);
  values.forEach((v, i) => (signed && v < 0 ? b.writeInt32BE(v, 4 + 4 * i) : b.writeUInt32BE(v, 4 + 4 * i)));
  return fullBox(type, version, 0, b);
}

/** [3, 3, 3, 5] → [3, 3, 1, 5]: count, value pairs. */
function runLength(values) {
  const out = [];
  for (const v of values) {
    if (out.length && out[out.length - 1] === v) out[out.length - 2]++;
    else out.push(1, v);
  }
  return out;
}

module.exports = { regular, writeRegular };

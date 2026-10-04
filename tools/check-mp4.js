'use strict';

/**
 * Recordings are re-laid out as regular MP4s before they are saved
 * (src/main/mp4.js), because Windows cannot seek in the fragmented files
 * MediaRecorder writes. This records short clips the way Took does — same
 * codecs, bitrate and one-second fragments, a canvas whose every frame paints
 * its own timestamp as sixteen black or white blocks — and checks the result:
 *
 *   - the layout: one index in front, no fragments, a real length
 *   - ffprobe sees exactly the frames it saw before: timing, size, keyframes
 *     and an MD5 of every frame (skipped when ffprobe is not installed)
 *   - Chromium shows the same picture as in the original wherever it seeks
 *   - Windows' own player (what Media Player uses) knows the length and seeks,
 *     and Explorer shows the length
 *
 * plus 64-bit offsets, a track that starts late, and inputs it must refuse.
 *
 *   npx electron tools/check-mp4.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');
const { regular, writeRegular } = require('../src/main/mp4');

app.on('window-all-closed', () => {});

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'took-mp4-check-'));
const FFPROBE = spawnSync('ffprobe', ['-version']).status === 0;

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    fs.writeFileSync(path.join(DIR, 'page.html'), '<!doctype html><meta charset="utf-8">');
    await win.loadFile(path.join(DIR, 'page.html'));

    const withAudio = await record(win, 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 6);
    await clip(win, '画面 + 声音', withAudio);
    await clip(win, '只有画面', await record(win, 'video/mp4;codecs=avc1.42E01E', 4));

    console.log('\n64 位的偏移和长度（超过 4 GB 的录屏用得到）');
    const large = save('large', withAudio, { large: true });
    check('索引用了 co64，mdat 用了 64 位长度', has(large, 'co64') && fs.readFileSync(large).readUInt32BE(index(large).mdat) === 1);
    sameFrames(path.join(DIR, 'with-audio.raw.mp4'), large);
    windowsPlays(large, seconds(withAudio));

    console.log('\n画面比声音晚 0.1 秒开始');
    const late = shiftTrack(withAudio, 'vide', 0.1);
    const lateRaw = path.join(DIR, 'late.raw.mp4');
    fs.writeFileSync(lateRaw, late);
    const lateFixed = save('late', late);
    const elst = editOf(lateFixed, 'vide');
    check('画面前面有一段 0.1 秒的空编辑', elst && elst.media === -1 && Math.abs(elst.seconds - 0.1) < 0.002, JSON.stringify(elst));
    sameFrames(lateRaw, lateFixed);

    console.log('\n不认识的不硬转');
    check('不是 MP4 时报错，交给调用方原样保存', throws(() => regular(Buffer.from('not an mp4 at all, just some text'))));
    check('文件被截断时报错', throws(() => regular(withAudio.subarray(0, withAudio.length - 1000))));
    const fixed = fs.readFileSync(path.join(DIR, 'with-audio.mp4'));
    const again = regular(fixed);
    check('已经是普通 MP4 的原样返回', again.head.length === 0 && again.runs.length === 1 && again.runs[0][1] === fixed.length);
  } catch (err) {
    check('跑完', false, err.stack || err.message);
  } finally {
    win.destroy();
    if (failures) console.log(`\n文件留着看：${DIR}`);
    else fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  app.exit(failures ? 1 : 0);
});

async function clip(win, name, raw) {
  const slug = name === '只有画面' ? 'video-only' : 'with-audio';
  const rawFile = path.join(DIR, `${slug}.raw.mp4`);
  fs.writeFileSync(rawFile, raw);
  const file = save(slug, raw);
  const length = seconds(raw);

  console.log(`\n${name}（录了 ${length.toFixed(2)} 秒）`);
  const top = index(file);
  check('布局：ftyp、索引、数据，没有分片', top.order.join(' ') === 'ftyp moov mdat', top.order.join(' '));
  check('索引里不再标着「分片」', !has(file, 'mvex'));
  check('索引写着真正的长度', Math.abs(top.seconds - length) < 0.05, `${top.seconds.toFixed(3)} 秒`);
  check('画面轨有关键帧表', has(file, 'stss'));

  sameFrames(rawFile, file);

  const before = await seekFrames(win, rawFile);
  const after = await seekFrames(win, file);
  check('Chromium 读到的长度不变', Math.abs(before.duration - after.duration) < 0.05, `${before.duration.toFixed(3)} → ${after.duration.toFixed(3)} 秒`);
  const same = before.values.every((v, i) => v.value === after.values[i].value);
  // The painted times only have to move forward: a clip can stall for a moment
  // while recording starts, and two seeks may land on the same frame.
  const forward = after.values.every((v, i) => i === 0 || v.value >= after.values[i - 1].value);
  check(
    'Chromium 跳到哪里，看到的画面都和原来一样',
    same && forward && after.values[after.values.length - 1].value > after.values[0].value,
    after.values.map((v, i) => `${v.t.toFixed(2)}s: ${before.values[i].value}/${v.value}`).join('，')
  );

  const original = windowsView(rawFile, length / 2);
  console.log(`  ····  修之前 Windows 读到的长度：${original.duration === null ? '未知（当成直播流）' : `${original.duration.toFixed(3)} 秒`}，资源管理器：${original.explorer === null ? '没有' : `${original.explorer.toFixed(3)} 秒`}`);
  windowsPlays(file, length);
}

/** The regular version of `raw`, written the way Took writes it. */
function save(slug, raw, opts) {
  const file = path.join(DIR, `${slug}.mp4`);
  writeRegular(file, raw, opts);
  return file;
}

function windowsPlays(file, length) {
  const w = windowsView(file, length / 2);
  check('Windows 播放器知道长度', w.duration !== null && Math.abs(w.duration - length) < 0.1, w.duration === null ? '未知' : `${w.duration.toFixed(3)} 秒`);
  check('Windows 播放器能跳到中间', w.canSeek && Math.abs(w.position - length / 2) < 0.15, `要 ${(length / 2).toFixed(2)}，到了 ${w.position.toFixed(2)} 秒`);
  check('资源管理器显示长度', w.explorer !== null && Math.abs(w.explorer - length) < 0.1, w.explorer === null ? '没有' : `${w.explorer.toFixed(3)} 秒`);
}

/** Every frame, as ffprobe reads it: same timing, size, keyframe flag and bytes. */
function sameFrames(before, after) {
  if (!FFPROBE) {
    console.log('  SKIP  ffprobe 逐帧对比 — 没装 ffprobe');
    return;
  }
  const a = packets(before);
  const b = packets(after);
  const diff = a.findIndex((line, i) => line !== b[i]);
  check(
    'ffprobe 逐帧对比：时间、大小、关键帧、MD5 全部一样',
    a.length > 0 && a.length === b.length && diff === -1,
    `${a.length} / ${b.length} 帧${diff >= 0 ? `，第 ${diff} 帧：${a[diff]} ≠ ${b[diff]}` : ''}`
  );
}

function packets(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_data_hash', 'MD5', '-show_entries', 'packet=stream_index,pts,dts,size,flags,data_hash', '-of', 'csv=p=0', file],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0) throw new Error(`ffprobe: ${r.stderr}`);
  // Only the six fields asked for: from a regular file ffprobe also notes how
  // much of a short last AAC frame to discard, which the fragments never say.
  const lines = r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(',').slice(0, 6).join(','));
  const key = (l) => l.split(',').map((x) => (/^-?\d+$/.test(x) ? Number(x) : x));
  return lines.sort((x, y) => {
    const [s1, , d1] = key(x);
    const [s2, , d2] = key(y);
    return s1 - s2 || d1 - d2;
  });
}

// ---------------------------------------------------------------------------
// Chromium

async function record(win, mime, secs) {
  const r = await win.webContents.executeJavaScript(`(async () => {
    const mime = ${JSON.stringify(mime)};
    if (!MediaRecorder.isTypeSupported(mime)) throw new Error('MediaRecorder cannot do ' + mime);
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d');
    let t0 = performance.now();
    const draw = () => {
      // Hundredths of a second since recording began, as sixteen bits.
      const value = Math.min(65535, Math.round((performance.now() - t0) / 10));
      g.fillStyle = '#808080';
      g.fillRect(0, 0, 640, 360);
      for (let i = 0; i < 16; i++) {
        g.fillStyle = (value >> (15 - i)) & 1 ? '#fff' : '#000';
        g.fillRect(i * 40, 100, 40, 160);
      }
    };
    draw();
    const timer = setInterval(draw, 1000 / 30);
    const stream = canvas.captureStream(30);
    let ac = null;
    if (mime.includes('mp4a')) {
      ac = new AudioContext();
      const osc = ac.createOscillator();
      const dest = ac.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
    // What src/renderer/recorder/recorder.js asks for.
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => (rec.onstop = r));
    t0 = performance.now();
    rec.start(1000);
    await new Promise((r) => setTimeout(r, ${secs * 1000}));
    rec.stop();
    await stopped;
    clearInterval(timer);
    if (ac) await ac.close();
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);
  return Buffer.from(r, 'base64');
}

/** Seek through a file in Chromium and read the timestamp painted on each frame. */
function seekFrames(win, file) {
  return win.webContents.executeJavaScript(`(async () => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = ${JSON.stringify(pathToFileURL(file).href)};
    await new Promise((ok, fail) => {
      v.onloadedmetadata = ok;
      v.onerror = () => fail(new Error(v.error ? v.error.message : 'video error'));
    });
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 360;
    const g = c.getContext('2d', { willReadFrequently: true });
    const values = [];
    for (const f of [0.2, 0.45, 0.7, 0.95]) {
      const t = f * v.duration;
      await new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error('no seeked at ' + t)), 5000);
        v.onseeked = () => (clearTimeout(timer), ok());
        v.currentTime = t;
      });
      g.drawImage(v, 0, 0, 640, 360);
      let value = 0;
      for (let i = 0; i < 16; i++) {
        const p = g.getImageData(i * 40 + 20, 180, 1, 1).data;
        value = value * 2 + ((p[0] + p[1] + p[2]) / 3 > 127 ? 1 : 0);
      }
      values.push({ t, value });
    }
    const duration = v.duration;
    v.removeAttribute('src');
    v.load();
    return { duration, values };
  })()`);
}

// ---------------------------------------------------------------------------
// Windows

/** Open a file with Windows' own playback engine, pause, and seek to `target` seconds. */
function windowsView(file, target) {
  const q = (s) => s.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime]
$null = [Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime]
$item = (New-Object -ComObject Shell.Application).NameSpace('${q(path.dirname(file))}').ParseName('${q(path.basename(file))}')
$length = $item.ExtendedProperty('System.Media.Duration')
$player = New-Object Windows.Media.Playback.MediaPlayer
$player.IsMuted = $true
$player.Source = [Windows.Media.Core.MediaSource]::CreateFromUri([Uri]'${q(file)}')
$player.Play()
$s = $player.PlaybackSession
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and $s.Position.TotalSeconds -lt 0.3) { Start-Sleep -Milliseconds 50 }
$player.Pause()
$duration = $s.NaturalDuration
$s.Position = [TimeSpan]::FromSeconds(${target})
Start-Sleep -Milliseconds 600
$out = [ordered]@{
  explorer = $(if ($length) { [TimeSpan]::FromTicks([long]$length).TotalSeconds } else { $null })
  duration = $(if ($duration -eq [TimeSpan]::MaxValue) { $null } else { $duration.TotalSeconds })
  canSeek = $s.CanSeek
  position = $s.Position.TotalSeconds
}
$player.Dispose()
$out | ConvertTo-Json -Compress
`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    timeout: 60000,
  });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  if (!line) throw new Error(`Windows 播放器打不开 ${path.basename(file)}: ${(r.stderr || '').trim().split(/\r?\n/)[0]}`);
  return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// reading MP4s, independently of src/main/mp4.js

function walk(buf, start, end, visit, depth = 0) {
  for (let p = start; p + 8 <= end; ) {
    let size = buf.readUInt32BE(p);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    }
    if (size === 0) size = end - p;
    const b = { type: buf.toString('latin1', p + 4, p + 8), start: p, body: p + header, end: p + size, depth };
    visit(b);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf'].includes(b.type)) walk(buf, b.body, b.end, visit, depth + 1);
    p += size;
  }
}

function index(file) {
  const buf = fs.readFileSync(file);
  const order = [];
  let mdat = -1;
  let secs = 0;
  walk(buf, 0, buf.length, (b) => {
    if (b.depth === 0) order.push(b.type);
    if (b.type === 'mdat') mdat = b.start;
    if (b.type === 'mvhd') {
      const v1 = buf[b.body] === 1;
      const scale = buf.readUInt32BE(b.body + (v1 ? 20 : 12));
      secs = (v1 ? Number(buf.readBigUInt64BE(b.body + 24)) : buf.readUInt32BE(b.body + 16)) / scale;
    }
  });
  return { order, mdat, seconds: secs };
}

function has(file, type) {
  const buf = fs.readFileSync(file);
  let found = false;
  walk(buf, 0, buf.length, (b) => (found = found || b.type === type));
  return found;
}

/** id → { handler, timescale } for every track in the header. */
function tracksOf(buf) {
  const tracks = {};
  let id = null;
  walk(buf, 0, buf.length, (b) => {
    const v1 = buf[b.body] === 1;
    if (b.type === 'tkhd') tracks[(id = buf.readUInt32BE(b.body + (v1 ? 20 : 12)))] = {};
    if (b.type === 'mdhd') tracks[id].timescale = buf.readUInt32BE(b.body + (v1 ? 20 : 12));
    if (b.type === 'hdlr') tracks[id].handler = buf.toString('latin1', b.body + 8, b.body + 12);
  });
  return tracks;
}

/** Length of a MediaRecorder file: as far as any track's samples reach. */
function seconds(raw) {
  const tracks = tracksOf(raw);
  const ends = [];
  let track = null;
  let time = 0;
  walk(raw, 0, raw.length, (b) => {
    if (b.type === 'tfhd') track = raw.readUInt32BE(b.body + 4);
    if (b.type === 'tfdt') time = raw[b.body] === 1 ? Number(raw.readBigUInt64BE(b.body + 4)) : raw.readUInt32BE(b.body + 4);
    if (b.type === 'trun') {
      const flags = raw.readUIntBE(b.body + 1, 3);
      const count = raw.readUInt32BE(b.body + 4);
      const step = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length;
      // Chromium gives every sample its own duration, first among its fields.
      let q = b.body + 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
      for (let i = 0; i < count; i++, q += step) time += raw.readUInt32BE(q);
      ends.push(time / tracks[track].timescale);
    }
  });
  return Math.max(...ends);
}

/** A copy of `raw` whose `handler` track ('vide', 'soun') starts `by` seconds later. */
function shiftTrack(raw, handler, by) {
  const out = Buffer.from(raw);
  const [id, track] = Object.entries(tracksOf(out)).find(([, t]) => t.handler === handler);
  const add = BigInt(Math.round(by * track.timescale));
  let current = null;
  walk(out, 0, out.length, (b) => {
    if (b.type === 'tfhd') current = String(out.readUInt32BE(b.body + 4));
    if (b.type !== 'tfdt' || current !== id) return;
    if (out[b.body] === 1) out.writeBigUInt64BE(out.readBigUInt64BE(b.body + 4) + add, b.body + 4);
    else out.writeUInt32BE(out.readUInt32BE(b.body + 4) + Number(add), b.body + 4);
  });
  return out;
}

/** The first edit of the `handler` track, in seconds of the movie's timescale. */
function editOf(file, handler) {
  const buf = fs.readFileSync(file);
  let movie = 1000;
  let elst = null;
  let found = null;
  walk(buf, 0, buf.length, (b) => {
    if (b.type === 'mvhd') movie = buf.readUInt32BE(b.body + (buf[b.body] === 1 ? 20 : 12));
    if (b.type === 'trak') elst = null;
    if (b.type === 'elst') {
      const v1 = buf[b.body] === 1;
      elst = {
        seconds: (v1 ? Number(buf.readBigUInt64BE(b.body + 8)) : buf.readUInt32BE(b.body + 8)) / movie,
        media: v1 ? Number(buf.readBigInt64BE(b.body + 16)) : buf.readInt32BE(b.body + 12),
      };
    }
    if (b.type === 'hdlr' && buf.toString('latin1', b.body + 8, b.body + 12) === handler) found = elst;
  });
  return found;
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

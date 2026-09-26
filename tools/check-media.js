'use strict';

/**
 * Probes what this Electron build can actually record: container/codec support
 * in MediaRecorder, desktop loopback audio, and webcam availability.
 *
 *   npx electron tools/check-media.js
 */

const path = require('path');
const { app, BrowserWindow, desktopCapturer } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  // navigator.mediaDevices only exists in a secure context, so a data: URL is
  // not good enough — load a real file.
  await win.loadFile(path.join(__dirname, 'probe.html'));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });
  const sourceId = sources[0] ? sources[0].id : null;

  const result = await win.webContents.executeJavaScript(`(async () => {
    const types = [
      'video/mp4',
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc3.42E01E',
      'video/mp4;codecs=h264',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264',
      'video/x-matroska;codecs=avc1',
    ];
    const mime = {};
    types.forEach((t) => { mime[t] = MediaRecorder.isTypeSupported(t); });

    let loopback = 'not tried';
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(
          sourceId
        )} } },
      });
      loopback = 'OK, audio tracks=' + s.getAudioTracks().length;
      s.getTracks().forEach((t) => t.stop());
    } catch (e) { loopback = 'FAILED: ' + e.name + ' ' + e.message; }

    let devices = 'not tried';
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const count = (k) => list.filter((d) => d.kind === k).length;
      devices = 'video=' + count('videoinput') + ' audioin=' + count('audioinput');
    } catch (e) { devices = 'FAILED: ' + e.message; }

    return { mime, loopback, devices };
  })()`);

  console.log('\nMediaRecorder 容器/编码支持:');
  Object.entries(result.mime).forEach(([type, ok]) => {
    console.log(`  ${ok ? 'YES' : ' no'}  ${type}`);
  });
  console.log(`\n系统声音(desktop loopback): ${result.loopback}`);
  console.log(`设备: ${result.devices}\n`);

  app.exit(0);
});

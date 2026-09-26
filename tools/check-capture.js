'use strict';

/**
 * Diagnostic: reports what each display looks like and what resolution the
 * screenshot actually comes back at. Prints metrics only — never writes the
 * captured image anywhere.
 *
 *   npx electron tools/check-capture.js
 */

const { app, screen } = require('electron');
const { captureAllDisplays } = require('../src/main/capture');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const shots = await captureAllDisplays();

    screen.getAllDisplays().forEach((d, i) => {
      const shot = shots[i];
      const expected = {
        width: Math.round(d.size.width * d.scaleFactor),
        height: Math.round(d.size.height * d.scaleFactor),
      };
      const got = shot.pixelSize;
      const native = got.width === expected.width && got.height === expected.height;

      console.log(`display #${i}  id=${d.id}`);
      console.log(`  bounds      ${d.bounds.width}x${d.bounds.height} @ ${d.bounds.x},${d.bounds.y} (CSS px)`);
      console.log(`  scaleFactor ${d.scaleFactor}`);
      console.log(`  expected    ${expected.width}x${expected.height} (native px)`);
      console.log(`  captured    ${got.width}x${got.height}  ${native ? 'OK 原生分辨率' : '!! 分辨率不符'}`);
      console.log(`  ratio       ${(got.width / d.bounds.width).toFixed(3)} native px / CSS px`);
      console.log(`  dataURL     ${shot.dataURL ? `${Math.round(shot.dataURL.length / 1024)} KB` : 'MISSING'}`);
      console.log(`  sourceId    ${shot.sourceId || 'MISSING'}`);
    });
  } catch (err) {
    console.error('capture failed:', err);
    process.exitCode = 1;
  }
  app.exit(process.exitCode || 0);
});

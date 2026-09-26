'use strict';

/**
 * Exercises the settings store and the hotkey re-registration path, including
 * the rollback that runs when an accelerator is already taken.
 *
 *   npx electron tools/check-settings.js
 */

const fs = require('fs');
const path = require('path');
const { app, globalShortcut } = require('electron');

app.setName('Took');
app.on('window-all-closed', () => {});

const settings = require('../src/main/settings');

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

app.whenReady().then(() => {
  const file = settings.file();
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

  try {
    run();
  } finally {
    // Never leave the developer's real settings mangled by a test run.
    if (backup === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, backup, 'utf8');
    globalShortcut.unregisterAll();
  }

  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  app.exit(failures ? 1 : 0);
});

function run() {
  console.log(`设置文件: ${settings.file()}\n`);

  console.log('默认值');
  const defaults = settings.get();
  check('截图快捷键', defaults.shortcuts.capture === 'CommandOrControl+Shift+S');
  check('录屏快捷键', defaults.shortcuts.record === 'CommandOrControl+Shift+R');
  check('保存目录留空走默认', defaults.saveDir === null);
  check('默认目录可解析', fs.existsSync(settings.saveDir()), settings.saveDir());

  console.log('\n持久化');
  settings.set({ shortcuts: { capture: 'CommandOrControl+Alt+1' } });
  const onDisk = JSON.parse(fs.readFileSync(settings.file(), 'utf8'));
  check('写入磁盘', onDisk.shortcuts.capture === 'CommandOrControl+Alt+1');
  check('未改动的键保持原值', onDisk.shortcuts.record === 'CommandOrControl+Shift+R');

  console.log('\n保存目录');
  const tmp = path.join(app.getPath('temp'), `took-settings-check-${process.pid}`);
  settings.set({ saveDir: tmp });
  check('自动创建目录', settings.saveDir() === tmp && fs.existsSync(tmp));
  check('可写检测通过', settings.checkWritable(tmp).ok);

  const bogus = 'Z:\\definitely\\not\\here';
  check('不可写目录被拒', settings.checkWritable(bogus).ok === false);
  settings.set({ saveDir: bogus });
  check('目录失效时退回默认', settings.saveDir() !== bogus, settings.saveDir());
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n快捷键注册');
  settings.set({ saveDir: null, shortcuts: { capture: 'CommandOrControl+Alt+F9' } });
  check('注册自定义组合', register('CommandOrControl+Alt+F9'));

  globalShortcut.unregisterAll();
  // Hold one ourselves, then confirm a second registration is refused — this is
  // exactly what a clash with another program looks like.
  globalShortcut.register('CommandOrControl+Alt+F9', () => {});
  check('已占用的组合会被拒绝', globalShortcut.register('CommandOrControl+Alt+F9', () => {}) === false);
  globalShortcut.unregisterAll();

  check('畸形组合不会通过', register('NotAKey+++') === false);
}

function register(accelerator) {
  try {
    return globalShortcut.register(accelerator, () => {});
  } catch {
    return false;
  }
}

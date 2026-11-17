'use strict';

/**
 * Exercises the settings store and the hotkey re-registration path, including
 * the rollback that runs when an accelerator is already taken — and saving a
 * capture: straight into the folder, or through a stand-in for the dialog.
 *
 *   npx electron tools/check-settings.js
 */

const fs = require('fs');
const path = require('path');
const { app, globalShortcut } = require('electron');

app.setName('Took');
app.on('window-all-closed', () => {});

const settings = require('../src/main/settings');
const { createSaver, writeNew } = require('../src/main/saving');
const { createTranslator } = require('../src/shared/i18n');

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

// Every folder the checks write into lives under here, and goes afterwards.
const SCRATCH = path.join(app.getPath('temp'), `took-settings-check-${process.pid}`);

app.whenReady().then(async () => {
  const file = settings.file();
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

  try {
    run();
    await saving();
    unreadableFile();
  } catch (err) {
    check('没有抛异常', false, err.stack || err.message);
  } finally {
    // Never leave the developer's real settings mangled by a test run.
    if (backup === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, backup, 'utf8');
    globalShortcut.unregisterAll();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
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
  check('默认直接保存，不弹窗', defaults.saveMode === 'direct');
  check('上次保存的目录不算偏好，get() 里没有', !('lastSaveDir' in defaults));

  console.log('\n自动更新');
  check('默认开着', defaults.autoUpdate === true);
  settings.set({ autoUpdate: false });
  check('关掉并写盘', JSON.parse(fs.readFileSync(settings.file(), 'utf8')).autoUpdate === false);
  settings.set({ language: 'zh' });
  check('改别的设置不会把它改回来', settings.get().autoUpdate === false);
  settings.set({ autoUpdate: 'yes' });
  check('不是 true/false 的值不理', settings.get().autoUpdate === false);
  settings.set({ autoUpdate: true, language: 'en' });

  console.log('\n语言');
  check('默认是英文', defaults.language === 'en');
  settings.set({ language: 'zh' });
  check('切到中文并写盘', JSON.parse(fs.readFileSync(settings.file(), 'utf8')).language === 'zh');
  settings.set({ language: 'fr' });
  check('不支持的语言回落到英文', settings.get().language === 'en', settings.get().language);
  settings.set({ language: 'en' });

  console.log('\n持久化');
  settings.set({ shortcuts: { capture: 'CommandOrControl+Alt+1' } });
  const onDisk = JSON.parse(fs.readFileSync(settings.file(), 'utf8'));
  check('写入磁盘', onDisk.shortcuts.capture === 'CommandOrControl+Alt+1');
  check('未改动的键保持原值', onDisk.shortcuts.record === 'CommandOrControl+Shift+R');

  console.log('\n保存目录');
  const tmp = path.join(SCRATCH, 'location');
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

  console.log('\n保存时的快捷键冲突');
  const before = { shortcuts: { capture: 'CommandOrControl+Shift+S', ocr: 'CommandOrControl+Shift+X' } };
  const sameKeys = { shortcuts: { ...before.shortcuts } };
  const newOcrKey = { shortcuts: { ...before.shortcuts, ocr: 'CommandOrControl+Alt+X' } };
  check(
    '之前就被别的程序占着的快捷键，不挡住保存别的设置',
    JSON.stringify(settings.refusedShortcuts(['ocr'], before, sameKeys)) === '[]'
  );
  check(
    '这次改的快捷键被占用，这次保存要拒绝',
    JSON.stringify(settings.refusedShortcuts(['ocr'], before, newOcrKey)) === '["ocr"]'
  );

  console.log('\n保存方式');
  settings.set({ saveMode: 'ask' });
  check('改成每次都问并写盘', JSON.parse(fs.readFileSync(settings.file(), 'utf8')).saveMode === 'ask');
  settings.set({ language: 'zh' });
  check('改别的设置不会把它改回来', settings.get().saveMode === 'ask');
  settings.set({ saveMode: 'sometimes' });
  check('不认识的值不理', settings.get().saveMode === 'ask');
  settings.set({ saveMode: 'direct', language: 'en' });

  console.log('\n上次保存的目录');
  const location = path.join(SCRATCH, 'location');
  const elsewhere = path.join(SCRATCH, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  settings.set({ saveDir: location });
  check('还没存过时，对话框从保存位置开始', settings.dialogDir() === location, settings.dialogDir());
  settings.rememberSaveDir(elsewhere);
  check('存过之后，对话框从那个目录开始', settings.dialogDir() === elsewhere, settings.dialogDir());
  check('写进了 settings.json，重启也记得', JSON.parse(fs.readFileSync(settings.file(), 'utf8')).lastSaveDir === elsewhere);
  check('get() 里仍然没有它', !('lastSaveDir' in settings.get()));
  // The settings window sends back everything it was shown, on every change.
  settings.set({ ...settings.get(), lastSaveDir: location, autoUpdate: false });
  check('设置窗口改别的设置时不会动它', settings.dialogDir() === elsewhere, settings.dialogDir());
  settings.set({ saveDir: location, autoUpdate: true });
  check('保存位置没变就不清掉', settings.dialogDir() === elsewhere);
  settings.set({ saveDir: path.join(SCRATCH, 'chosen') });
  check('选了新的保存位置，对话框就从新位置开始', settings.dialogDir() === path.join(SCRATCH, 'chosen'), settings.dialogDir());
  settings.rememberSaveDir(path.join(SCRATCH, 'deleted-since'));
  check('上次的目录不在了，退回保存位置', settings.dialogDir() === path.join(SCRATCH, 'chosen'), settings.dialogDir());
  settings.set({ saveDir: null });
}

/** Writing the file, and the two ways of deciding where it goes. */
async function saving() {
  const en = createTranslator('en');
  const png = Buffer.from('not really a png');

  console.log('\n不重名地写文件');
  const fresh = path.join(SCRATCH, 'fresh', 'nested');
  const first = writeNew(fresh, 'Screenshot_1', 'png', png);
  check('目录不存在就建出来', first === path.join(fresh, 'Screenshot_1.png') && fs.existsSync(first), first);
  const second = writeNew(fresh, 'Screenshot_1', 'png', Buffer.from('second'));
  check('同名时加 (2)', path.basename(second) === 'Screenshot_1 (2).png', path.basename(second));
  check('已有的文件不被覆盖', fs.readFileSync(first, 'utf8') === 'not really a png');
  const third = writeNew(fresh, 'Screenshot_1', 'png', png);
  check('再来一次是 (3)', path.basename(third) === 'Screenshot_1 (3).png', path.basename(third));
  const clip = writeNew(fresh, 'Screenshot_1', 'png', { copyFrom: first });
  check('复制文件也不覆盖', path.basename(clip) === 'Screenshot_1 (4).png', path.basename(clip));
  check('复制过去的内容对', fs.readFileSync(clip, 'utf8') === 'not really a png');

  // A file where the folder should be: neither mkdir nor writing can get past it.
  const blocker = path.join(SCRATCH, 'blocker');
  fs.writeFileSync(blocker, '');
  const blocked = path.join(blocker, 'shots');
  let threw = null;
  try {
    writeNew(blocked, 'Screenshot_1', 'png', png);
  } catch (err) {
    threw = err;
  }
  check('写不进去时报错，而不是悄悄吞掉', threw !== null, threw && threw.code);

  // A dialog that records what it was asked and answers as told.
  const asked = [];
  let answer = null;
  const showSaveDialog = async (win, options) => {
    asked.push(options);
    return answer ? { canceled: false, filePath: answer } : { canceled: true, filePath: undefined };
  };
  const job = (name) => ({ name, ext: 'png', title: 'Save screenshot', filter: 'PNG image', source: png });

  console.log('\n直接保存');
  const location = path.join(SCRATCH, 'direct', 'not-yet');
  settings.set({ saveDir: location, saveMode: 'direct' });
  const saver = createSaver({ settings, showSaveDialog, t: en });
  const direct = await saver.save(null, job('Shot'));
  check('不弹对话框', asked.length === 0);
  check('存进设好的目录，目录不存在就建', direct && direct.file === path.join(location, 'Shot.png') && fs.existsSync(direct.file));
  check('标明没有问过，也没有改存别处', direct && direct.asked === false && direct.movedFrom === null);
  const again = await saver.save(null, job('Shot'));
  check('同一秒再存一张不覆盖', again && path.basename(again.file) === 'Shot (2).png', again && again.file);
  check('记下了这次存到的目录', settings.dialogDir() === location);

  // Stand-ins for settings, for what the real one cannot be made to do here
  // without writing into the real Pictures/Took.
  const fallback = path.join(SCRATCH, 'pictures-took');
  fs.mkdirSync(fallback, { recursive: true });
  const fake = (over) => {
    const state = { remembered: null };
    return Object.assign(state, {
      get: () => ({ saveMode: 'direct', saveDir: over.wanted }),
      saveDir: () => over.dir,
      dialogDir: () => over.dialogDir || over.dir,
      defaultSaveDir: () => fallback,
      rememberSaveDir: (dir) => (state.remembered = dir),
    });
  };

  const moved = fake({ wanted: 'Z:\\unplugged', dir: fallback });
  const movedResult = await createSaver({ settings: moved, showSaveDialog, t: en }).save(null, job('Moved'));
  check(
    '设好的目录用不了时，告诉调用方改存到了哪里',
    movedResult && movedResult.movedFrom === 'Z:\\unplugged' && path.dirname(movedResult.file) === fallback,
    movedResult && movedResult.file
  );

  console.log('\n直接保存写不进去');
  const unwritable = fake({ wanted: blocked, dir: blocked });
  const rescue = path.join(SCRATCH, 'rescue');
  fs.mkdirSync(rescue, { recursive: true });
  answer = path.join(rescue, 'Picked.png');
  const rescued = await createSaver({ settings: unwritable, showSaveDialog, t: en }).save(null, job('Stuck'));
  const offer = asked[asked.length - 1];
  check('改为弹出对话框，截图不丢', asked.length === 1 && rescued && rescued.file === answer && fs.existsSync(answer));
  check('对话框标题说明了原因', offer && offer.title === en('dialog.saveFailed', { dir: blocked }), offer && offer.title);
  check('对话框不在写不进去的目录里打开', offer && path.dirname(offer.defaultPath) === fallback, offer && offer.defaultPath);
  check('记下的是真正存到的目录', unwritable.remembered === rescue, unwritable.remembered);

  console.log('\n每次都问');
  asked.length = 0;
  settings.set({ saveMode: 'ask' });
  const pickedA = path.join(SCRATCH, 'picked-a');
  fs.mkdirSync(pickedA, { recursive: true });
  answer = path.join(pickedA, 'One.png');
  const one = await saver.save(null, job('One'));
  check('弹了对话框', asked.length === 1 && one && one.asked === true);
  check(
    '对话框从上次保存的目录开始',
    asked[0] && path.dirname(asked[0].defaultPath) === location,
    asked[0] && asked[0].defaultPath
  );
  check('建议的文件名和类型', asked[0] && path.basename(asked[0].defaultPath) === 'One.png' && asked[0].filters[0].extensions[0] === 'png');
  check('写到了选的位置', fs.existsSync(answer));
  answer = path.join(pickedA, 'Two.png');
  await saver.save(null, job('Two'));
  check(
    '下一次从刚才选的目录开始',
    asked[1] && path.dirname(asked[1].defaultPath) === pickedA,
    asked[1] && asked[1].defaultPath
  );

  fs.writeFileSync(answer, 'old');
  await saver.save(null, job('Two'));
  check('对话框里确认过的覆盖照做', fs.readFileSync(answer, 'utf8') === 'not really a png');

  answer = null;
  const before = fs.readdirSync(pickedA).length;
  const cancelled = await saver.save(null, job('Three'));
  check('取消就什么都不写', cancelled === null && fs.readdirSync(pickedA).length === before);

  answer = path.join(blocked, 'Nope.png');
  let failed = null;
  try {
    await saver.save(null, job('Nope'));
  } catch (err) {
    failed = err;
  }
  check('选的位置写不进去时报错，交给主进程提示', failed !== null, failed && failed.code);
  check('失败的那次不记成上次的目录', settings.dialogDir() === pickedA, settings.dialogDir());

  settings.set({ saveDir: null, saveMode: 'direct' });
}

/** A settings.json that does not parse is left alone by a save. */
function unreadableFile() {
  console.log('\n读不了的 settings.json');
  const broken = '{ "language": "zh", oops';
  fs.writeFileSync(settings.file(), broken, 'utf8');
  // A fresh copy of the module, so it reads the broken file as Took would at start.
  const id = require.resolve('../src/main/settings');
  delete require.cache[id];
  const fresh = require(id);

  check('读不了就用默认值', fresh.get().language === 'en' && fresh.get().saveMode === 'direct');
  fresh.rememberSaveDir(SCRATCH);
  check('存截图时记目录，不会把它覆盖掉', fs.readFileSync(settings.file(), 'utf8') === broken);
  check('这次运行里照样记得', fresh.dialogDir() === SCRATCH, fresh.dialogDir());
  fresh.set({ autoUpdate: false });
  check('在设置里改了东西才重写', JSON.parse(fs.readFileSync(settings.file(), 'utf8')).autoUpdate === false);
}

function register(accelerator) {
  try {
    return globalShortcut.register(accelerator, () => {});
  } catch {
    return false;
  }
}

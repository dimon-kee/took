'use strict';

/**
 * Turn start-with-Windows on or off without opening the app.
 *
 *   npx electron tools/autostart.js on|off|status
 */

const { app } = require('electron');
const autoLaunch = require('../src/main/autolaunch');

// Must match src/main/index.js, or this would write a second Run entry.
app.setName('Took');

const action = (process.argv[2] || 'status').toLowerCase();

app.whenReady().then(() => {
  if (action === 'on' || action === 'off') autoLaunch.set(action === 'on');
  else if (action !== 'status') {
    console.error(`未知参数: ${action}（可用 on / off / status）`);
    return app.exit(1);
  }

  const target = autoLaunch.launchTarget();
  console.log(`开机自启: ${autoLaunch.enabled() ? '已开启' : '已关闭'}`);
  console.log(`启动命令: ${target.path}${target.args.length ? ` ${target.args.join(' ')}` : ''}`);
  app.exit(0);
});

'use strict';

const path = require('path');
const { app } = require('electron');

/**
 * Start-with-Windows registration, written to HKCU\...\Run (current user only,
 * no admin rights needed).
 *
 * The registry value name defaults to the AppUserModelId, which is
 * "electron.app.Electron" for an unpackaged run — so a dev registration and the
 * packaged build would leave two separate start-up entries behind. Pinning the
 * name keeps them on one value that simply overwrites itself.
 *
 * Unpackaged, the command also has to be `electron.exe <project dir>`; pointing
 * at electron.exe alone would open the default Electron welcome window on every
 * boot.
 */

const REGISTRY_NAME = 'Took';

// Marks a launch by this entry: Took then starts in the tray, without the
// settings window any other launch opens.
const FLAG = '--autostart';

function launchTarget() {
  if (app.isPackaged) return { path: process.execPath, args: [FLAG] };

  return {
    path: process.execPath,
    args: [path.resolve(__dirname, '..', '..'), FLAG],
  };
}

function enabled() {
  const settings = app.getLoginItemSettings({ ...launchTarget(), name: REGISTRY_NAME });

  // openAtLogin only reports true when Electron's reconstruction of the command
  // line matches the stored value exactly, which it does not for an unpackaged
  // run (`electron.exe "<project dir>"`). executableWillLaunchAtLogin ignores
  // the args and answers the question we actually care about.
  return process.platform === 'win32'
    ? Boolean(settings.executableWillLaunchAtLogin)
    : Boolean(settings.openAtLogin);
}

function set(on) {
  const target = launchTarget();
  app.setLoginItemSettings({
    openAtLogin: Boolean(on),
    name: REGISTRY_NAME,
    path: target.path,
    args: target.args,
  });
  return enabled();
}

/**
 * Rewrite the entry so it points at the binary that is actually running. Keeps
 * the registration valid after the project moves, or after the packaged build
 * replaces a dev registration.
 */
function refresh() {
  if (enabled()) set(true);
}

module.exports = { enabled, set, refresh, launchTarget, FLAG };

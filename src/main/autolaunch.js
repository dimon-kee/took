'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
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

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

/** The data of one registry value as reg.exe prints it, or null if it is not there. */
function readValue(key, name) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(`${name} `));
    const match = line && line.match(/\sREG_\w+\s+(.*)$/);
    return match ? match[1].trim() : '';
  } catch {
    return null; // reg exits non-zero when the value does not exist
  }
}

function enabled() {
  if (process.platform !== 'win32') {
    return Boolean(app.getLoginItemSettings({ ...launchTarget(), name: REGISTRY_NAME }).openAtLogin);
  }

  // Not Electron's getLoginItemSettings: its executableWillLaunchAtLogin says
  // false whenever the exe path holds a space (C:\Users\Dimon Kee\...), so the
  // box unticked itself right after a successful write. Whether the entry
  // points at this exact binary does not matter here — refresh() rewrites it
  // to the running one at every start.
  if (readValue(RUN_KEY, REGISTRY_NAME) === null) return false;

  // Turned off in Task Manager / Settings > Startup: an odd first byte (03).
  const approved = readValue(APPROVED_KEY, REGISTRY_NAME);
  return !approved || (parseInt(approved.slice(0, 2), 16) & 1) === 0;
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

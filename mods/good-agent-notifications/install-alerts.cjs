#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const appHome = process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config/herdr-app');
const settings = path.join(appHome, 'frame/settings/main.js');
let source = fs.readFileSync(settings, 'utf8');
const previous = source.indexOf('  // Agent Ring controls for Custom.');
if (previous >= 0) {
  const end = source.indexOf('  // Updates ', previous);
  if (end < 0) throw new Error('Cannot find the end of Alerts');
  const controls = fs.readFileSync(path.join(__dirname, 'alerts.inc'), 'utf8');
  source = source.slice(0, previous) + controls + '  alerts(t) {\n    return this.ringAlerts(t);\n  }\n\n' + source.slice(end);
} else {
  const start = source.indexOf('  alerts(t) {');
  const end = source.indexOf('  // Updates ', start);
  const imports = 'import { hc, run,';
  if (start < 0 || end < 0 || !source.includes(imports)) throw new Error('Unsupported Herdr Settings source');
  const controls = fs.readFileSync(path.join(__dirname, 'alerts.inc'), 'utf8');
  source = (source.slice(0, start) + controls + '  alerts(t) {\n    return this.ringAlerts(t);\n  }\n\n' + source.slice(end)).replace(imports, 'import { hc, run, exec, setShared,');
}
const updated = source;
const previousSettings = fs.readFileSync(settings, 'utf8');
if (updated !== previousSettings) {
  const temporary = `${settings}.agent-ring-${process.pid}.tmp`;
  fs.writeFileSync(temporary, updated, { flag: 'wx' });
  fs.renameSync(temporary, settings);
}
const sender = path.join(appHome, 'mods/good-agent-notifications/AgentRingHerdr.app');
const template = path.join(os.homedir(), 'Applications/AgentRingCodex.app');
const notifier = path.join(sender, 'Contents/MacOS/terminal-notifier');
if (process.platform === 'darwin' && !fs.existsSync(notifier) && fs.existsSync(template) &&
    fs.existsSync('/Applications/Herdr.app/Contents/Resources/Herdr.icns')) {
  fs.cpSync(template, sender, { recursive: true, errorOnExist: true });
  const plist = path.join(sender, 'Contents/Info.plist');
  const setPlist = (key, value) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  setPlist('CFBundleIdentifier', 'com.ytxing.agent-ring.herdr');
  setPlist('CFBundleName', 'AgentRingHerdr');
  setPlist('CFBundleDisplayName', 'AgentRingHerdr');
  fs.copyFileSync('/Applications/Herdr.app/Contents/Resources/Herdr.icns', path.join(sender, 'Contents/Resources/AppIcon.icns'));
}

console.log(updated === previousSettings ? `Settings already configured: ${settings}` : `Updated ${settings}`);

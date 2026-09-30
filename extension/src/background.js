// Background worker. Deliberately small: the wallet itself runs in the popup and the full-tab
// view (they have the DOM, localStorage and a steady WebSocket), so all this does is lock.
//
// Auto-lock: every interaction in the popup sends "activity", which re-arms a one-shot alarm
// for the user's auto-lock delay. When the alarm fires, the unlock key in storage.session is
// cleared, and the next time the popup opens it asks for the password. storage.session is also
// empty after a browser restart, so a restart always locks.
//
// Later phases add the website-connect provider here.

import { ext } from "./browser.js";

const ALARM = "kachat.autolock";
const SETTINGS_KEY = "kachat.settings";
const DEFAULT_AUTOLOCK_MINUTES = 15;

async function autoLockMinutes() {
  const settings = (await ext.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] || {};
  const minutes = Number(settings.autoLockMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_AUTOLOCK_MINUTES;
}

async function armAutoLock() {
  await ext.alarms.create(ALARM, { delayInMinutes: await autoLockMinutes() });
}

async function lockNow() {
  await ext.alarms.clear(ALARM);
  await ext.storage.session.clear();
}

ext.runtime.onMessage.addListener((message) => {
  if (message?.type === "activity") armAutoLock();
  else if (message?.type === "lock") lockNow();
  // No response is sent; returning nothing closes the channel.
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) lockNow();
});

// A browser restart already empties storage.session; this also clears a leftover alarm.
ext.runtime.onStartup?.addListener(() => { lockNow(); });

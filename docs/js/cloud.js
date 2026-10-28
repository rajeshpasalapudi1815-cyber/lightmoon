// LightMoon cloud: reminder notifications that arrive even when the app is closed, and encrypted sync
// between your devices. The cloud only ever stores reminder times and data encrypted with the sync code;
// reminder titles and the code itself never leave the device.
import * as store from './store.js';
import * as lock from './lock.js';
import { reminderLine } from './announce.js';
import { idbGet, idbSet } from './idb.js';
import { nativeAlarms } from './native.js';
import { newSyncCode, normalizeCode, spaceIdFor, keyFor, encryptJson, decryptJson } from './vault.js';

export const DEFAULT_CLOUD_URL = 'https://lightmoon-cloud.lightmoon-cloud.workers.dev';
const CONFIG_KEY = 'assistant.cloud';
const SYNC_EVERY_MS = 60_000;
const CHANGE_DELAY_MS = 1500;
const KEEP_RECENT_REMINDERS_MS = 30 * 60_000;

const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// Sorted keys, so two copies of the same data always produce the same text.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ---------- Settings for this device ----------

function loadConfig() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
  } catch {
    saved = null;
  }
  // deviceId names this device to the cloud; spaceId is where its reminders (and, with sync, its data) live.
  // Until sync is turned on, each device has a random space of its own.
  return { deviceId: randomHex(12), spaceId: randomHex(32), ...saved };
}

let config = loadConfig();

function updateConfig(changes) {
  config = { ...config, ...changes };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Private browsing: cloud features last for this visit only.
  }
}
updateConfig({});

const cloudUrl = () => (config.url || DEFAULT_CLOUD_URL).replace(/\/+$/, '');
let syncKey = null;
const getSyncKey = async () => (syncKey ??= config.syncCode ? await keyFor(config.syncCode) : null);
const usesCloud = () => Boolean(config.notifications || config.syncCode);

let status = { syncing: false, lastSync: config.lastSync ?? null, error: null };
let handlers = { onSynced() {}, onStatus() {} };

function setStatus(changes) {
  status = { ...status, ...changes };
  handlers.onStatus({ ...status });
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${cloudUrl()}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Can't reach the LightMoon cloud. Check your internet connection.");
  }
  if (res.status === 404 && method === 'GET') return null;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 409) return { conflict: true, ...data };
  if (!res.ok) throw new Error(`The LightMoon cloud had a problem (${res.status}).`);
  return data;
}

// The service worker shows notifications while the app is closed, so it needs the reminder titles
// (kept on this device) and, with sync, the means to read reminders made on other devices.
// With the app lock on, notifications keep the reminder's words off the lock screen.
async function shareWithWorker() {
  await idbSet('cloud', { url: cloudUrl(), spaceId: config.spaceId, key: await getSyncKey(), private: lock.isEnabled() });
  const { address, userName } = store.profile();
  const reminders = store.tasks.remindersSince(Date.now() - KEEP_RECENT_REMINDERS_MS)
    .map(r => ({ ...r, say: reminderLine(r, { address, user_name: userName }) }));
  await idbSet('reminders', reminders);
  await scheduleOnPhone(reminders);
}

// In the Android app, the phone's own alarms say each reminder at its time, even with LightMoon closed.
// With sync on, the phone also checks the synced copy now and then for reminders set on other devices.
async function scheduleOnPhone(reminders) {
  if (!nativeAlarms) return;
  const upcoming = reminders.filter(r => r.at > Date.now()).map(({ id, title, at, say, updated }) => ({ id, title, at, say, updated }));
  await nativeAlarms.schedule({ reminders: upcoming, hideText: lock.isEnabled() });
  await nativeAlarms.configureBackground(config.syncCode ? { url: cloudUrl(), spaceId: config.spaceId, code: config.syncCode } : {});
}

// The lock was turned on or off: update what notifications may show.
export const refreshNotificationPrivacy = () => shareWithWorker().catch(() => {});

// Tells the cloud when reminders are due: ids and times only. Recently due ones stay on the list until
// the cloud has pushed them, even if an open device already announced them.
async function uploadReminders() {
  if (!usesCloud()) return;
  const reminders = store.tasks.remindersSince(Date.now() - KEEP_RECENT_REMINDERS_MS).map(({ id, at }) => ({ id, at }));
  await api('PUT', `/spaces/${config.spaceId}/reminders`, { reminders });
}

// ---------- Reminder notifications ----------

export const notificationsSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const notificationsOn = () => Boolean(config.notifications);

async function currentSubscription() {
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}

async function registerDevice(subscription) {
  await api('PUT', `/spaces/${config.spaceId}/devices/${config.deviceId}`, { subscription: { endpoint: subscription.endpoint } });
}

export async function enableNotifications() {
  if (!notificationsSupported()) throw new Error("This browser can't show LightMoon notifications.");
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Notifications are blocked. Allow them for LightMoon in your phone settings, then try again.');
  }
  const { key } = await api('GET', '/vapid-public-key');
  const serverKey = fromBase64Url(key);
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  const subscribedKey = subscription?.options.applicationServerKey;
  if (subscription && (!subscribedKey || new Uint8Array(subscribedKey).join() !== serverKey.join())) {
    await subscription.unsubscribe(); // made for a different server key
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  await registerDevice(subscription);
  updateConfig({ notifications: true });
  await shareWithWorker();
  await uploadReminders();
}

export async function disableNotifications() {
  await (await currentSubscription())?.unsubscribe();
  await api('DELETE', `/spaces/${config.spaceId}/devices/${config.deviceId}`).catch(() => {});
  updateConfig({ notifications: false });
}

// ---------- Sync between devices ----------

export const syncCode = () => config.syncCode ?? null;
export const syncStatus = () => ({ ...status });

// Moves this device to the space for `code` (or back to a space of its own when code is null).
async function switchSpace(code) {
  const oldSpace = config.spaceId;
  syncKey = null;
  updateConfig({ syncCode: code, spaceId: code ? await spaceIdFor(code) : randomHex(32), lastSync: null });
  setStatus({ lastSync: null, error: null });
  if (config.notifications) {
    await api('DELETE', `/spaces/${oldSpace}/devices/${config.deviceId}`).catch(() => {});
    const subscription = await currentSubscription();
    if (subscription) await registerDevice(subscription);
  }
  await shareWithWorker();
}

export async function startSync() {
  await switchSpace(newSyncCode());
  await syncNow({ required: true });
  return config.syncCode;
}

export async function joinSync(input) {
  const code = normalizeCode(input);
  // Check the code before switching, so a typo doesn't quietly start a new, separate sync.
  const remote = await api('GET', `/spaces/${await spaceIdFor(code)}/data`);
  if (!remote) throw new Error('No device is syncing with that code yet. Check the code on your other device.');
  await switchSpace(code);
  await syncNow({ required: true });
}

export async function stopSync() {
  await switchSpace(null);
  await uploadReminders().catch(() => {});
}

let running = null;
export function syncNow(options) {
  if (!config.syncCode) return Promise.resolve();
  return (running ??= runSync(options).finally(() => {
    running = null;
  }));
}

// Download, merge, and upload if this device has anything the cloud copy lacks.
// The version check means two devices saving at once can't overwrite each other.
async function runSync({ required = false } = {}) {
  setStatus({ syncing: true, error: null });
  try {
    const key = await getSyncKey();
    let merged = false;
    let messagesAdded = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await api('GET', `/spaces/${config.spaceId}/data`);
      let theirs = null;
      if (remote) {
        theirs = await decryptJson(key, remote.blob);
        messagesAdded += store.mergeIn(theirs);
        merged = true;
      }
      const mine = store.syncableData();
      if (theirs && stable(mine) === stable(store.syncableOf(theirs))) break; // already the same
      const result = await api('PUT', `/spaces/${config.spaceId}/data`, { version: remote?.version ?? 0, blob: await encryptJson(key, mine) });
      if (!result?.conflict) break;
      if (attempt === 2) throw new Error('Another device kept saving at the same moment. Try again shortly.');
    }
    await shareWithWorker();
    await uploadReminders();
    updateConfig({ lastSync: Date.now() });
    setStatus({ syncing: false, lastSync: config.lastSync });
    if (merged) handlers.onSynced({ messagesAdded });
  } catch (err) {
    setStatus({ syncing: false, error: err.message });
    shareWithWorker().catch(() => {}); // offline: still set this device's own reminders
    if (required) throw err;
  }
}

// ---------- Start-up ----------

export function init(callbacks) {
  handlers = { ...handlers, ...callbacks };

  let changeTimer = null;
  store.onLocalChange(() => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (config.syncCode) return syncNow();
      shareWithWorker().then(uploadReminders).catch(err => setStatus({ error: err.message }));
    }, CHANGE_DELAY_MS);
  });

  shareWithWorker().catch(() => {});
  if (config.notifications) {
    // Re-register each launch: browsers occasionally replace subscriptions, and permission can be revoked.
    currentSubscription()
      .then(subscription => (subscription ? registerDevice(subscription) : updateConfig({ notifications: false })))
      .catch(() => {});
  }
  if (config.syncCode) syncNow();
  else uploadReminders().catch(() => {});

  setInterval(() => {
    if (!document.hidden) syncNow();
  }, SYNC_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncNow();
  });
}

// Reminders the service worker already showed as notifications (so the app doesn't announce them again).
export async function notifiedReminders() {
  return (await idbGet('notified').catch(() => null)) ?? {};
}

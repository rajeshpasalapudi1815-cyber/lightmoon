// What the service worker does when the cloud says "a reminder is due now". The push carries no content:
// titles come from this device's own copy or, for a reminder made on another device, from the encrypted
// sync copy. If the app is open, it announces the reminder itself instead.
import { idbGet, idbSet } from './idb.js';
import { decryptJson } from './vault.js';

const DUE_WINDOW_MS = 6 * 3600_000; // ignore reminders more than this overdue
const FORGET_NOTIFIED_MS = 7 * 86_400_000;
const ICON = './icons/icon-192.png';

export async function showDueReminders({ registration, clients, now = Date.now() }) {
  const isDue = reminder => reminder.at <= now + 60_000 && reminder.at > now - DUE_WINDOW_MS;
  let due = ((await idbGet('reminders')) ?? []).filter(isDue);
  if (!due.length) due = (await remindersFromSync().catch(() => [])).filter(isDue);

  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = windows.find(client => client.visibilityState === 'visible');
  if (visible) {
    visible.postMessage({ type: 'reminders-due' });
    return;
  }

  const notified = (await idbGet('notified')) ?? {};
  if (!due.length) {
    // Browsers expect every push to show something; this only happens if the reminder was changed meanwhile.
    await registration.showNotification('LightMoon', { body: 'You have a reminder.', icon: ICON, tag: 'lightmoon-reminder' });
  }
  for (const reminder of due.filter(r => !notified[r.id])) {
    await registration.showNotification('LightMoon reminder', {
      body: reminder.title,
      icon: ICON,
      tag: `reminder-${reminder.id}`,
      requireInteraction: true,
      data: { id: reminder.id },
    });
    notified[reminder.id] = now;
  }
  for (const [id, at] of Object.entries(notified)) if (at < now - FORGET_NOTIFIED_MS) delete notified[id];
  await idbSet('notified', notified);
}

async function remindersFromSync() {
  const cloud = await idbGet('cloud');
  if (!cloud?.key) return [];
  const res = await fetch(`${cloud.url}/spaces/${cloud.spaceId}/data`);
  if (!res.ok) return [];
  const data = await decryptJson(cloud.key, (await res.json()).blob);
  return (data.tasks ?? [])
    .filter(task => !task.deleted && !task.done && task.remind_at)
    .map(task => ({ id: task.id, title: task.title, at: Date.parse(task.remind_at) }));
}

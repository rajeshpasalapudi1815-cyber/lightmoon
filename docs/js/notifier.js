// What the service worker does when the cloud says "a reminder is due now". The push carries no content:
// the words come from this device's own copy or, for a reminder made on another device, from the encrypted
// sync copy. If the app is open, it speaks the reminder itself instead. Browsers don't let a closed web app
// make sound, so the notification shows what LightMoon will say, and tapping it opens the app to say it.
// A reminder's check-ins (announce.js) arrive the same way, until "Done" or "Snooze" is tapped.
import { idbGet, idbSet } from './idb.js';
import { decryptJson } from './vault.js';
import { reminderLine, checkInsOf, checkInLine, parseAlertId } from './announce.js';

const DUE_WINDOW_MS = 6 * 3600_000; // ignore reminders more than this overdue
const FORGET_NOTIFIED_MS = 7 * 86_400_000;
const SNOOZE_MS = 10 * 60_000;
const ICON = './icons/icon-192.png';

export async function showDueReminders({ registration, clients, now = Date.now() }) {
  const isDue = reminder => reminder.at <= now + 60_000 && reminder.at > now - DUE_WINDOW_MS;
  const cloud = (await idbGet('cloud')) ?? {};
  const answered = await answeredTasks(now);
  const live = alert => !answered.has(parseAlertId(alert.id).taskId);
  let due = ((await idbGet('reminders')) ?? []).filter(isDue).filter(live);
  if (!due.length) due = (await remindersFromSync(cloud).catch(() => [])).filter(isDue).filter(live);

  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = windows.find(client => client.visibilityState === 'visible');
  if (visible) {
    visible.postMessage({ type: 'reminders-due' });
    return;
  }

  const notified = (await idbGet('notified')) ?? {};
  if (!due.length) {
    // Browsers expect every push to show something; this only happens if the reminder was changed meanwhile.
    await registration.showNotification('LightMoon', { body: 'You have a reminder. Tap to hear it.', icon: ICON, tag: 'lightmoon-reminder' });
  }
  for (const reminder of due.filter(r => !notified[r.id])) {
    const { taskId, n } = parseAlertId(reminder.id);
    await registration.showNotification(n ? 'LightMoon is checking in' : 'LightMoon reminder', {
      // With the app lock on, keep the words off the lock screen until the app is unlocked.
      body: cloud.private ? 'You have a reminder. Tap to hear it.' : reminder.say,
      icon: ICON,
      tag: `reminder-${taskId}`, // a check-in replaces the task's earlier notification
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 150, 300, 150, 600],
      actions: [{ action: 'done', title: 'Done' }, { action: 'snooze', title: 'Snooze 10 min' }],
      data: { id: reminder.id },
    });
    notified[reminder.id] = now;
  }
  for (const [id, at] of Object.entries(notified)) if (at < now - FORGET_NOTIFIED_MS) delete notified[id];
  await idbSet('notified', notified);
}

// Tapping a reminder notification: open LightMoon (or bring it forward) and have it say the reminder.
export async function openReminder({ clients, id }) {
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (windows.length) {
    if (id) windows[0].postMessage({ type: 'speak-reminder', id });
    return windows[0].focus();
  }
  return clients.openWindow(id ? `./?reminder=${encodeURIComponent(id)}` : './');
}

// "Done" or "Snooze 10 min" on a notification, possibly with LightMoon closed. The app applies it to the task
// (and syncs it) when it next runs; meanwhile this device's alerts for the task, and the cloud's, are changed
// here so nothing more comes for it, or it comes once more in ten minutes.
export async function answerReminder({ clients, id, action, now = Date.now() }) {
  const { taskId } = parseAlertId(id);
  const until = action === 'snooze' ? now + SNOOZE_MS : null;
  await idbSet('reminderActions', [...((await idbGet('reminderActions')) ?? []), { id: taskId, action, at: now, until }]);

  const alerts = (await idbGet('reminders')) ?? [];
  const mine = alerts.filter(alert => parseAlertId(alert.id).taskId === taskId);
  const left = alerts.filter(alert => !mine.includes(alert));
  if (until) {
    const main = mine.find(alert => alert.id === taskId) ?? mine[0];
    if (main) left.push({ ...main, id: taskId, at: until, updated: now });
    const notified = (await idbGet('notified')) ?? {};
    delete notified[taskId]; // so the snoozed reminder shows again
    await idbSet('notified', notified);
  }
  await idbSet('reminders', left);
  const cloud = (await idbGet('cloud')) ?? {};
  if (cloud.url && cloud.spaceId) {
    await fetch(`${cloud.url}/spaces/${cloud.spaceId}/reminders`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminders: left.filter(alert => alert.at > now - 30 * 60_000).map(({ id: alertId, at }) => ({ id: alertId, at })) }),
    }).catch(() => {}); // offline: the app puts it right when it next syncs
  }
  for (const client of await clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'reminder-action' });
}

// Tasks answered from a notification that the app hasn't caught up with yet: no more alerts for them
// (a snoozed one only from its new time on).
async function answeredTasks(now) {
  const done = new Set();
  for (const answer of (await idbGet('reminderActions')) ?? []) {
    if (answer.action !== 'snooze' || answer.until > now + 60_000) done.add(answer.id);
  }
  return done;
}

async function remindersFromSync(cloud) {
  if (!cloud.key) return [];
  const res = await fetch(`${cloud.url}/spaces/${cloud.spaceId}/data`);
  if (!res.ok) return [];
  const data = await decryptJson(cloud.key, (await res.json()).blob);
  const settings = data.settings ?? {};
  return (data.tasks ?? [])
    .filter(task => !task.deleted && !task.done && task.remind_at)
    .flatMap(task => [
      { id: task.id, at: Date.parse(task.remind_at), say: reminderLine(task, settings) },
      ...checkInsOf(task, settings).map(check => ({ id: check.id, at: check.at, say: checkInLine(task, settings, check.n) })),
    ]);
}

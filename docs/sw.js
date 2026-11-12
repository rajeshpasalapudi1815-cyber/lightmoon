// Service worker: lets LightMoon install like an app, open without internet, and show reminder
// notifications, including when the cloud wakes it at a reminder's time while the app is closed.
import { showDueReminders, openReminder, answerReminder } from './js/notifier.js';

import { VERSION, APP_FILES } from './js/version.js';

const CACHE = `lightmoon-${VERSION}`;
const NETWORK_TIMEOUT_MS = 3000;

// Fresh copies (past the browser's HTTP cache, which GitHub Pages fills for ten minutes), so a new version never
// caches the old files.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_FILES.map(file => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
      // The open app restarts into this version at a quiet moment (js/updates.js).
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(client => client.postMessage({ type: 'updated', version: VERSION }))),
  );
});

// Network first, so updates arrive straight away; the cached copy keeps the app working offline.
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // Every page load (including shortcut and share links with their ?query) is the same app page, except the
  // install page (install.html), which is its own page and must not take the app's place in the cache.
  const appPage = request.mode === 'navigate' && !new URL(request.url).pathname.endsWith('/install.html');
  const key = appPage ? './index.html' : request;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        // 'no-cache': asked of GitHub each time (a quick "still the same?" check), so a reload after an update gets
        // the new files rather than the browser's ten-minute copy of the old ones.
        const response = await fetch(request, { cache: 'no-cache', signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
        // A page load only replaces the cached app page with a real page: a link to some other file in this folder
        // (a script, an image) must never become what opens when LightMoon is offline.
        const isPage = (response.headers.get('content-type') ?? '').includes('text/html');
        if (response.ok && (!appPage || isPage)) cache.put(key, response.clone());
        return response;
      } catch {
        return (await cache.match(key, { ignoreSearch: true })) || (await cache.match('./index.html')) || Response.error();
      }
    })(),
  );
});

// The cloud's push means "a reminder is due now" (see notifier.js).
self.addEventListener('push', event => event.waitUntil(showDueReminders({ registration: self.registration, clients: self.clients })));

// Tapping a reminder opens LightMoon, which then says the reminder out loud. Its "Done" and "Snooze 10 min"
// buttons answer it without opening anything.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const id = event.notification.data?.id;
  if (id && (event.action === 'done' || event.action === 'snooze')) {
    event.waitUntil(answerReminder({ clients: self.clients, id, action: event.action }));
  } else {
    event.waitUntil(openReminder({ clients: self.clients, id }));
  }
});

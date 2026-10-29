// Service worker: lets LightMoon install like an app, open without internet, and show reminder
// notifications, including when the cloud wakes it at a reminder's time while the app is closed.
import { showDueReminders, openReminder } from './js/notifier.js';

const CACHE = 'lightmoon-v16';
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './js/store.js',
  './js/brain.js',
  './js/tools.js',
  './js/prompt.js',
  './js/time.js',
  './js/weather.js',
  './js/lock.js',
  './js/idb.js',
  './js/vault.js',
  './js/cloud.js',
  './js/notifier.js',
  './js/announce.js',
  './js/native.js',
  './js/lifelevelling.js',
  './js/phone.js',
  './js/knowledge.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so updates arrive straight away; the cached copy keeps the app working offline.
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // Every page load (including shortcut and share links with their ?query) is the same app page.
  const key = request.mode === 'navigate' ? './index.html' : request;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
        if (response.ok) cache.put(key, response.clone());
        return response;
      } catch {
        return (await cache.match(key, { ignoreSearch: true })) || (await cache.match('./index.html')) || Response.error();
      }
    })(),
  );
});

// The cloud's push means "a reminder is due now" (see notifier.js).
self.addEventListener('push', event => event.waitUntil(showDueReminders({ registration: self.registration, clients: self.clients })));

// Tapping a reminder (or its "Hear it" button) opens LightMoon, which then says the reminder out loud.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(openReminder({ clients: self.clients, id: event.notification.data?.id }));
});

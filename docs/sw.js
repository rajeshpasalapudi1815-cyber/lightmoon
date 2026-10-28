// Service worker: lets LightMoon install like an app, open without internet, and show reminder
// notifications, including when the cloud wakes it at a reminder's time while the app is closed.
import { showDueReminders } from './js/notifier.js';

const CACHE = 'lightmoon-v4';
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

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows =>
      windows.length ? windows[0].focus() : self.clients.openWindow('./'),
    ),
  );
});

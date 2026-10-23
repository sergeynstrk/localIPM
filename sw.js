/**
 * LocalPM - Service Worker (Offline Cache)
 */

const CACHE_NAME = 'localpm-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles/app.css',
  './styles/print.css',
  './vendor/xlsx.full.min.js',
  './manifest.webmanifest',
  './app/core/dates.js',
  './app/core/wbs.js',
  './app/core/validation.js',
  './app/core/cpm.js',
  './app/storage/schema.js',
  './app/storage/db.js',
  './app/worker/cpm-worker.js',
  './app/io/transfer.js',
  './app/io/xlsx-io.js',
  './app/ui/gantt.js',
  './app/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request);
    })
  );
});

/* CETG claim form — the offline copy.
 * On the first visit every file the form needs (the page, its scripts, the receipt reader and its
 * language data, the PDF maker, the fonts) is kept on this device. From then on the form opens and
 * works with no internet at all, and a visit costs the web host nothing.
 * A new release has a different CACHE name: it is fetched in the background, kept beside the old
 * copy, and swapped in when the page asks (the person is told, and chooses when to reload).
 * This file is written by tools/build.sh from tools/sw.template.js. */
/* global self, caches, WebAssembly */
'use strict';
var CACHE = 'cetg-claims-1.3.0-fb2c34714816';
var VERSION = '1.3.0';
var FILES = [
  "index.html",
  "manifest.webmanifest",
  "styles.css",
  "fonts/caveat-latin-600-normal.woff2",
  "fonts/ibm-plex-mono-latin-400-normal.woff2",
  "fonts/ibm-plex-mono-latin-500-normal.woff2",
  "fonts/ibm-plex-mono-latin-600-normal.woff2",
  "fonts/ibm-plex-sans-latin-400-normal.woff2",
  "fonts/ibm-plex-sans-latin-500-normal.woff2",
  "fonts/ibm-plex-sans-latin-600-normal.woff2",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-32.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/icon.svg",
  "js/app.js",
  "js/approve.js",
  "js/claimpdf.js",
  "js/ocr.js",
  "js/parse.js",
  "js/store.js",
  "js/ui.js",
  "js/util.js",
  "vendor/LICENSES.txt",
  "vendor/pdf-lib-1.17.1/pdf-lib.min.js",
  "vendor/tesseract-7.0.0/eng.traineddata.gz",
  "vendor/tesseract-7.0.0/tesseract.min.js",
  "vendor/tesseract-7.0.0/worker.min.js"
  ];
var CORE = 'vendor/tesseract-7.0.0/'; // the receipt reader picks one of three engine builds for this device
var INDEX = 'index.html';

function url(p) { return new URL(p, self.registration.scope).href; }
function has(bytes) { try { return WebAssembly.validate(new Uint8Array(bytes)); } catch (e) { return false; } }
// The same two checks the reader itself makes, so the build kept here is the one it will ask for.
function coreFile() {
  var relaxed = has([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11]);
  var simd = has([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
  return CORE + (relaxed ? 'tesseract-core-relaxedsimd-lstm.wasm.js' : simd ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js');
}
function fetchFresh(p) { return fetch(new Request(url(p), { cache: 'reload' })); }

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (cache) {
    var list = FILES.concat([coreFile()]);
    // Each file is fetched past the browser's own cache, so a release never carries a stale file.
    return Promise.all(list.map(function (p) {
      return fetchFresh(p).then(function (res) {
        if (!res.ok) throw new Error('Could not fetch ' + p + ' (' + res.status + ')');
        return cache.put(url(p), res);
      });
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE && /^cetg-claims-/.test(k); }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  else if (d.type === 'VERSION' && e.source) e.source.postMessage({ type: 'VERSION', version: VERSION, cache: CACHE });
});

function inScope(u) { return u.href.indexOf(self.registration.scope) === 0; }
function cached(req) { return caches.open(CACHE).then(function (cache) { return cache.match(req, { ignoreSearch: true }); }); }

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var u;
  try { u = new URL(req.url); } catch (err) { return; }
  if (u.origin !== self.location.origin || !inScope(u)) return;
  // The release note is always asked of the host, never of the copy (it says whether there is a newer form).
  if (/\/version\.txt$/.test(u.pathname)) {
    e.respondWith(fetch(req).catch(function () { return new Response('', { status: 503, statusText: 'Offline' }); }));
    return;
  }
  // Opening the form: the kept page, so it opens with no connection; the network only when there is no copy yet.
  if (req.mode === 'navigate') {
    e.respondWith(cached(url(INDEX)).then(function (hit) { return hit || fetch(req); }));
    return;
  }
  e.respondWith(cached(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      // A file not kept at install (an engine build chosen differently) is kept once it has been fetched.
      if (res && res.ok && u.pathname.indexOf('/vendor/') !== -1) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { return cache.put(new Request(u.origin + u.pathname), copy); }).catch(function () { /* next time */ });
      }
      return res;
    });
  }));
});

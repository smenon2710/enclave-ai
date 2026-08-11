// Hand-rolled rather than a PWA build plugin (next-pwa/Workbox precache
// generators assume webpack build hooks that may not line up with Next.js
// 16's Turbopack build). Strategy: precache the stable-path assets that
// matter for offline transcription (WASM binary, worker script, manifest),
// then opportunistically cache every other same-origin GET response as it's
// fetched, serving from cache first with a background revalidate. Content-
// hashed Next.js chunk names change per build, so there's no fixed list to
// precache for those — this "cache as you go" approach picks them up on the
// first successful online visit instead.
//
// Cross-origin requests (Hugging Face model weights, OpenRouter API calls)
// are explicitly left untouched: model bytes have their own cache in
// IndexedDB (src/lib/stt/modelStore.ts), and OpenRouter responses must
// always be live.

const CACHE_NAME = "enclave-ai-v1";
const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/wasm/whisper/libmain.js",
  "/workers/whisper-worker.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

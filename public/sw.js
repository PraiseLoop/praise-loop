/* global self */
// Minimal service worker for installability (#273).
//
// It deliberately does not cache anything: the app serves owner reviews,
// captions, images and account data, and none of that belongs in a shared
// browser cache. The empty fetch listener only satisfies the browser's
// installability check. No web push is handled here.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Let the network handle every request; never respond from a cache.
});

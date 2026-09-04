/* BiliMusic Service Worker：静态资源缓存优先（版本号 URL 变更自动失效），API 直连网络。 */
const CACHE = "bilimusic-static-v1";

self.addEventListener("install", function (e) {
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
});

self.addEventListener("fetch", function (e) {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (!url.pathname.startsWith("/static/") && url.pathname !== "/manifest.json") return;
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(e.request).then(function (cached) {
        const network = fetch(e.request)
          .then(function (resp) {
            if (resp.ok) cache.put(e.request, resp.clone());
            return resp;
          })
          .catch(function () { return cached; });
        return cached || network;
      });
    })
  );
});

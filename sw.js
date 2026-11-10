const CACHE = 'moy-koshelek-app-v15-wallet-income';
const ASSETS = ['./', './index.html', './style.css', './premium.css', './assets/logo-light.webp', './assets/logo-night.webp', './assets/logo-man.webp', './assets/logo-family.webp', './assets/our-house.webp', './app.js', './cloud.js', './db.js', './import.js', './ocr.js', './data-import.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  // Обновления GitHub Pages: показываем свежий index.html при наличии интернета.
  if(event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response => {
      const copy=response.clone();
      if(response.ok) caches.open(CACHE).then(c => c.put(event.request,copy)).catch(()=>{});
      return response;
    }).catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html'))));
    return;
  }
  event.respondWith(fetch(event.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(event.request,copy)).catch(()=>{});}return r;}).catch(()=>caches.match(event.request)));
});

// Guarda o app no celular para funcionar sem internet.
// Ao mudar qualquer arquivo do app, aumente a versão abaixo.
const VERSION = 'manuais-v3.3.0';
const CORE = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs',
  'lib/wasm/openjpeg.wasm', 'lib/wasm/openjpeg_nowasm_fallback.js',
  'lib/wasm/jbig2.wasm', 'lib/wasm/jbig2_nowasm_fallback.js', 'lib/wasm/qcms_bg.wasm',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return; // servidor: sempre direto
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match('index.html')))
  );
});

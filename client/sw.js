const CACHE_NAME = "st4lv-nextcloud-media-player";

const APP_SHELL = [
	"/",
	"/index.html",
	"/styles.css",
	"/main.js",
	"/manifest.json",
];

// Install — cache app shell
self.addEventListener("install", (e) => {
	e.waitUntil(
		caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
	);
	self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches.keys().then((keys) =>
			Promise.all(
				keys
					.filter((k) => k !== CACHE_NAME)
					.map((k) => caches.delete(k))
			)
		)
	);
	self.clients.claim();
});

// Fetch — network-first for API, cache-first for static assets
self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url);

	// Skip non-GET requests
	if (e.request.method !== "GET") return;

	// API calls & media streams → network only (don't cache auth/media)
	if (url.pathname.includes("/api/")) return;

	// Google Fonts → cache first
	if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
		e.respondWith(
			caches.match(e.request).then((cached) => {
				if (cached) return cached;
				return fetch(e.request).then((res) => {
					const clone = res.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
					return res;
				});
			})
		);
		return;
	}

	// App shell & static assets → cache first, fallback to network
	e.respondWith(
		caches.match(e.request).then((cached) => {
			const fetchPromise = fetch(e.request)
				.then((res) => {
					// Update cache with fresh version
					if (res.ok) {
						const clone = res.clone();
						caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
					}
					return res;
				})
				.catch(() => cached); // Offline → use cache

			return cached || fetchPromise;
		})
	);
});
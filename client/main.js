//PWA
if ("serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		navigator.serviceWorker
			.register("/sw.js")
			.then((reg) => console.log("[SW] Registered:", reg.scope))
			.catch((err) => console.warn("[SW] Registration failed:", err));
	});
}

const API = "/api/v1/test";

const AUDIO_EXT = ["mp3", "flac", "ogg", "wav", "aac", "m4a", "opus", "wma"];
const ext = n => n.split(".").pop().toLowerCase();
const isAudio = n => AUDIO_EXT.includes(ext(n));
const fmtSize = b => { if (!b) return "—"; const u = ["o", "Ko", "Mo", "Go"]; let i = 0, s = b; while (s >= 1024 && i < u.length - 1) { s /= 1024; i++ } return `${s.toFixed(i ? 1 : 0)} ${u[i]}`; };
const fmtTime = s => { if (!s || !isFinite(s)) return "0:00"; const m = Math.floor(s / 60), sec = Math.floor(s % 60); return `${m}:${sec.toString().padStart(2, "0")}`; };

// ---- State ----
let currentUser = null;
let allTracks = [];
let filteredTracks = [];
let groupedAlbums = [];
let playlists = [];
let activePlaylistIdx = -1;
let playingTrackIdx = -1;
let currentMedia = null;
let shuffleOn = false;
let shuffleOrder = [];
let viewingPlaylistIdx = -1;
let volume = 0.8;

// ---- Rafraîchissement global (médias + playlists) ----
let refreshing = false;
let refreshTimer = null;
const REFRESH_MS = 5 * 60 * 1000;

// ---- Cache keys ----
const CACHE_KEY = "ncmp_tracks_cache";
const CACHE_TS_KEY = "ncmp_tracks_ts";

// ---- DOM ----
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ============================================
//  ACCESSIBILITY HELPERS
// ============================================
// Rows built as <div>s (track/playlist/queue rows) are clickable but
// not natively focusable or operable by keyboard. This makes them act
// like a button (Tab to focus, Enter/Space to activate) while leaving
// any real <button> nested inside them (e.g. "add" / "remove") on its
// own normal tab stop and unaffected by the row's own key handling.
function enableRowActivation(el) {
	if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
	if (!el.hasAttribute("role")) el.setAttribute("role", "button");
	el.addEventListener("keydown", e => {
		if (e.target !== el) return; // let nested buttons handle their own Enter/Space
		if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
			e.preventDefault();
			el.click();
		}
	});
}
const loginScreen = $("#login-screen");
const appScreen = $("#app-screen");

// ============================================
//  DEUX LECTEURS ALTERNÉS
//  La piste suivante est chargée dans le lecteur en attente pendant
//  que la courante joue. Au changement de piste on bascule d'un
//  lecteur à l'autre : aucune requête réseau n'est nécessaire à cet
//  instant précis, moment où Chrome mobile gèle l'onglet puisque
//  plus aucun média n'est en cours de lecture.
// ============================================
let audioPlayer = $("#audio-player");
let audioStandby = document.createElement("audio");
audioStandby.id = "audio-player-standby";
audioPlayer.preload = "auto";
audioStandby.preload = "auto";
audioPlayer.parentNode.insertBefore(audioStandby, audioPlayer.nextSibling);

let standbyPath = null;   // piste actuellement chargée dans le lecteur en attente
let playIntent = false;   // l'utilisateur veut entendre du son
let uiDirty = false;      // interface à rafraîchir au retour au premier plan
let playRetries = 0;

// ============================================
//  API
// ============================================
function hdrs() { return { "X-NC-User": currentUser }; }
async function api(ep, opts = {}) {
	const res = await fetch(`${API}${ep}`, { ...opts, headers: { ...hdrs(), ...opts.headers } });
	if (res.status === 401) { logout(); throw new Error("Session expirée"); }
	if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error || "Erreur API"); }
	const ct = res.headers.get("content-type");
	return ct && ct.includes("application/json") ? res.json() : res;
}
function mediaUrl(path) { return `${API}/files/download?path=${encodeURIComponent(path)}&userId=${currentUser}`; }

// ============================================
//  AUTH
// ============================================
function checkAuth() {
	const p = new URLSearchParams(location.search);
	if (p.get("error")) { history.replaceState({}, "", location.pathname); showLogin(); toast("Échec de l'authentification", "error"); return; }
	const uid = p.get("userId") || localStorage.getItem("nc_user");
	if (uid) { currentUser = uid; localStorage.setItem("nc_user", uid); history.replaceState({}, "", location.pathname); showApp(); return; }
	showLogin();
}
function showLogin() { loginScreen.classList.add("active"); appScreen.classList.remove("active"); }
function showApp() {
	loginScreen.classList.remove("active"); appScreen.classList.add("active");
	$("#user-name").textContent = currentUser; $("#user-dot").textContent = currentUser.charAt(0).toUpperCase();
	audioPlayer.volume = volume;
	// 1. Affichage immédiat depuis le stockage local
	loadPlaylists();
	renderPlaylistGrid();
	const hadCache = loadLibraryFromCache();
	// 2. Médias et playlists Nextcloud rafraîchis ensemble, en arrière-plan
	refreshAll({ silent: hadCache });
	startAutoRefresh();
}
function logout() {
	currentUser = null;
	stopAutoRefresh();
	localStorage.removeItem("nc_user");
	showLogin();
}

// ============================================
//  LIBRARY — cache first, then refresh
// ============================================
function loadLibraryFromCache() {
	const cached = loadCachedTracks();
	if (!cached || cached.length === 0) return false;
	allTracks = cached;
	filteredTracks = [...allTracks];
	groupAlbums();
	renderMediaView();
	return true;
}

// ============================================
//  RAFRAÎCHISSEMENT GLOBAL
//  Médias et playlists Nextcloud sont resynchronisés
//  dans le même passage, en parallèle.
// ============================================
async function refreshAll({ silent = false } = {}) {
	if (!currentUser || refreshing) return;
	refreshing = true;

	const scanStatus = $("#scan-status");
	scanStatus.classList.remove("hidden");
	scanStatus.querySelector("span").textContent = silent
		? "Mise à jour en arrière-plan…"
		: "Analyse de votre bibliothèque…";
	if (!silent) $("#media-empty").classList.add("hidden");

	try {
		const [lib, pls] = await Promise.allSettled([
			scanLibrary(),
			syncPlaylistsFromNC(),
		]);

		// Session expirée : logout() a déjà basculé sur l'écran de connexion
		const expired = [lib, pls].some(r =>
			r.status === "rejected" && String(r.reason?.message).includes("Session expirée"));
		if (expired) return;

		if (lib.status === "rejected") {
			if (silent) {
				toast("Actualisation échouée, données en cache affichées", "info");
			} else {
				toast("Erreur scan : " + lib.reason.message, "error");
				allTracks = []; filteredTracks = []; renderMediaView();
				$("#media-empty").classList.remove("hidden");
			}
		}

		const libChanged = lib.status === "fulfilled" && lib.value;
		const plChanged = pls.status === "fulfilled" && pls.value;
		if (silent && (libChanged || plChanged)) {
			toast(
				libChanged && plChanged ? "Bibliothèque et playlists mises à jour"
					: libChanged ? "Bibliothèque mise à jour"
						: "Playlists mises à jour",
				"info"
			);
		}
	} finally {
		refreshing = false;
		scanStatus.classList.add("hidden");
	}
}

function startAutoRefresh() {
	stopAutoRefresh();
	refreshTimer = setInterval(() => {
		if (!document.hidden) refreshAll({ silent: true });
	}, REFRESH_MS);
}
function stopAutoRefresh() {
	if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// Retour sur l'onglet ou reconnexion réseau : on resynchronise
document.addEventListener("visibilitychange", () => {
	if (!document.hidden && currentUser) refreshAll({ silent: true });
});
window.addEventListener("online", () => { if (currentUser) refreshAll({ silent: true }); });

function loadCachedTracks() {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		return JSON.parse(raw);
	} catch { return null; }
}

function saveCachedTracks(tracks) {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(tracks));
		localStorage.setItem(CACHE_TS_KEY, Date.now().toString());
	} catch {
		// Storage full — not critical
	}
}

function tracksChanged(oldTracks, newTracks) {
	if (oldTracks.length !== newTracks.length) return true;
	// Quick hash: compare sorted paths
	const oldPaths = oldTracks.map(t => t.path).sort().join("|");
	const newPaths = newTracks.map(t => t.path).sort().join("|");
	return oldPaths !== newPaths;
}

// Renvoie true si la bibliothèque a changé. Les erreurs remontent à refreshAll.
async function scanLibrary() {
	const data = await api("/files/scan?path=/&depth=10");
	const freshTracks = data.files || [];
	let changed = false;

	if (tracksChanged(allTracks, freshTracks)) {
		allTracks = freshTracks;
		// Re-applique le filtre de recherche s'il est actif
		const q = searchInput.value.trim().toLowerCase();
		filteredTracks = q
			? allTracks.filter(t => t.name.toLowerCase().includes(q) || t.dir.toLowerCase().includes(q))
			: [...allTracks];
		groupAlbums();
		renderMediaView();
		changed = true;
	}

	saveCachedTracks(freshTracks);
	$("#media-empty").classList.toggle("hidden", allTracks.length > 0);
	return changed;
}

function groupAlbums() {
	const map = {};
	for (const t of filteredTracks) {
		const dir = t.dir || "/";
		if (!map[dir]) map[dir] = { dir, cover: t.cover, tracks: [] };
		if (t.cover && !map[dir].cover) map[dir].cover = t.cover;
		map[dir].tracks.push(t);
	}
	groupedAlbums = Object.values(map).sort((a, b) => a.dir.localeCompare(b.dir));
}

// ============================================
//  SEARCH
// ============================================
const searchInput = $("#search-input");
const searchClear = $("#search-clear");

searchInput.addEventListener("input", () => {
	const q = searchInput.value.trim().toLowerCase();
	searchClear.classList.toggle("hidden", !q);
	if (!q) { filteredTracks = [...allTracks]; } else {
		filteredTracks = allTracks.filter(t =>
			t.name.toLowerCase().includes(q) || t.dir.toLowerCase().includes(q)
		);
	}
	groupAlbums();
	renderMediaView();
	$("#media-empty").classList.toggle("hidden", filteredTracks.length > 0);
});
searchClear.addEventListener("click", () => {
	searchInput.value = ""; searchClear.classList.add("hidden");
	filteredTracks = [...allTracks]; groupAlbums(); renderMediaView();
});

// ============================================
//  MEDIA VIEW RENDER
// ============================================
function renderMediaView() {
	const container = $("#media-content");
	if (groupedAlbums.length === 0) { container.innerHTML = ""; return; }

	container.innerHTML = groupedAlbums.map((album, ai) => {
		const dirName = album.dir.split("/").filter(Boolean).pop() || "Racine";
		const coverHtml = album.cover
			? `<img src="${mediaUrl(album.cover)}" loading="lazy" alt="">`
			: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" opacity=".2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

		const tracksHtml = album.tracks.map((t, ti) => {
			const isPlaying = currentMedia && currentMedia.path === t.path;
			const trackCover = t.cover
				? `<img src="${mediaUrl(t.cover)}" loading="lazy" alt="">`
				: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" opacity=".15"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

			return `<div class="track-row${isPlaying ? " playing" : ""}" data-path="${t.path}" data-name="${t.name}" data-cover="${t.cover || ""}"
				aria-label="Lire ${t.name}"${isPlaying ? ' aria-current="true"' : ""}>
				<span class="track-num" aria-hidden="true">${ti + 1}</span>
				<div class="track-cover" aria-hidden="true">${trackCover}</div>
				<span class="track-name">${t.name}</span>
				<span class="track-size" aria-hidden="true">${fmtSize(t.size)}</span>
				<button class="track-add" data-path="${t.path}" data-name="${t.name}" title="Ajouter à la playlist" aria-label="Ajouter ${t.name} à la playlist">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg>
				</button>
			</div>`;
		}).join("");

		return `<div class="album-group" style="animation-delay:${ai * 40}ms">
			<div class="album-header">
				<div class="album-cover" aria-hidden="true">${coverHtml}</div>
				<div>
					<div class="album-name">${dirName}</div>
					<div class="album-count">${album.tracks.length} piste${album.tracks.length > 1 ? "s" : ""}</div>
				</div>
				<button class="icon-btn album-play" data-dir="${album.dir}" title="Lire tout" aria-label="Lire l'album ${dirName}">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><polygon points="5 3 19 12 5 21 5 3"/></svg>
				</button>
			</div>
			<div class="track-list" role="list">${tracksHtml}</div>
		</div>`;
	}).join("");

	// Events
	container.querySelectorAll(".track-row").forEach(row => {
		enableRowActivation(row);
		row.addEventListener("click", e => {
			if (e.target.closest(".track-add")) return;
			playTrackDirect(row.dataset.path, row.dataset.name, row.dataset.cover);
		});
	});
	container.querySelectorAll(".track-add").forEach(btn => {
		btn.addEventListener("click", e => { e.stopPropagation(); addToActivePlaylist(btn.dataset.path, btn.dataset.name); });
	});
	container.querySelectorAll(".album-play").forEach(btn => {
		btn.addEventListener("click", () => {
			const dir = btn.dataset.dir;
			const album = groupedAlbums.find(a => a.dir === dir);
			if (!album) return;
			const tempPl = { name: dir.split("/").pop() || "Album", tracks: album.tracks.map(t => ({ path: t.path, name: t.name })) };
			playlists.push(tempPl); activePlaylistIdx = playlists.length - 1; savePlaylists();
			startPlaylist(activePlaylistIdx, false);
			toast(`Lecture: ${tempPl.name}`, "info");
		});
	});
}

// ============================================
//  PLAYBACK
// ============================================
function playTrackDirect(path, name, cover) {
	currentMedia = { path, name, cover: cover || null, tags: tagsCache.get(path) || null };
	playIntent = true;
	playRetries = 0;

	// Étiquettes pas encore connues : on affiche le repli tout de suite
	// et on corrige dès qu'elles arrivent.
	if (!currentMedia.tags) {
		const requested = path;
		fetchTags(path).then(tags => {
			if (!currentMedia || currentMedia.path !== requested) return;
			currentMedia.tags = tags;
			updateNowPlayingUI();
		});
	}

	if (standbyPath === path && audioStandby.readyState >= 2) {
		// La piste est déjà en mémoire tampon : bascule immédiate, zéro réseau
		const previous = audioPlayer;
		audioPlayer = audioStandby;
		audioStandby = previous;
		standbyPath = null;
		audioPlayer.volume = volume;
		if (audioPlayer.currentTime > 0.5) { try { audioPlayer.currentTime = 0; } catch { } }
		safePlay();
		audioStandby.pause();
		audioStandby.removeAttribute("src");
		audioStandby.load();
	} else {
		audioPlayer.volume = volume;
		audioPlayer.src = mediaUrl(path);
		safePlay();
	}

	playerBar.classList.remove("hidden");
	updateNowPlayingUI();
	preloadNextTrack();
}

// play() peut être refusée ou rester bloquée quand l'onglet est en
// arrière-plan : on retient l'intention et on reprend au retour.
function safePlay() {
	const p = audioPlayer.play();
	if (p && typeof p.catch === "function") p.catch(() => { /* reprise à la remise au premier plan */ });
}

// Le média a échoué (réseau coupé, requête avortée par le navigateur)
function handlePlaybackError() {
	if (!currentMedia || !playIntent) return;
	if (playRetries < 2) {
		playRetries++;
		audioPlayer.src = mediaUrl(currentMedia.path);
		safePlay();
		return;
	}
	if (!document.hidden) toast("Lecture impossible : " + currentMedia.name, "error");
}

// Rafraîchissement de l'interface différé tant que l'onglet est caché :
// une image ou un appel API lancé à ce moment est avorté par Chrome et
// c'est ce qui produisait la pochette cassée au retour.
function updateNowPlayingUI() {
	if (document.hidden) { uiDirty = true; updateMediaSessionMetadata(); return; }
	uiDirty = false;
	updateBarInfo(); updatePlayIcons(); highlightPlaying();
}

document.addEventListener("visibilitychange", () => {
	if (document.hidden) return;
	if (uiDirty) updateNowPlayingUI();
	// La bascule de piste a pu être avortée pendant le gel de l'onglet
	if (playIntent && audioPlayer.paused && !audioPlayer.ended) {
		if (audioPlayer.error || !audioPlayer.src) handlePlaybackError();
		else safePlay();
	}
	updatePlayIcons();
});

const playerBar = $("#player-bar");

const COVER_SVG = (size, opacity) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" opacity="${opacity}" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

// L'image n'est insérée qu'une fois chargée : en cas d'échec le SVG
// de repli reste affiché, jamais l'icône d'image cassée du navigateur.
function setCover(el, url, size, opacity) {
	el.innerHTML = COVER_SVG(size, opacity);
	if (!url) return;
	const img = new Image();
	img.alt = "";
	img.decoding = "async";
	img.addEventListener("load", () => { el.replaceChildren(img); });
	img.src = url;
}

// ============================================
//  ÉTIQUETTES AUDIO
//  Elles sont récupérées à l'avance, en même temps que la mise en
//  tampon de la piste suivante : au changement de piste en
//  arrière-plan, le titre affiché et la notification sont corrects
//  immédiatement, sans dépendre du réseau.
// ============================================
const tagsCache = new Map();     // chemin -> étiquettes
const tagsInFlight = new Map();  // chemin -> promesse en cours

function fetchTags(path) {
	if (tagsCache.has(path)) return Promise.resolve(tagsCache.get(path));
	if (tagsInFlight.has(path)) return tagsInFlight.get(path);

	const p = api(`/files/tags?path=${encodeURIComponent(path)}`)
		.then(tags => { tagsCache.set(path, tags); return tags; })
		.catch(() => { const empty = {}; tagsCache.set(path, empty); return empty; })
		.finally(() => tagsInFlight.delete(path));

	tagsInFlight.set(path, p);
	return p;
}

// Repli sur le nom de fichier et le dossier parent quand le média
// n'est pas étiqueté.
function displayInfo(media) {
	const tags = media.tags || tagsCache.get(media.path) || {};
	const dirParts = media.path.split("/").filter(Boolean);
	const folder = dirParts.length > 1 ? dirParts[dirParts.length - 2] : "Nextcloud";

	const title = tags.title || media.name.replace(/\.[^/.]+$/, "");
	const album = tags.album || folder;
	const artist = tags.artist || tags.albumartist || "";

	const coverUrl = media.cover
		? mediaUrl(media.cover)
		: (tags.hasPicture ? `${API}/files/cover?path=${encodeURIComponent(media.path)}&userId=${currentUser}` : null);

	return { title, album, artist, folder, coverUrl };
}

function updateBarInfo() {
	if (!currentMedia) return;
	const info = displayInfo(currentMedia);
	const subtitle = [info.artist, info.album].filter(Boolean).join(" · ");

	$("#pb-title").textContent = info.title;
	$("#pb-sub").textContent = subtitle;
	$("#drawer-track-name").textContent = info.title;
	$("#drawer-track-path").textContent = subtitle;
	// Le chemin reste accessible en infobulle
	$("#pb-sub").title = currentMedia.path;
	$("#drawer-track-path").title = currentMedia.path;

	setCover($("#pb-cover"), info.coverUrl, 18, "0.4");
	setCover($("#drawer-cover"), info.coverUrl, 48, "0.2");

	// Appel API repoussé à l'ouverture du tiroir : inutile et fragile
	// quand la page est en arrière-plan
	if (!$("#drawer").classList.contains("hidden")) showDrawerMeta(currentMedia.path, currentMedia.name);
	updateMediaSessionMetadata();
}

// ============================================
//  MEDIA SESSION — lock screen / notification controls
//  Required by Chrome/Android to treat this tab as an active
//  media session: without it, the background page can be
//  suspended right when a track ends and the next one isn't
//  already buffered, which is why playback was stopping.
// ============================================
const hasMediaSession = "mediaSession" in navigator;

function updateMediaSessionMetadata() {
	if (!hasMediaSession || !currentMedia) return;
	const info = displayInfo(currentMedia);
	// Une seule entrée, sans "type" figé : déclarer image/jpeg pour une
	// pochette PNG fait rejeter l'illustration par Chrome, d'où la
	// vignette manquante dans la notification.
	const artwork = info.coverUrl ? [{ src: info.coverUrl, sizes: "512x512" }] : [];
	try {
		navigator.mediaSession.metadata = new MediaMetadata({
			title: info.title,
			artist: info.artist || info.folder,
			album: info.album,
			artwork,
		});
	} catch { /* métadonnées malformées, on ignore */ }
}

function setupMediaSessionHandlers() {
	if (!hasMediaSession) return;
	const setHandler = (action, fn) => {
		try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* action unsupported on this browser */ }
	};
	setHandler("play", () => { playIntent = true; safePlay(); });
	setHandler("pause", () => { playIntent = false; audioPlayer.pause(); });
	setHandler("stop", () => { playIntent = false; audioPlayer.pause(); });
	setHandler("previoustrack", () => playPrevTrack());
	setHandler("nexttrack", () => playNextTrack());
	setHandler("seekbackward", (details) => {
		audioPlayer.currentTime = Math.max(audioPlayer.currentTime - (details.seekOffset || 10), 0);
	});
	setHandler("seekforward", (details) => {
		audioPlayer.currentTime = Math.min(audioPlayer.currentTime + (details.seekOffset || 10), audioPlayer.duration || Infinity);
	});
	setHandler("seekto", (details) => {
		if (details.fastSeek && "fastSeek" in audioPlayer) { audioPlayer.fastSeek(details.seekTime); return; }
		audioPlayer.currentTime = details.seekTime;
	});
}

function updateMediaSessionPositionState() {
	if (!hasMediaSession || !("setPositionState" in navigator.mediaSession)) return;
	if (!audioPlayer.duration || !isFinite(audioPlayer.duration)) return;
	try {
		navigator.mediaSession.setPositionState({
			duration: audioPlayer.duration,
			playbackRate: audioPlayer.playbackRate || 1,
			position: audioPlayer.currentTime,
		});
	} catch { /* position momentarily out of range during track switch */ }
}

// ============================================
//  PRÉCHARGEMENT DE LA PISTE SUIVANTE
//  Elle est chargée dans le lecteur en attente, pas seulement dans le
//  cache HTTP : la bascule ne dépend donc ni du réseau ni des en-têtes
//  de cache renvoyés par Nextcloud.
// ============================================
function peekNextTrack() {
	if (activePlaylistIdx < 0 || !playlists[activePlaylistIdx]) return null;
	const pl = playlists[activePlaylistIdx];
	if (!pl || pl.tracks.length === 0) return null;
	if (shuffleOn) {
		const si = shuffleOrder.indexOf(playingTrackIdx);
		if (si < 0) return null;
		return pl.tracks[shuffleOrder[(si + 1) % shuffleOrder.length]];
	}
	return pl.tracks[(playingTrackIdx + 1) % pl.tracks.length];
}

function preloadNextTrack() {
	// Seulement quand la lecture suit réellement la playlist active
	const pl = playlists[activePlaylistIdx];
	if (!pl || !currentMedia || pl.tracks[playingTrackIdx]?.path !== currentMedia.path) return;
	const next = peekNextTrack();
	if (!next || next.path === standbyPath) return;
	if (currentMedia && next.path === currentMedia.path) return;
	standbyPath = next.path;
	fetchTags(next.path);   // étiquettes prêtes avant la bascule
	audioStandby.pause();
	audioStandby.volume = volume;   // non coupé : il prendra le relais tel quel
	audioStandby.src = mediaUrl(next.path);
	audioStandby.load();
}

function updatePlayIcons() {
	const paused = audioPlayer.paused;
	const svg = paused ? `<polygon points="5 3 19 12 5 21 5 3"/>` : `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
	$("#play-icon").innerHTML = svg;
	$("#d-play-icon").innerHTML = svg;
	const label = paused ? "Lecture" : "Pause";
	$("#btn-play").setAttribute("aria-label", label);
	$("#d-play").setAttribute("aria-label", label);
}

function togglePlay() {
	if (!audioPlayer.src) return;
	if (audioPlayer.paused) { playIntent = true; safePlay(); }
	else { playIntent = false; audioPlayer.pause(); }
	updatePlayIcons();
}

function highlightPlaying() {
	document.querySelectorAll(".track-row").forEach(r => {
		r.classList.toggle("playing", currentMedia && r.dataset.path === currentMedia.path);
	});
	renderDrawerQueue();
	if (viewingPlaylistIdx >= 0) renderDetailTracks();
}

// Les deux lecteurs partagent les mêmes gestionnaires : seul celui qui
// est courant à l'instant T met à jour l'interface et enchaîne.
function wireDeck(el) {
	const isCurrent = () => el === audioPlayer;

	el.addEventListener("timeupdate", () => {
		if (!isCurrent() || !el.duration || !isFinite(el.duration)) return;
		updateMediaSessionPositionState();
		// Filet de sécurité si la file a changé depuis le début de la piste
		if (el.duration - el.currentTime <= 20) preloadNextTrack();
		if (document.hidden) return;   // inutile de peindre une interface invisible
		const pct = (el.currentTime / el.duration) * 100;
		$("#pb-progress-fill").style.width = pct + "%";
		$("#seek-bar").value = pct;
		$("#time-current").textContent = fmtTime(el.currentTime);
		$("#time-total").textContent = fmtTime(el.duration);
		const timeLabel = `${fmtTime(el.currentTime)} sur ${fmtTime(el.duration)}`;
		const progressBar = $("#pb-progress-bar");
		progressBar.setAttribute("aria-valuenow", Math.round(pct));
		progressBar.setAttribute("aria-valuetext", timeLabel);
		$("#seek-bar").setAttribute("aria-valuetext", timeLabel);
	});

	el.addEventListener("playing", () => {
		if (!isCurrent()) return;
		playRetries = 0;
		// La piste suivante est mise en tampon dès le début de la lecture,
		// et non quinze secondes avant la fin : en arrière-plan les timers
		// sont bridés et ce préchargement tardif n'avait pas le temps
		// d'aboutir.
		preloadNextTrack();
	});

	el.addEventListener("play", () => {
		if (!isCurrent()) return;
		playIntent = true;
		updatePlayIcons();
		if (hasMediaSession) navigator.mediaSession.playbackState = "playing";
	});

	el.addEventListener("pause", () => {
		if (!isCurrent()) return;
		updatePlayIcons();
		if (hasMediaSession) navigator.mediaSession.playbackState = "paused";
	});

	el.addEventListener("loadedmetadata", () => { if (isCurrent()) updateMediaSessionPositionState(); });
	el.addEventListener("ended", () => { if (isCurrent()) playNextTrack(); });
	el.addEventListener("error", () => { if (isCurrent()) handlePlaybackError(); });
}
wireDeck(audioPlayer);
wireDeck(audioStandby);

// Aucune image cassée dans l'interface : une pochette qui échoue disparaît
document.addEventListener("error", e => {
	if (e.target.tagName === "IMG") e.target.style.visibility = "hidden";
}, true);

$("#seek-bar").addEventListener("input", function () {
	if (!audioPlayer.duration) return;
	audioPlayer.currentTime = (this.value / 100) * audioPlayer.duration;
});
$("#pb-progress-bar").addEventListener("click", e => {
	if (!audioPlayer.duration) return;
	const r = e.currentTarget.getBoundingClientRect();
	audioPlayer.currentTime = ((e.clientX - r.left) / r.width) * audioPlayer.duration;
});
$("#pb-progress-bar").addEventListener("keydown", e => {
	if (!audioPlayer.duration) return;
	const step = audioPlayer.duration * 0.05;
	if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); audioPlayer.currentTime = Math.min(audioPlayer.currentTime + step, audioPlayer.duration); }
	else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); audioPlayer.currentTime = Math.max(audioPlayer.currentTime - step, 0); }
	else if (e.key === "Home") { e.preventDefault(); audioPlayer.currentTime = 0; }
	else if (e.key === "End") { e.preventDefault(); audioPlayer.currentTime = audioPlayer.duration; }
});

// ============================================
//  VOLUME
// ============================================
function setVolume(v) {
	volume = Math.max(0, Math.min(1, v));
	audioPlayer.volume = volume;
	audioStandby.volume = volume;
	const pct = Math.round(volume * 100);
	$("#volume-slider").value = pct;
	$("#drawer-volume").value = pct;
	$("#volume-slider").setAttribute("aria-valuetext", `${pct} pour cent`);
	$("#drawer-volume").setAttribute("aria-valuetext", `${pct} pour cent`);
	$("#btn-mute").setAttribute("aria-pressed", volume === 0 ? "true" : "false");
	$("#btn-mute").setAttribute("aria-label", volume === 0 ? "Réactiver le son" : "Couper le son");
	updateVolumeIcon();
}

function updateVolumeIcon() {
	const icon = $("#volume-icon");
	if (volume === 0) {
		icon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`;
	} else if (volume < 0.5) {
		icon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/>`;
	} else {
		icon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>`;
	}
}

$("#volume-slider").addEventListener("input", function () { setVolume(this.value / 100); });
$("#drawer-volume").addEventListener("input", function () { setVolume(this.value / 100); });
$("#btn-mute").addEventListener("click", () => { setVolume(volume > 0 ? 0 : 0.8); });

// ============================================
//  PLAYLIST PLAYBACK
// ============================================
function playNextTrack() {
	if (activePlaylistIdx < 0 || !playlists[activePlaylistIdx]) return;
	const pl = playlists[activePlaylistIdx]; if (pl.tracks.length === 0) return;
	if (shuffleOn) {
		const si = shuffleOrder.indexOf(playingTrackIdx);
		doPlayTrack(shuffleOrder[(si + 1) % shuffleOrder.length]);
	} else { doPlayTrack((playingTrackIdx + 1) % pl.tracks.length); }
}
function playPrevTrack() {
	if (activePlaylistIdx < 0 || !playlists[activePlaylistIdx]) return;
	const pl = playlists[activePlaylistIdx]; if (pl.tracks.length === 0) return;
	if (shuffleOn) {
		const si = shuffleOrder.indexOf(playingTrackIdx);
		doPlayTrack(shuffleOrder[si <= 0 ? shuffleOrder.length - 1 : si - 1]);
	} else { doPlayTrack(playingTrackIdx <= 0 ? pl.tracks.length - 1 : playingTrackIdx - 1); }
}
function doPlayTrack(idx) {
	const pl = playlists[activePlaylistIdx]; if (!pl || idx < 0 || idx >= pl.tracks.length) return;
	playingTrackIdx = idx;
	const t = pl.tracks[idx];
	const found = allTracks.find(at => at.path === t.path);
	playTrackDirect(t.path, t.name, found?.cover || null);
}
function startPlaylist(plIdx, shuffle) {
	activePlaylistIdx = plIdx;
	const pl = playlists[plIdx]; if (!pl || pl.tracks.length === 0) { toast("Playlist vide", "info"); return; }
	shuffleOn = shuffle;
	$("#btn-shuffle-toggle").classList.toggle("active-toggle", shuffleOn);
	$("#btn-shuffle-toggle").setAttribute("aria-pressed", shuffleOn ? "true" : "false");
	if (shuffleOn) buildShuffleOrder();
	doPlayTrack(shuffleOn ? shuffleOrder[0] : 0);
}
function buildShuffleOrder() {
	const pl = playlists[activePlaylistIdx]; if (!pl) return;
	shuffleOrder = pl.tracks.map((_, i) => i);
	for (let i = shuffleOrder.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[i]]; }
}
function toggleShuffle() {
	shuffleOn = !shuffleOn;
	$("#btn-shuffle-toggle").classList.toggle("active-toggle", shuffleOn);
	$("#btn-shuffle-toggle").setAttribute("aria-pressed", shuffleOn ? "true" : "false");
	if (shuffleOn) buildShuffleOrder();
	toast(shuffleOn ? "Aléatoire activé" : "Lecture séquentielle", "info");
}

// ============================================
//  PLAYLISTS — storage
// ============================================
const PL_KEY = "ncmp_playlists";

// Chargement local uniquement : la synchro Nextcloud passe par refreshAll()
function loadPlaylists() {
	try { playlists = JSON.parse(localStorage.getItem(PL_KEY) || "[]"); } catch { playlists = []; }
	if (playlists.length === 0) playlists.push({ name: "Ma playlist", tracks: [] });
	activePlaylistIdx = 0;
}
function savePlaylists() { localStorage.setItem(PL_KEY, JSON.stringify(playlists)); }

// Playlists Nextcloud supprimées localement : à ne pas réimporter à chaque synchro
const PL_DELETED_KEY = "ncmp_playlists_deleted";
function loadDeletedNC() {
	try { return new Set(JSON.parse(localStorage.getItem(PL_DELETED_KEY) || "[]")); } catch { return new Set(); }
}
function markDeletedNC(name) {
	const s = loadDeletedNC(); s.add(name);
	localStorage.setItem(PL_DELETED_KEY, JSON.stringify([...s]));
}

// Nom du fichier .m3u côté Nextcloud : peut différer du nom local après renommage
const ncKey = pl => pl.ncName || pl.name;
const sameTracks = (a, b) => a.length === b.length && a.every((t, i) => t.path === b[i].path);

function removePlaylistAt(i) {
	playlists.splice(i, 1);
	if (activePlaylistIdx === i) { activePlaylistIdx = -1; playingTrackIdx = -1; }
	else if (activePlaylistIdx > i) activePlaylistIdx--;
	if (viewingPlaylistIdx === i) viewingPlaylistIdx = -1;
	else if (viewingPlaylistIdx > i) viewingPlaylistIdx--;
}

// Le contenu d'une playlist en cours de lecture a changé : on retrouve
// la piste courante par son chemin pour ne pas sauter n'importe où.
function reindexPlaying(plIdx, oldTracks, newTracks) {
	if (activePlaylistIdx !== plIdx || playingTrackIdx < 0) return;
	const cur = oldTracks[playingTrackIdx];
	playingTrackIdx = cur ? newTracks.findIndex(t => t.path === cur.path) : -1;
}

/**
 * Synchronise les playlists avec le dossier /Playlists de Nextcloud :
 * nouvelles playlists importées, contenu des playlists déjà importées
 * mis à jour, playlists supprimées côté serveur retirées.
 * Les playlists modifiées localement et pas encore téléversées (dirty)
 * ne sont jamais écrasées. Renvoie true si quelque chose a changé.
 */
async function syncPlaylistsFromNC() {
	let data;
	try {
		data = await api(`/files?path=${encodeURIComponent("/Playlists")}`);
	} catch (err) {
		if (String(err.message).includes("Session expirée")) throw err;
		return false; // dossier absent ou serveur injoignable : on garde le local
	}

	const m3us = (data.files || []).filter(f => f.name.endsWith(".m3u"));
	const deleted = loadDeletedNC();
	const remoteNames = new Set();
	let changed = false;

	for (const f of m3us) {
		const plName = f.name.replace(/\.m3u$/, "");
		if (deleted.has(plName)) continue;
		remoteNames.add(plName);

		let tracks;
		try {
			// cache: "no-store" — sinon le navigateur resert l'ancien .m3u
			const res = await fetch(mediaUrl(f.path), { cache: "no-store", headers: hdrs() });
			if (!res.ok) continue;
			tracks = parseM3U(await res.text());
		} catch { continue; }
		if (tracks.length === 0) continue;

		const idx = playlists.findIndex(p => p.imported && ncKey(p) === plName);
		if (idx < 0) {
			playlists.push({ name: plName, ncName: plName, tracks, imported: true, dirty: false });
			changed = true;
			continue;
		}

		const pl = playlists[idx];
		if (pl.dirty) continue; // modifications locales non téléversées : priorité au local
		if (sameTracks(pl.tracks, tracks)) continue;

		const oldTracks = pl.tracks;
		pl.tracks = tracks;
		reindexPlaying(idx, oldTracks, tracks);
		if (shuffleOn && activePlaylistIdx === idx) buildShuffleOrder();
		changed = true;
	}

	// Playlists importées qui ont disparu du serveur
	for (let i = playlists.length - 1; i >= 0; i--) {
		const pl = playlists[i];
		if (pl.imported && !pl.dirty && !remoteNames.has(ncKey(pl))) {
			removePlaylistAt(i);
			changed = true;
		}
	}

	if (playlists.length === 0) playlists.push({ name: "Ma playlist", tracks: [] });
	if (activePlaylistIdx < 0 || activePlaylistIdx >= playlists.length) activePlaylistIdx = 0;

	if (changed) { savePlaylists(); refreshPlaylistUI(); }
	return changed;
}

// Réaffiche ce que l'utilisateur a sous les yeux après une synchro
function refreshPlaylistUI() {
	if (viewingPlaylistIdx >= 0 && playlists[viewingPlaylistIdx]) {
		const pl = playlists[viewingPlaylistIdx];
		$("#detail-meta").textContent = `${pl.tracks.length} piste${pl.tracks.length > 1 ? "s" : ""}${pl.imported ? " · Importée depuis Nextcloud" : ""}`;
		renderDetailTracks();
	} else if (viewingPlaylistIdx < 0 && currentView === "playlists") {
		$("#playlist-detail").classList.add("hidden");
		$("#playlist-grid").classList.remove("hidden");
	}
	renderPlaylistGrid();
	renderDrawerQueue();
}

function parseM3U(text) {
	const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
	const tracks = []; let nextName = null;
	for (const line of lines) {
		if (line.startsWith("#EXTM3U")) continue;
		if (line.startsWith("#EXTINF:")) { const c = line.indexOf(","); nextName = c >= 0 ? line.slice(c + 1).trim() : null; }
		else if (!line.startsWith("#")) { tracks.push({ path: line, name: nextName || line.split("/").pop() }); nextName = null; }
	}
	return tracks;
}

function addToActivePlaylist(path, name) {
	if (activePlaylistIdx < 0) activePlaylistIdx = 0;
	const pl = playlists[activePlaylistIdx];
	if (pl.tracks.some(t => t.path === path)) { toast("Déjà dans la playlist", "info"); return; }
	pl.tracks.push({ path, name }); pl.dirty = true; savePlaylists();
	toast(`"${name}" → ${pl.name}`, "success");
	if (viewingPlaylistIdx === activePlaylistIdx) renderDetailTracks();
}

async function savePlaylistToNC() {
	const pl = playlists[viewingPlaylistIdx];
	if (!pl || pl.tracks.length === 0) { toast("Playlist vide", "info"); return; }
	const m3u = "#EXTM3U\n" + pl.tracks.map(t => `#EXTINF:-1,${t.name}\n${t.path}`).join("\n") + "\n";
	try {
		await api("/files/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "/Playlists" }) }).catch(() => { });
		await fetch(`${API}/files/upload?path=${encodeURIComponent(`/Playlists/${pl.name}.m3u`)}`, { method: "PUT", headers: { "X-NC-User": currentUser }, body: m3u });
		pl.imported = true; pl.ncName = pl.name; pl.dirty = false; savePlaylists();
		toast(`Sauvegardée sur Nextcloud`, "success");
	} catch (err) { toast("Erreur: " + err.message, "error"); }
}

// ============================================
//  PLAYLIST UI
// ============================================
function renderPlaylistGrid() {
	const grid = $("#playlist-grid");
	grid.innerHTML = playlists.map((pl, i) =>
		`<div class="pl-card" data-idx="${i}" style="animation-delay:${i * 30}ms"
			aria-label="Ouvrir la playlist ${pl.name}, ${pl.tracks.length} piste${pl.tracks.length > 1 ? "s" : ""}">
			<div class="pl-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" focusable="false"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
			<div class="pl-card-name">${pl.name}</div>
			<div class="pl-card-count" aria-hidden="true">${pl.tracks.length} piste${pl.tracks.length > 1 ? "s" : ""}</div>
			${pl.imported ? `<span class="pl-card-imported">Nextcloud</span>` : ""}
		</div>`
	).join("");
	grid.querySelectorAll(".pl-card").forEach(c => {
		enableRowActivation(c);
		c.addEventListener("click", () => openPlaylistDetail(parseInt(c.dataset.idx)));
	});
}

function openPlaylistDetail(idx) {
	viewingPlaylistIdx = idx;
	$("#playlist-grid").classList.add("hidden");
	$("#playlist-detail").classList.remove("hidden");
	const pl = playlists[idx];
	$("#detail-name").value = pl.name;
	$("#detail-meta").textContent = `${pl.tracks.length} piste${pl.tracks.length > 1 ? "s" : ""}${pl.imported ? " · Importée depuis Nextcloud" : ""}`;
	renderDetailTracks();
}

function renderDetailTracks() {
	const pl = playlists[viewingPlaylistIdx]; if (!pl) return;
	const container = $("#detail-tracks");
	if (pl.tracks.length === 0) { container.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--text-3);font-size:.84rem;">Playlist vide</div>`; return; }
	container.innerHTML = pl.tracks.map((t, i) => {
		const isPlaying = activePlaylistIdx === viewingPlaylistIdx && playingTrackIdx === i;
		return `<div class="dt-row${isPlaying ? " playing" : ""}" data-idx="${i}"
			aria-label="Lire ${t.name}"${isPlaying ? ' aria-current="true"' : ""}>
			<span class="dt-num" aria-hidden="true">${i + 1}</span><span class="dt-name">${t.name}</span>
			<span class="dt-ext" aria-hidden="true">${ext(t.name)}</span>
			<button class="dt-remove" data-idx="${i}" aria-label="Retirer ${t.name} de la playlist"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
		</div>`;
	}).join("");
	container.querySelectorAll(".dt-row").forEach(r => {
		enableRowActivation(r);
		r.addEventListener("click", e => { if (e.target.closest(".dt-remove")) return; activePlaylistIdx = viewingPlaylistIdx; doPlayTrack(parseInt(r.dataset.idx)); });
	});
	container.querySelectorAll(".dt-remove").forEach(btn => btn.addEventListener("click", e => {
		e.stopPropagation(); const idx = parseInt(btn.dataset.idx);
		pl.tracks.splice(idx, 1); pl.dirty = true;
		if (activePlaylistIdx === viewingPlaylistIdx) { if (playingTrackIdx === idx) playingTrackIdx = -1; else if (playingTrackIdx > idx) playingTrackIdx--; }
		savePlaylists(); $("#detail-meta").textContent = `${pl.tracks.length} piste${pl.tracks.length > 1 ? "s" : ""}`; renderDetailTracks();
	}));
}

// ============================================
//  DRAWER
// ============================================
let drawerReturnFocus = null;

function getFocusableInDrawer() {
	return Array.from($("#drawer").querySelectorAll(
		'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
	)).filter(el => el.offsetParent !== null);
}

function drawerKeydown(e) {
	if (e.key === "Escape") { e.preventDefault(); closeDrawer(); return; }
	if (e.key !== "Tab") return;
	const focusable = getFocusableInDrawer();
	if (focusable.length === 0) return;
	const first = focusable[0], last = focusable[focusable.length - 1];
	if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
	else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function openDrawer() {
	drawerReturnFocus = document.activeElement;
	$("#drawer").classList.remove("hidden");
	if (currentMedia) showDrawerMeta(currentMedia.path, currentMedia.name);
	$("#btn-expand").setAttribute("aria-expanded", "true");
	document.addEventListener("keydown", drawerKeydown);
	// Move focus into the dialog, per the standard dialog pattern.
	$("#btn-collapse").focus();
}
function closeDrawer() {
	$("#drawer").classList.add("hidden");
	$("#btn-expand").setAttribute("aria-expanded", "false");
	document.removeEventListener("keydown", drawerKeydown);
	(drawerReturnFocus || $("#btn-expand")).focus();
}

async function showDrawerMeta(path, name) {
	try {
		const stat = await api(`/files/stat?path=${encodeURIComponent(path)}`);
		$("#drawer-meta").innerHTML = [stat.mime && `<span class="dm-tag">${stat.mime}</span>`, stat.size && `<span class="dm-tag">${fmtSize(stat.size)}</span>`, `<span class="dm-tag">${ext(name).toUpperCase()}</span>`].filter(Boolean).join("");
	} catch { $("#drawer-meta").innerHTML = `<span class="dm-tag">${ext(name).toUpperCase()}</span>`; }
}

function renderDrawerQueue() {
	if (activePlaylistIdx < 0) { $("#drawer-queue").innerHTML = ""; return; }
	const pl = playlists[activePlaylistIdx]; if (!pl) return;
	const q = $("#drawer-queue");
	q.innerHTML = pl.tracks.map((t, i) => `<div class="dq-row${i === playingTrackIdx ? " playing" : ""}" data-idx="${i}"
		aria-label="Lire ${t.name}"${i === playingTrackIdx ? ' aria-current="true"' : ""}>
		<span class="dq-num" aria-hidden="true">${i + 1}</span><span class="dq-name">${t.name}</span></div>`).join("");
	q.querySelectorAll(".dq-row").forEach(r => {
		enableRowActivation(r);
		r.addEventListener("click", () => doPlayTrack(parseInt(r.dataset.idx)));
	});
}

// ============================================
//  VIEW SWITCHING
// ============================================
let currentView = "medias";
function switchView(view) {
	currentView = view;
	$$("#main-nav .nav-tab").forEach(t => {
		const active = t.dataset.view === view;
		t.classList.toggle("active", active);
		t.setAttribute("aria-selected", active ? "true" : "false");
		t.tabIndex = active ? 0 : -1;
	});
	$("#view-medias").classList.toggle("hidden", view !== "medias");
	$("#view-playlists").classList.toggle("hidden", view !== "playlists");
	if (view === "playlists") { $("#playlist-detail").classList.add("hidden"); $("#playlist-grid").classList.remove("hidden"); renderPlaylistGrid(); }
}
$$("#main-nav .nav-tab").forEach(t => t.addEventListener("click", () => switchView(t.dataset.view)));
// Standard tablist keyboard pattern: Left/Right move focus AND selection between tabs.
$("#main-nav").addEventListener("keydown", e => {
	if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
	const tabs = Array.from($$("#main-nav .nav-tab"));
	const i = tabs.indexOf(document.activeElement);
	if (i < 0) return;
	e.preventDefault();
	const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
	next.focus();
	switchView(next.dataset.view);
});

// ============================================
//  EVENTS
// ============================================
$("#login-btn").addEventListener("click", () => { location.href = `${API}/login`; });
$("#logout-btn").addEventListener("click", logout);
$("#btn-play").addEventListener("click", togglePlay);
$("#d-play").addEventListener("click", togglePlay);
$("#btn-prev").addEventListener("click", playPrevTrack);
$("#btn-next").addEventListener("click", playNextTrack);
$("#d-prev").addEventListener("click", playPrevTrack);
$("#d-next").addEventListener("click", playNextTrack);
$("#btn-shuffle-toggle").addEventListener("click", toggleShuffle);
$("#btn-expand").addEventListener("click", openDrawer);
$("#btn-collapse").addEventListener("click", closeDrawer);
$("#drawer-overlay").addEventListener("click", closeDrawer);
$("#btn-add-queue").addEventListener("click", () => { if (currentMedia) addToActivePlaylist(currentMedia.path, currentMedia.name); });

// Optionnel : <button id="btn-refresh"> dans le HTML pour forcer une synchro
$("#btn-refresh")?.addEventListener("click", () => refreshAll({ silent: true }));

$("#btn-new-playlist").addEventListener("click", () => {
	const name = prompt("Nom de la playlist :"); if (!name) return;
	playlists.push({ name, tracks: [] }); savePlaylists(); renderPlaylistGrid();
	toast(`Playlist "${name}" créée`, "success");
});
$("#btn-back-playlists").addEventListener("click", () => {
	viewingPlaylistIdx = -1; $("#playlist-detail").classList.add("hidden");
	$("#playlist-grid").classList.remove("hidden"); renderPlaylistGrid();
});
$("#btn-shuffle").addEventListener("click", () => { if (viewingPlaylistIdx >= 0) startPlaylist(viewingPlaylistIdx, true); });
$("#btn-play-all").addEventListener("click", () => { if (viewingPlaylistIdx >= 0) startPlaylist(viewingPlaylistIdx, false); });
$("#btn-save-nc").addEventListener("click", savePlaylistToNC);
$("#btn-delete-playlist").addEventListener("click", () => {
	if (viewingPlaylistIdx < 0) return;
	if (!confirm(`Supprimer "${playlists[viewingPlaylistIdx].name}" ?`)) return;
	const removed = playlists[viewingPlaylistIdx];
	if (removed.imported) markDeletedNC(ncKey(removed));
	playlists.splice(viewingPlaylistIdx, 1);
	if (activePlaylistIdx === viewingPlaylistIdx) { activePlaylistIdx = -1; playingTrackIdx = -1; }
	else if (activePlaylistIdx > viewingPlaylistIdx) activePlaylistIdx--;
	if (playlists.length === 0) playlists.push({ name: "Ma playlist", tracks: [] });
	if (activePlaylistIdx < 0) activePlaylistIdx = 0;
	savePlaylists(); viewingPlaylistIdx = -1;
	$("#playlist-detail").classList.add("hidden"); $("#playlist-grid").classList.remove("hidden");
	renderPlaylistGrid(); toast("Supprimée", "success");
});
$("#detail-name").addEventListener("change", function () {
	if (viewingPlaylistIdx < 0) return;
	playlists[viewingPlaylistIdx].name = this.value.trim() || "Sans nom";
	playlists[viewingPlaylistIdx].dirty = true;
	savePlaylists();
});

document.addEventListener("keydown", e => {
	// Don't hijack Space/Enter when focus is on a control that needs it
	// itself (form fields, buttons, custom rows, tabs, sliders) —
	// otherwise keyboard users could never activate those controls.
	const interactive = e.target.closest('input, textarea, select, button, [role="button"], [role="slider"], [role="tab"], a[href]');
	if (interactive) return;
	if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
	if (e.key === "ArrowRight" && e.shiftKey) playNextTrack();
	if (e.key === "ArrowLeft" && e.shiftKey) playPrevTrack();
});

// ============================================
//  HELPERS
// ============================================
function setLoading(show) { $("#loading").classList.toggle("visible", show); }
function toast(msg, type = "info") {
	const el = document.createElement("div"); el.className = `toast ${type}`; el.textContent = msg;
	$("#toast-container").appendChild(el);
	setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(8px)"; el.style.transition = "all .25s"; setTimeout(() => el.remove(), 250); }, 2500);
}

// ============================================
//  INIT
// ============================================
setupMediaSessionHandlers();
checkAuth();
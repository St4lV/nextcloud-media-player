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

// ---- Cache keys ----
const CACHE_KEY = "ncmp_tracks_cache";
const CACHE_TS_KEY = "ncmp_tracks_ts";

// ---- DOM ----
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const loginScreen = $("#login-screen");
const appScreen = $("#app-screen");
const audioPlayer = $("#audio-player");

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
	loadPlaylists();
	loadLibrary();
}
function logout() { currentUser = null; localStorage.removeItem("nc_user"); showLogin(); }

// ============================================
//  LIBRARY — cache first, then refresh
// ============================================
function loadLibrary() {
	// 1. Try cache
	const cached = loadCachedTracks();
	if (cached && cached.length > 0) {
		allTracks = cached;
		filteredTracks = [...allTracks];
		groupAlbums();
		renderMediaView();
		// Show subtle refresh indicator
		$("#scan-status").classList.remove("hidden");
		$("#scan-status").querySelector("span").textContent = "Mise à jour en arrière-plan…";
	}

	// 2. Always fetch fresh data
	scanLibrary(cached && cached.length > 0);
}

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

async function scanLibrary(hadCache = false) {
	const scanStatus = $("#scan-status");
	if (!hadCache) {
		scanStatus.classList.remove("hidden");
		scanStatus.querySelector("span").textContent = "Analyse de votre bibliothèque…";
		$("#media-empty").classList.add("hidden");
	}

	try {
		const data = await api("/files/scan?path=/&depth=10");
		const freshTracks = data.files || [];

		// Compare with current state
		if (tracksChanged(allTracks, freshTracks)) {
			allTracks = freshTracks;
			filteredTracks = [...allTracks];
			// Re-apply search filter if active
			const q = searchInput.value.trim().toLowerCase();
			if (q) {
				filteredTracks = allTracks.filter(t =>
					t.name.toLowerCase().includes(q) || t.dir.toLowerCase().includes(q)
				);
			}
			groupAlbums();
			renderMediaView();
			if (hadCache) toast("Bibliothèque mise à jour", "info");
		}

		// Save to cache
		saveCachedTracks(freshTracks);

		if (allTracks.length === 0) $("#media-empty").classList.remove("hidden");
	} catch (err) {
		if (err.message.includes("Session expirée")) return;
		if (!hadCache) {
			toast("Erreur scan: " + err.message, "error");
			allTracks = []; filteredTracks = []; renderMediaView();
			$("#media-empty").classList.remove("hidden");
		} else {
			toast("Actualisation échouée, données en cache affichées", "info");
		}
	} finally {
		scanStatus.classList.add("hidden");
	}
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

			return `<div class="track-row${isPlaying ? " playing" : ""}" data-path="${t.path}" data-name="${t.name}" data-cover="${t.cover || ""}">
				<span class="track-num">${ti + 1}</span>
				<div class="track-cover">${trackCover}</div>
				<span class="track-name">${t.name}</span>
				<span class="track-size">${fmtSize(t.size)}</span>
				<button class="track-add" data-path="${t.path}" data-name="${t.name}" title="Ajouter à la playlist">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
				</button>
			</div>`;
		}).join("");

		return `<div class="album-group" style="animation-delay:${ai * 40}ms">
			<div class="album-header">
				<div class="album-cover">${coverHtml}</div>
				<div>
					<div class="album-name">${dirName}</div>
					<div class="album-count">${album.tracks.length} piste${album.tracks.length > 1 ? "s" : ""}</div>
				</div>
				<button class="icon-btn album-play" data-dir="${album.dir}" title="Lire tout">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
				</button>
			</div>
			<div class="track-list">${tracksHtml}</div>
		</div>`;
	}).join("");

	// Events
	container.querySelectorAll(".track-row").forEach(row => {
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
	currentMedia = { path, name, cover: cover || null };
	audioPlayer.src = mediaUrl(path);
	audioPlayer.play().catch(() => { });
	playerBar.classList.remove("hidden");
	updateBarInfo(); updatePlayIcons(); highlightPlaying();
}

const playerBar = $("#player-bar");

function updateBarInfo() {
	if (!currentMedia) return;
	$("#pb-title").textContent = currentMedia.name;
	$("#pb-sub").textContent = currentMedia.path;
	$("#drawer-track-name").textContent = currentMedia.name;
	$("#drawer-track-path").textContent = currentMedia.path;

	const coverHtml = currentMedia.cover
		? `<img src="${mediaUrl(currentMedia.cover)}" alt="">`
		: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" opacity="0.4"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
	$("#pb-cover").innerHTML = coverHtml;

	const drawerCoverHtml = currentMedia.cover
		? `<img src="${mediaUrl(currentMedia.cover)}" alt="">`
		: `<svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" opacity="0.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
	$("#drawer-cover").innerHTML = drawerCoverHtml;

	showDrawerMeta(currentMedia.path, currentMedia.name);
}

function updatePlayIcons() {
	const paused = audioPlayer.paused;
	const svg = paused ? `<polygon points="5 3 19 12 5 21 5 3"/>` : `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
	$("#play-icon").innerHTML = svg;
	$("#d-play-icon").innerHTML = svg;
}

function togglePlay() {
	if (!audioPlayer.src) return;
	audioPlayer.paused ? audioPlayer.play() : audioPlayer.pause();
	updatePlayIcons();
}

function highlightPlaying() {
	document.querySelectorAll(".track-row").forEach(r => {
		r.classList.toggle("playing", currentMedia && r.dataset.path === currentMedia.path);
	});
	renderDrawerQueue();
	if (viewingPlaylistIdx >= 0) renderDetailTracks();
}

// Time / progress
audioPlayer.addEventListener("timeupdate", () => {
	if (!audioPlayer.duration) return;
	const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
	$("#pb-progress-fill").style.width = pct + "%";
	$("#seek-bar").value = pct;
	$("#time-current").textContent = fmtTime(audioPlayer.currentTime);
	$("#time-total").textContent = fmtTime(audioPlayer.duration);
});
audioPlayer.addEventListener("play", updatePlayIcons);
audioPlayer.addEventListener("pause", updatePlayIcons);
audioPlayer.addEventListener("ended", () => playNextTrack());

$("#seek-bar").addEventListener("input", function () {
	if (!audioPlayer.duration) return;
	audioPlayer.currentTime = (this.value / 100) * audioPlayer.duration;
});
$("#pb-progress-bar").addEventListener("click", e => {
	if (!audioPlayer.duration) return;
	const r = e.currentTarget.getBoundingClientRect();
	audioPlayer.currentTime = ((e.clientX - r.left) / r.width) * audioPlayer.duration;
});

// ============================================
//  VOLUME
// ============================================
function setVolume(v) {
	volume = Math.max(0, Math.min(1, v));
	audioPlayer.volume = volume;
	const pct = Math.round(volume * 100);
	$("#volume-slider").value = pct;
	$("#drawer-volume").value = pct;
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
	shuffleOn = shuffle; $("#btn-shuffle-toggle").classList.toggle("active-toggle", shuffleOn);
	if (shuffleOn) buildShuffleOrder();
	doPlayTrack(shuffleOn ? shuffleOrder[0] : 0);
}
function buildShuffleOrder() {
	const pl = playlists[activePlaylistIdx]; if (!pl) return;
	shuffleOrder = pl.tracks.map((_, i) => i);
	for (let i = shuffleOrder.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[i]]; }
}
function toggleShuffle() {
	shuffleOn = !shuffleOn; $("#btn-shuffle-toggle").classList.toggle("active-toggle", shuffleOn);
	if (shuffleOn) buildShuffleOrder();
	toast(shuffleOn ? "Aléatoire activé" : "Lecture séquentielle", "info");
}

// ============================================
//  PLAYLISTS — storage
// ============================================
const PL_KEY = "ncmp_playlists";
function loadPlaylists() {
	try { playlists = JSON.parse(localStorage.getItem(PL_KEY) || "[]"); } catch { playlists = []; }
	if (playlists.length === 0) playlists.push({ name: "Ma playlist", tracks: [] });
	activePlaylistIdx = 0;
	importPlaylistsFromNC();
}
function savePlaylists() { localStorage.setItem(PL_KEY, JSON.stringify(playlists)); }

async function importPlaylistsFromNC() {
	try {
		const data = await api(`/files?path=${encodeURIComponent("/Playlists")}`);
		const m3us = (data.files || []).filter(f => f.name.endsWith(".m3u"));
		for (const f of m3us) {
			const plName = f.name.replace(/\.m3u$/, "");
			if (playlists.some(p => p.name === plName && p.imported)) continue;
			try {
				const res = await fetch(mediaUrl(f.path));
				const text = await res.text();
				const tracks = parseM3U(text);
				if (tracks.length > 0) playlists.push({ name: plName, tracks, imported: true });
			} catch { }
		}
		savePlaylists();
	} catch { }
	renderPlaylistGrid();
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
	pl.tracks.push({ path, name }); savePlaylists();
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
		pl.imported = true; savePlaylists();
		toast(`Sauvegardée sur Nextcloud`, "success");
	} catch (err) { toast("Erreur: " + err.message, "error"); }
}

// ============================================
//  PLAYLIST UI
// ============================================
function renderPlaylistGrid() {
	const grid = $("#playlist-grid");
	grid.innerHTML = playlists.map((pl, i) =>
		`<div class="pl-card" data-idx="${i}" style="animation-delay:${i * 30}ms">
			<div class="pl-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
			<div class="pl-card-name">${pl.name}</div>
			<div class="pl-card-count">${pl.tracks.length} piste${pl.tracks.length > 1 ? "s" : ""}</div>
			${pl.imported ? `<span class="pl-card-imported">Nextcloud</span>` : ""}
		</div>`
	).join("");
	grid.querySelectorAll(".pl-card").forEach(c => c.addEventListener("click", () => openPlaylistDetail(parseInt(c.dataset.idx))));
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
		return `<div class="dt-row${isPlaying ? " playing" : ""}" data-idx="${i}">
			<span class="dt-num">${i + 1}</span><span class="dt-name">${t.name}</span>
			<span class="dt-ext">${ext(t.name)}</span>
			<button class="dt-remove" data-idx="${i}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
		</div>`;
	}).join("");
	container.querySelectorAll(".dt-row").forEach(r => r.addEventListener("click", e => { if (e.target.closest(".dt-remove")) return; activePlaylistIdx = viewingPlaylistIdx; doPlayTrack(parseInt(r.dataset.idx)); }));
	container.querySelectorAll(".dt-remove").forEach(btn => btn.addEventListener("click", e => {
		e.stopPropagation(); const idx = parseInt(btn.dataset.idx);
		pl.tracks.splice(idx, 1);
		if (activePlaylistIdx === viewingPlaylistIdx) { if (playingTrackIdx === idx) playingTrackIdx = -1; else if (playingTrackIdx > idx) playingTrackIdx--; }
		savePlaylists(); $("#detail-meta").textContent = `${pl.tracks.length} piste${pl.tracks.length > 1 ? "s" : ""}`; renderDetailTracks();
	}));
}

// ============================================
//  DRAWER
// ============================================
function openDrawer() { $("#drawer").classList.remove("hidden"); }
function closeDrawer() { $("#drawer").classList.add("hidden"); }

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
	q.innerHTML = pl.tracks.map((t, i) => `<div class="dq-row${i === playingTrackIdx ? " playing" : ""}" data-idx="${i}"><span class="dq-num">${i + 1}</span><span class="dq-name">${t.name}</span></div>`).join("");
	q.querySelectorAll(".dq-row").forEach(r => r.addEventListener("click", () => doPlayTrack(parseInt(r.dataset.idx))));
}

// ============================================
//  VIEW SWITCHING
// ============================================
let currentView = "medias";
function switchView(view) {
	currentView = view;
	$$("#main-nav .nav-tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
	$("#view-medias").classList.toggle("hidden", view !== "medias");
	$("#view-playlists").classList.toggle("hidden", view !== "playlists");
	if (view === "playlists") { $("#playlist-detail").classList.add("hidden"); $("#playlist-grid").classList.remove("hidden"); renderPlaylistGrid(); }
}
$$("#main-nav .nav-tab").forEach(t => t.addEventListener("click", () => switchView(t.dataset.view)));

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
	playlists[viewingPlaylistIdx].name = this.value.trim() || "Sans nom"; savePlaylists();
});

document.addEventListener("keydown", e => {
	if (e.target.tagName === "INPUT") return;
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
checkAuth();
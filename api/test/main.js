const { Router } = require("express");
const { createClient } = require("webdav");
const router = Router();
const { express_values, nextcloud_values } = require("../../express_utils/env-values-dictionnary");

const nextcloud_url = nextcloud_values.url;
const client_id = nextcloud_values.client_id;
const client_secret = nextcloud_values.client_secret;

const domain = express_values.domain;
const api_route = express_values.public_route;

const redirect = `${domain}/${api_route}/test/callback`;

console.log("[Pastamedia] Redirect URI:", redirect);

// ============================================================
//  TOKEN STORAGE
//  Each entry: { access_token, refresh_token, expires_at, refreshPromise? }
// ============================================================

const userTokens = new Map();

const AUDIO_EXT = ["mp3", "flac", "ogg", "wav", "aac", "m4a", "opus", "wma"];
const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "gif"];

function getWebDAVClient(userId, accessToken) {
	return createClient(`${nextcloud_url}/remote.php/dav/files/${userId}/`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
}

// ============================================================
//  TOKEN REFRESH — with mutex to prevent concurrent refreshes
//
//  Nextcloud refresh tokens are SINGLE-USE. If two requests
//  trigger a refresh at the same time, the second one will fail
//  because the first already consumed the refresh_token.
//  We use a promise-based lock so concurrent callers wait for
//  the same refresh to complete.
// ============================================================

async function getValidToken(userId) {
	const token = userTokens.get(userId);
	if (!token) throw new Error("Utilisateur non connecté");

	// Still valid — return directly (5min margin instead of 1min)
	if (Date.now() < token.expires_at - 300_000) {
		return token.access_token;
	}

	// A refresh is already in-flight — wait for it
	if (token.refreshPromise) {
		console.log(`[Token] Waiting for in-flight refresh for ${userId}`);
		return token.refreshPromise;
	}

	// Start a new refresh — store the promise so others can await it
	console.log(`[Token] Refreshing token for ${userId}`);
	token.refreshPromise = doRefresh(userId, token)
		.finally(() => {
			// Clear the lock regardless of success/failure
			const t = userTokens.get(userId);
			if (t) t.refreshPromise = null;
		});

	return token.refreshPromise;
}

async function doRefresh(userId, token) {
	try {
		const res = await fetch(`${nextcloud_url}/index.php/apps/oauth2/api/v1/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: token.refresh_token,
				client_id,
				client_secret,
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			console.error(`[Token] Refresh HTTP ${res.status}:`, text);
			throw new Error(`Refresh failed: HTTP ${res.status}`);
		}

		const newTokens = await res.json();
		if (!newTokens.access_token) {
			console.error("[Token] Refresh response missing access_token:", newTokens);
			throw new Error("Refresh response invalide");
		}

		console.log(`[Token] Refresh success for ${userId}, expires in ${newTokens.expires_in}s`);

		userTokens.set(userId, {
			access_token: newTokens.access_token,
			refresh_token: newTokens.refresh_token,
			expires_at: Date.now() + newTokens.expires_in * 1000,
			refreshPromise: null,
		});

		return newTokens.access_token;
	} catch (err) {
		// On failure, invalidate the session so user re-authenticates
		console.error(`[Token] Refresh failed for ${userId}:`, err.message);
		userTokens.delete(userId);
		throw new Error("Session expirée, reconnexion nécessaire");
	}
}

// ============================================================
//  AUTH MIDDLEWARE
// ============================================================

async function authMiddleware(req, res, next) {
	const userId = req.headers["x-nc-user"] || req.query.userId;
	if (!userId || !userTokens.has(userId)) {
		return res.status(401).json({ error: "Non authentifié", login: `/${api_route}/test/login` });
	}
	try {
		const accessToken = await getValidToken(userId);
		req.ncUser = userId;
		req.ncToken = accessToken;
		req.webdav = getWebDAVClient(userId, accessToken);
		next();
	} catch (err) {
		res.status(401).json({ error: err.message });
	}
}

// ============================================================
//  AUTH ROUTES
// ============================================================

router.get("/login", (req, res) => {
	const authUrl =
		`${nextcloud_url}/index.php/apps/oauth2/authorize?` +
		`response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent(redirect)}`;
	res.redirect(authUrl);
});

router.get("/callback", async (req, res) => {
	const { code } = req.query;
	if (!code) return res.redirect(`${domain}?error=missing_code`);

	try {
		const tokenRes = await fetch(`${nextcloud_url}/index.php/apps/oauth2/api/v1/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirect,
				client_id,
				client_secret,
			}),
		});

		const tokens = await tokenRes.json();
		if (!tokens.access_token) {
			console.error("[Auth] Callback token exchange failed:", tokens);
			return res.redirect(`${domain}?error=auth_failed`);
		}

		const userRes = await fetch(`${nextcloud_url}/ocs/v2.php/cloud/user`, {
			headers: {
				Authorization: `Bearer ${tokens.access_token}`,
				"OCS-APIRequest": "true",
				Accept: "application/json",
			},
		});
		const userData = await userRes.json();
		const userId = userData.ocs?.data?.id || "unknown";

		console.log(`[Auth] User ${userId} authenticated, token expires in ${tokens.expires_in}s`);

		userTokens.set(userId, {
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			expires_at: Date.now() + tokens.expires_in * 1000,
			refreshPromise: null,
		});

		res.redirect(`${domain}?userId=${encodeURIComponent(userId)}`);
	} catch (err) {
		console.error("[Auth] Callback error:", err);
		res.redirect(`${domain}?error=server_error`);
	}
});

router.get("/status", (req, res) => {
	const userId = req.headers["x-nc-user"] || req.query.userId;
	if (!userId || !userTokens.has(userId)) return res.json({ connected: false });
	const token = userTokens.get(userId);
	res.json({
		connected: true,
		userId,
		expiresAt: new Date(token.expires_at).toISOString(),
		expiresIn: Math.max(0, Math.round((token.expires_at - Date.now()) / 1000)),
	});
});

// ============================================================
//  FILE ROUTES
// ============================================================

router.get("/files", authMiddleware, async (req, res) => {
	const dirPath = req.query.path || "/";
	try {
		const contents = await req.webdav.getDirectoryContents(dirPath);
		const files = contents.map((item) => ({
			name: item.basename,
			path: item.filename,
			type: item.type,
			size: item.size,
			mime: item.mime,
			lastModified: item.lastmod,
		}));
		res.json({ path: dirPath, count: files.length, files });
	} catch (err) {
		res.status(500).json({ error: "Impossible de lister les fichiers", details: err.message });
	}
});

// ============================================================
//  RECURSIVE SCAN — find all audio files + covers
// ============================================================

router.get("/files/scan", authMiddleware, async (req, res) => {
	const rootPath = req.query.path || "/";
	const maxDepth = parseInt(req.query.depth) || 10;
	const audioFiles = [];
	const coverMap = {};

	async function scanDir(dirPath, depth) {
		if (depth > maxDepth) return;
		try {
			const contents = await req.webdav.getDirectoryContents(dirPath);
			const subdirs = [];

			for (const item of contents) {
				if (item.type === "directory") {
					subdirs.push(item.filename);
					continue;
				}

				const fileExt = item.basename.split(".").pop().toLowerCase();
				const parentDir = item.filename.substring(0, item.filename.lastIndexOf("/"));

				if (IMAGE_EXT.includes(fileExt)) {
					const lowerName = item.basename.toLowerCase();
					if (
						lowerName.startsWith("cover") ||
						lowerName.startsWith("folder") ||
						lowerName.startsWith("album") ||
						lowerName.startsWith("front") ||
						lowerName === "thumb.jpg" ||
						lowerName === "thumb.png"
					) {
						coverMap[parentDir] = item.filename;
					}
				}

				if (AUDIO_EXT.includes(fileExt)) {
					audioFiles.push({
						name: item.basename,
						path: item.filename,
						size: item.size,
						mime: item.mime,
						lastModified: item.lastmod,
						dir: parentDir,
					});
				}
			}

			const batchSize = 5;
			for (let i = 0; i < subdirs.length; i += batchSize) {
				const batch = subdirs.slice(i, i + batchSize);
				await Promise.all(batch.map((d) => scanDir(d, depth + 1)));
			}
		} catch (err) {
			console.error(`[Scan] Error in ${dirPath}:`, err.message);
		}
	}

	try {
		await scanDir(rootPath, 0);
		const result = audioFiles.map((f) => ({
			...f,
			cover: coverMap[f.dir] || null,
		}));
		res.json({ count: result.length, files: result, covers: coverMap });
	} catch (err) {
		res.status(500).json({ error: "Erreur de scan", details: err.message });
	}
});

// ============================================================
//  ÉTIQUETTES AUDIO (ID3, Vorbis, MP4)
//  music-metadata est chargé à la demande via import() : le paquet
//  est distribué en ESM pur à partir de la version 10, ce que require
//  ne sait pas charger.
//    npm install music-metadata
// ============================================================

let musicMetadataPromise = null;
function loadMusicMetadata() {
	if (!musicMetadataPromise) musicMetadataPromise = import("music-metadata");
	return musicMetadataPromise;
}

const tagCache = new Map();        // clé -> étiquettes (léger, on en garde beaucoup)
const pictureCache = new Map();    // clé -> pochette intégrée (lourd, on en garde peu)
const TAG_CACHE_MAX = 500;
const PICTURE_CACHE_MAX = 30;

function capped(map, max) {
	while (map.size > max) map.delete(map.keys().next().value);
}

// La clé inclut l'etag : un fichier réétiqueté côté Nextcloud invalide
// automatiquement l'entrée.
function tagKey(userId, filePath, stat) {
	return `${userId}:${filePath}:${stat.etag || stat.lastmod || stat.size || ""}`;
}

async function readTags(webdav, userId, filePath, stat) {
	const key = tagKey(userId, filePath, stat);
	if (tagCache.has(key)) return { key, tags: tagCache.get(key) };

	const mm = await loadMusicMetadata();
	const stream = webdav.createReadStream(filePath);
	let meta;
	try {
		// duration: false évite de lire le fichier entier quand la durée
		// n'est pas inscrite dans l'en-tête. Le flux est coupé dès que
		// les étiquettes sont analysées.
		meta = await mm.parseStream(
			stream,
			{ mimeType: stat.mime || undefined, size: Number(stat.size) || undefined },
			{ duration: false, skipCovers: false }
		);
	} finally {
		stream.destroy();
	}

	const c = meta.common || {};
	const picture = Array.isArray(c.picture) && c.picture.length ? c.picture[0] : null;

	const tags = {
		title: c.title || null,
		artist: c.artist || c.albumartist || null,
		albumartist: c.albumartist || null,
		album: c.album || null,
		track: c.track?.no ?? null,
		disk: c.disk?.no ?? null,
		year: c.year || null,
		genre: Array.isArray(c.genre) && c.genre.length ? c.genre[0] : null,
		duration: meta.format?.duration || null,
		hasPicture: !!picture,
	};

	tagCache.set(key, tags);
	capped(tagCache, TAG_CACHE_MAX);

	if (picture) {
		pictureCache.set(key, {
			data: Buffer.from(picture.data),
			format: picture.format || "image/jpeg",
		});
		capped(pictureCache, PICTURE_CACHE_MAX);
	}

	return { key, tags };
}

router.get("/files/tags", authMiddleware, async (req, res) => {
	const filePath = req.query.path;
	if (!filePath) return res.status(400).json({ error: "Paramètre path requis" });
	try {
		const stat = await cachedStat(req.webdav, req.ncUser, filePath);
		const { tags } = await readTags(req.webdav, req.ncUser, filePath, stat);
		res.set("Cache-Control", "private, max-age=3600");
		res.json({ path: filePath, ...tags });
	} catch (err) {
		// Fichier sans étiquette ou format non reconnu : ce n'est pas une
		// erreur, le client se rabat sur le nom du fichier.
		console.warn(`[Tags] Lecture impossible pour ${filePath}:`, err.message);
		res.json({ path: filePath, title: null, artist: null, album: null, hasPicture: false });
	}
});

router.get("/files/cover", authMiddleware, async (req, res) => {
	const filePath = req.query.path;
	if (!filePath) return res.status(400).json({ error: "Paramètre path requis" });
	try {
		const stat = await cachedStat(req.webdav, req.ncUser, filePath);
		let key = tagKey(req.ncUser, filePath, stat);
		if (!pictureCache.has(key)) ({ key } = await readTags(req.webdav, req.ncUser, filePath, stat));

		const picture = pictureCache.get(key);
		if (!picture) return res.status(404).json({ error: "Aucune pochette intégrée" });

		const etag = `"cover-${Buffer.byteLength(key)}-${picture.data.length}"`;
		if (req.headers["if-none-match"] === etag) return res.status(304).end();

		res.set("Content-Type", picture.format);
		res.set("Content-Length", String(picture.data.length));
		res.set("Cache-Control", "private, max-age=86400");
		res.set("ETag", etag);
		res.end(picture.data);
	} catch (err) {
		res.status(404).json({ error: "Aucune pochette intégrée", details: err.message });
	}
});

router.get("/files/stat", authMiddleware, async (req, res) => {
	const filePath = req.query.path;
	if (!filePath) return res.status(400).json({ error: "Paramètre path requis" });
	try {
		const stat = await req.webdav.stat(filePath);
		res.json({
			name: stat.basename,
			path: stat.filename,
			type: stat.type,
			size: stat.size,
			mime: stat.mime,
			lastModified: stat.lastmod,
			etag: stat.etag,
		});
	} catch (err) {
		res.status(404).json({ error: "Fichier non trouvé", details: err.message });
	}
});

// ============================================================
//  CACHE DE MÉTADONNÉES
//  Chrome émet plusieurs requêtes Range par piste. Sans ce cache,
//  chacune déclenche un PROPFIND WebDAV supplémentaire vers
//  Nextcloud avant même de commencer à transmettre le moindre octet.
// ============================================================

const statCache = new Map();
const STAT_TTL = 30_000;

async function cachedStat(webdav, userId, filePath) {
	const key = `${userId}:${filePath}`;
	const hit = statCache.get(key);
	if (hit && Date.now() < hit.expires) return hit.stat;
	const stat = await webdav.stat(filePath);
	statCache.set(key, { stat, expires: Date.now() + STAT_TTL });
	return stat;
}

function invalidateStat(userId, filePath) {
	statCache.delete(`${userId}:${filePath}`);
}

// Purge périodique pour éviter que la Map ne grossisse indéfiniment
setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of statCache) if (now >= entry.expires) statCache.delete(key);
}, STAT_TTL).unref?.();

// ============================================================
//  PARSING DU RANGE (RFC 7233, une seule plage)
//  Renvoie { start, end } ou null si l'en-tête est absent ou
//  invalide, "unsatisfiable" si la plage sort du fichier.
// ============================================================

function parseRange(header, size) {
	if (!header || size <= 0) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;

	let start, end;
	if (match[1] === "") {
		// Forme suffixe : bytes=-500 (les 500 derniers octets)
		const suffix = parseInt(match[2], 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = parseInt(match[1], 10);
		end = match[2] === "" ? size - 1 : parseInt(match[2], 10);
	}

	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	if (start >= size || start > end) return "unsatisfiable";
	return { start, end: Math.min(end, size - 1) };
}

router.get("/files/download", authMiddleware, async (req, res) => {
	const filePath = req.query.path;
	if (!filePath) return res.status(400).json({ error: "Paramètre path requis" });

	let stat;
	try {
		stat = await cachedStat(req.webdav, req.ncUser, filePath);
	} catch (err) {
		return res.status(404).json({ error: "Fichier non trouvé", details: err.message });
	}

	const size = Number(stat.size) || 0;
	const etag = stat.etag ? `"${String(stat.etag).replace(/"/g, "")}"` : null;

	res.set("Content-Type", stat.mime || "application/octet-stream");
	// RFC 5987 : encodage du nom pour l'Unicode (☆, 灰, etc.)
	const safeAscii = stat.basename.replace(/[^\x20-\x7E]/g, "_");
	const encoded = encodeURIComponent(stat.basename).replace(/'/g, "%27");
	res.set("Content-Disposition", `inline; filename="${safeAscii}"; filename*=UTF-8''${encoded}`);
	res.set("Accept-Ranges", "bytes");

	// Sans ces en-têtes, le navigateur ne conserve rien et retélécharge
	// la piste entière à chaque lecture ou reprise.
	res.set("Cache-Control", "private, max-age=86400");
	if (etag) res.set("ETag", etag);
	if (stat.lastmod) {
		const d = new Date(stat.lastmod);
		if (!isNaN(d)) res.set("Last-Modified", d.toUTCString());
	}

	// Revalidation : rien à renvoyer si le client a déjà la bonne version
	const ifNoneMatch = req.headers["if-none-match"];
	if (etag && ifNoneMatch && ifNoneMatch.split(",").some(v => v.trim() === etag)) {
		return res.status(304).end();
	}

	// If-Range : si la version a changé, la plage demandée n'a plus de
	// sens, on repart du fichier complet.
	const ifRange = req.headers["if-range"];
	const rangeStillValid = !ifRange || (etag && ifRange.trim() === etag);
	const range = rangeStillValid ? parseRange(req.headers.range, size) : null;

	if (range === "unsatisfiable") {
		return res.status(416).set("Content-Range", `bytes */${size}`).end();
	}

	let stream;
	try {
		if (range) {
			res.status(206);
			res.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
			res.set("Content-Length", String(range.end - range.start + 1));
			stream = req.webdav.createReadStream(filePath, { range: { start: range.start, end: range.end } });
		} else {
			res.status(200);
			if (size) res.set("Content-Length", String(size));
			stream = req.webdav.createReadStream(filePath);
		}
	} catch (err) {
		return res.status(500).json({ error: "Lecture impossible", details: err.message });
	}

	// Une coupure réseau côté mobile laissait la réponse et le flux WebDAV
	// ouverts indéfiniment.
	stream.on("error", (err) => {
		console.error(`[Download] Flux interrompu pour ${filePath}:`, err.message);
		if (!res.headersSent) res.status(502).json({ error: "Lecture interrompue" });
		else res.destroy(err);
	});
	res.on("close", () => stream.destroy());

	stream.pipe(res);
});

router.put("/files/upload", authMiddleware, async (req, res) => {
	const filePath = req.query.path;
	if (!filePath) return res.status(400).json({ error: "Paramètre path requis" });
	try {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const buffer = Buffer.concat(chunks);
		await req.webdav.putFileContents(filePath, buffer, { overwrite: req.query.overwrite !== "false" });
		invalidateStat(req.ncUser, filePath);
		res.json({ success: true, path: filePath });
	} catch (err) {
		res.status(500).json({ error: "Échec upload", details: err.message });
	}
});

router.post("/files/mkdir", authMiddleware, async (req, res) => {
	const { path } = req.body;
	if (!path) return res.status(400).json({ error: "Paramètre path requis" });
	try {
		await req.webdav.createDirectory(path);
		res.json({ success: true, path });
	} catch (err) {
		res.status(500).json({ error: "Échec création dossier", details: err.message });
	}
});

router.delete("/files", authMiddleware, async (req, res) => {
	const filePath = req.query.path;
	if (!filePath) return res.status(400).json({ error: "Paramètre path requis" });
	try {
		await req.webdav.deleteFile(filePath);
		invalidateStat(req.ncUser, filePath);
		res.json({ success: true, deleted: filePath });
	} catch (err) {
		res.status(500).json({ error: "Échec suppression", details: err.message });
	}
});

router.patch("/files/move", authMiddleware, async (req, res) => {
	const { from, to } = req.body;
	if (!from || !to) return res.status(400).json({ error: "Paramètres from et to requis" });
	try {
		await req.webdav.moveFile(from, to);
		invalidateStat(req.ncUser, from);
		invalidateStat(req.ncUser, to);
		res.json({ success: true, from, to });
	} catch (err) {
		res.status(500).json({ error: "Échec déplacement", details: err.message });
	}
});

router.post("/files/copy", authMiddleware, async (req, res) => {
	const { from, to } = req.body;
	if (!from || !to) return res.status(400).json({ error: "Paramètres from et to requis" });
	try {
		await req.webdav.copyFile(from, to);
		invalidateStat(req.ncUser, to);
		res.json({ success: true, from, to });
	} catch (err) {
		res.status(500).json({ error: "Échec copie", details: err.message });
	}
});

module.exports = router;
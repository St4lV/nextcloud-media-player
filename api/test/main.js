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

router.get("/files/download", authMiddleware, async (req, res) => {
	const filePath = req.query.path;
	if (!filePath) return res.status(400).json({ error: "Paramètre path requis" });
	try {
		const stat = await req.webdav.stat(filePath);
		const stream = req.webdav.createReadStream(filePath);
		res.set("Content-Type", stat.mime || "application/octet-stream");
		// RFC 5987: encode filename for Unicode support (☆, 灰, etc.)
		const safeAscii = stat.basename.replace(/[^\x20-\x7E]/g, "_");
		const encoded = encodeURIComponent(stat.basename).replace(/'/g, "%27");
		res.set("Content-Disposition", `inline; filename="${safeAscii}"; filename*=UTF-8''${encoded}`);
		if (stat.size) res.set("Content-Length", String(stat.size));
		res.set("Accept-Ranges", "bytes");
		stream.pipe(res);
	} catch (err) {
		res.status(404).json({ error: "Fichier non trouvé", details: err.message });
	}
});

router.put("/files/upload", authMiddleware, async (req, res) => {
	const filePath = req.query.path;
	if (!filePath) return res.status(400).json({ error: "Paramètre path requis" });
	try {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const buffer = Buffer.concat(chunks);
		await req.webdav.putFileContents(filePath, buffer, { overwrite: req.query.overwrite !== "false" });
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
		res.json({ success: true, from, to });
	} catch (err) {
		res.status(500).json({ error: "Échec copie", details: err.message });
	}
});

module.exports = router;
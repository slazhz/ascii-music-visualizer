'use strict';
/*
 * ASCII Music Visualizer – local helper.
 * Zero dependencies, Node 18+. Listens on 127.0.0.1 only.
 *
 *   GET  /            status page (+ Spotify login link if configured)
 *   GET  /events      Server-Sent Events stream of the now-playing state (the wallpaper uses this)
 *   GET  /state       the same state as JSON
 *   POST /update      now-playing updates from the Spicetify bridge
 *   GET  /video/:id   the track's Canvas MP4, cached on disk, with CORS + Range support
 *   GET  /cover/:id   the track's high-res cover, cached on disk, with CORS
 *   GET  /login       optional Spotify Web API login (see README)
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { lookupCanvas, CanvasAuthError } = require('./lib/canvas');
const { WebApi } = require('./lib/webapi');
const { Ffmpeg } = require('./lib/ffmpeg');
const lookup = require('./lib/lookup');
const crypto = require('crypto');

// ---------- config ----------
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const VIDEO_DIR = path.join(DATA, 'video');
const FONT_DIR = path.join(DATA, 'fonts');
const COVER_DIR = path.join(DATA, 'cover');
for (const d of [DATA, VIDEO_DIR, COVER_DIR, FONT_DIR]) fs.mkdirSync(d, { recursive: true });

let config = {
	port: 7777, spotifyClientId: '', pollSeconds: 3, canvasHash: '', maxCacheMB: 500, ffmpegPath: '', autoDownloadFfmpeg: true, zeroSetup: true,
	// Spotify Canvas videos use Spotify's private, undocumented API (unofficial; may break or be against Spotify's terms).
	// On by default; set "enableCanvases": false in config.json to turn it off.
	enableCanvases: true,
	extraOrigins: [] // extra web origins allowed to talk to the helper (normally not needed)
};
try { Object.assign(config, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))); }
catch (e) { if (e.code !== 'ENOENT') console.error('config.json is not valid JSON:', e.message); }
const PORT = Number(process.env.PORT || config.port) || 7777;
const CANVASES = config.enableCanvases !== false;

function log(...a) { console.log(new Date().toLocaleTimeString(), ...a); }
const ffmpeg = new Ffmpeg({ root: ROOT, configPath: config.ffmpegPath, autoDownload: config.autoDownloadFfmpeg, log });
let wallpaperDiag = null; // what the wallpaper reported it can play
const WALLPAPER_VERSION = 14;

// ---------- canvas lookup cache ----------
const CACHE_FILE = path.join(DATA, 'canvas-cache.json');
let canvasCache = {};
try { canvasCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { /* first run */ }
let cacheSaveTimer = null;
function saveCacheSoon() {
	clearTimeout(cacheSaveTimer);
	cacheSaveTimer = setTimeout(() => fs.writeFile(CACHE_FILE, JSON.stringify(canvasCache), () => {}), 1000);
}
const DAY = 86400000;
function cachedCanvas(id) {
	const e = canvasCache[id];
	if (!e) return undefined;
	const maxAge = e.url ? 30 * DAY : 3 * DAY; // re-check "no canvas" tracks after a few days
	if (Date.now() - e.t > maxAge) return undefined;
	return e.url; // string or null
}
function rememberCanvas(id, url) { canvasCache[id] = { url, t: Date.now() }; saveCacheSoon(); }

// ---------- state ----------
const TRACK_ID = /^[A-Za-z0-9]{22}$/;
let state = {
	trackId: null, title: '', artist: '', album: '',
	coverUrl: null, hasCover: false,
	canvasUrl: null, hasCanvas: false, canvasStatus: 'idle', // idle | looking | found | none | error
	playing: false, source: null, updatedAt: Date.now(),
	album: null // { uri, name, year, tracks: [{ n, d, title, ms, uri }] } from the bridge
};
let bridgeToken = null;       // web-player token sent by the Spicetify bridge (fallback lookups)
let lastBridgeAt = 0;
const clients = new Set();

function publicState() { return Object.assign({}, state, { canvasUrl: undefined, coverUrl: undefined }); }
function broadcast() {
	state.updatedAt = Date.now();
	const msg = 'data: ' + JSON.stringify(publicState()) + '\n\n';
	for (const res of clients) res.write(msg);
}

function cleanAlbum(a) {
	if (!a || typeof a !== 'object' || typeof a.uri !== 'string' || !/^(spotify:album:[A-Za-z0-9]{22}|deezer:album:\d+|itunes:album:\d+)$/.test(a.uri) || !Array.isArray(a.tracks)) return null;
	const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);
	const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
	return {
		uri: a.uri,
		name: str(a.name, 200),
		year: str(a.year, 4),
		tracks: a.tracks.slice(0, 200).map(t => ({
			n: num(t && t.n), d: num(t && t.d), ms: num(t && t.ms), title: str(t && t.title, 200),
			uri: t && typeof t.uri === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(t.uri) ? t.uri : ''
		}))
	};
}

function normalizeImage(u) {
	if (!u || typeof u !== 'string') return null;
	if (u.startsWith('spotify:image:')) u = 'https://i.scdn.co/image/' + u.slice('spotify:image:'.length);
	if (/^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/.test(u)) return u;
	if (/^https:\/\/(e-)?cdns?-images\.dzcdn\.net\/[\w\/.\-]+$/.test(u)) return u;
	if (/^https:\/\/is\d-ssl\.mzstatic\.com\/[\w\/.\-]+$/.test(u)) return u;
	return null;
}
function validCanvasUrl(u) {
	return typeof u === 'string' && /^https:\/\/canvaz\.scdn\.co\/[^\s]+\.mp4(\?[^\s]*)?$/.test(u);
}

async function setTrack(info, source) {
	const changed = info.trackId !== state.trackId;
	state.source = source;
	state.playing = info.playing !== false;
	const album = cleanAlbum(info.album);
	if (!changed) {
		if (album) state.album = album;
		// Same track: maybe the bridge now knows the canvas.
		if (info.trackId && !state.coverUrl && normalizeImage(info.coverUrl)) {
			state.coverUrl = normalizeImage(info.coverUrl); state.hasCover = true;
		}
		if (info.trackId && info.canvasUrl !== undefined && (state.canvasStatus === 'idle' || state.canvasStatus === 'looking' || state.canvasStatus === 'error')) applyCanvas(info.trackId, info.canvasUrl);
		else if (info.trackId && info.token && (state.canvasStatus === 'idle' || state.canvasStatus === 'error')) {
			state.canvasStatus = 'looking';
			findCanvas(info.trackId, info.token);
		}
		broadcast();
		return;
	}
	state.trackId = info.trackId;
	state.title = info.title || '';
	state.artist = info.artist || '';
	state.albumName = info.albumName || (typeof info.album === 'string' ? info.album : (info.album && info.album.name) || '');
	state.coverUrl = normalizeImage(info.coverUrl);
	state.album = album;
	if (!state.album && info.trackId) albumFallback(info.trackId);
	state.hasCover = !!state.coverUrl;
	state.canvasUrl = null; state.hasCanvas = false; state.canvasStatus = 'idle';
	if (!info.trackId) { broadcast(); return; }
	log(`▶ ${state.artist} – ${state.title} (${source})`);

	if (info.canvasUrl !== undefined) { applyCanvas(info.trackId, info.canvasUrl); broadcast(); return; }
	const cached = cachedCanvas(info.trackId);
	if (cached !== undefined) { applyCanvas(info.trackId, cached, true); broadcast(); return; }
	state.canvasStatus = 'looking';
	broadcast();
	findCanvas(info.trackId, info.token);
}

function applyCanvas(trackId, url, fromCache) {
	if (trackId !== state.trackId) return;
	if (!CANVASES) {
		state.canvasUrl = null; state.hasCanvas = false; state.canvasStatus = 'off';
		if (state.coverUrl) ensureFile('cover', trackId, state.coverUrl).catch(() => {});
		return;
	}
	if (url && !validCanvasUrl(url)) url = null;
	state.canvasUrl = url || null;
	state.hasCanvas = !!url;
	state.canvasStatus = url ? 'found' : 'none';
	if (!fromCache) rememberCanvas(trackId, url || null);
	log(url ? '  canvas found' : '  no canvas for this track');
	if (url) ensureFile('video', trackId, url).then(() => ensureWebm(trackId)).catch(e => log('  canvas download/convert failed:', e.message));
	if (state.coverUrl) ensureFile('cover', trackId, state.coverUrl).catch(() => {});
}

async function findCanvas(trackId, token) {
	if (!CANVASES) { if (trackId === state.trackId) { state.canvasStatus = 'off'; broadcast(); } return; }
	const tokens = [];
	if (token) tokens.push(['bridge', token]);
	if (bridgeToken && bridgeToken !== token) tokens.push(['bridge', bridgeToken]);
	if (webapi.loggedIn) { try { tokens.push(['web api', await webapi.accessToken()]); } catch (e) { /* ignore */ } }
	if (!tokens.length) {
		if (trackId === state.trackId) { state.canvasStatus = 'error'; broadcast(); }
		log('  no token available for canvas lookup (install the Spicetify bridge, see README)');
		return;
	}
	for (const [name, tok] of tokens) {
		try {
			const url = await lookupCanvas(trackId, tok, config.canvasHash);
			applyCanvas(trackId, url);
			broadcast();
			return;
		} catch (e) {
			log(`  canvas lookup with ${name} token failed: ${e.message}`);
			if (!(e instanceof CanvasAuthError)) break;
		}
	}
	if (trackId === state.trackId) { state.canvasStatus = 'error'; broadcast(); }
}

// ---------- modern Thai fonts (free, from the Google Fonts repository), cached on first use ----------
const GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl/';
const FONTS = {
	'noto': GF + 'notosansthai/NotoSansThai%5Bwdth,wght%5D.ttf',
	'anuphan': GF + 'anuphan/Anuphan%5Bwght%5D.ttf',
	'plex-400': GF + 'ibmplexsansthai/IBMPlexSansThai-Regular.ttf',
	'plex-700': GF + 'ibmplexsansthai/IBMPlexSansThai-Bold.ttf',
	'kanit-400': GF + 'kanit/Kanit-Regular.ttf',
	'kanit-700': GF + 'kanit/Kanit-SemiBold.ttf',
	'prompt-400': GF + 'prompt/Prompt-Regular.ttf',
	'prompt-700': GF + 'prompt/Prompt-SemiBold.ttf'
};
const fontJobs = new Map();
async function ensureFont(key) {
	const p = path.join(FONT_DIR, key + '.ttf');
	try { await fsp.access(p); return p; } catch (e) { /* download */ }
	if (fontJobs.has(key)) return fontJobs.get(key);
	const job = (async () => {
		const res = await fetch(FONTS[key]);
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length < 10000) throw new Error('font download too small');
		await fsp.writeFile(p + '.part', buf);
		await fsp.rename(p + '.part', p);
		log('  downloaded font: ' + key);
		return p;
	})();
	fontJobs.set(key, job);
	try { return await job; } finally { fontJobs.delete(key); }
}

// ---------- tracklist fallback: if the bridge / Web API didn't send one, look it up publicly ----------
async function albumFallback(id) {
	await new Promise(r => setTimeout(r, 2500)); // give the bridge a moment first
	if (id !== state.trackId || state.album || !state.title) return;
	try {
		const res = await lookup.findAlbum({ title: state.title, artist: state.artist, album: state.albumName });
		if (id !== state.trackId || state.album) return;
		if (res) {
			state.album = cleanAlbum(res.album);
			zeroInfo = { status: 'ok', detail: 'album from ' + res.source };
			log(`  tracklist from ${res.source}: "${res.album.name}"`);
			broadcast();
		} else zeroInfo = { status: 'not found', detail: 'no matching album on Deezer or iTunes' };
	} catch (e) { zeroInfo = { status: 'error', detail: e.message }; }
}

// ---------- no-setup mode: song info from the wallpaper (Windows media controls) ----------
let zeroInfo = { status: 'idle', detail: '' };
function keyFor(title, artist) {
	// A stable 22-character id for a song we only know by name.
	const h = crypto.createHash('sha1').update(lookup.norm(artist) + '|' + lookup.norm(title)).digest('base64').replace(/[^A-Za-z0-9]/g, '');
	return (h + 'AAAAAAAAAAAAAAAAAAAAAA').slice(0, 22);
}
function zeroSetupActive() {
	return config.zeroSetup !== false && Date.now() - lastBridgeAt > 15000 && !webapi.loggedIn;
}
async function zeroSetupTrack(np) {
	// Never replace richer info (bridge / Web API) about the same song.
	if (state.source && state.source !== 'windows' && lookup.norm(state.title) === lookup.norm(np.title)) return;
	const id = keyFor(np.title, np.artist);
	if (id === state.trackId) { if (state.playing !== np.playing) { state.playing = np.playing; broadcast(); } return; }
	state.source = 'windows';
	state.trackId = id; state.title = np.title; state.artist = np.artist; state.album = null; state.albumName = np.album || '';
	state.coverUrl = null; state.hasCover = false; state.playing = np.playing;
	state.canvasUrl = null; state.hasCanvas = false; state.canvasStatus = CANVASES ? 'needs Spicetify' : 'off';
	log(`▶ ${np.artist} – ${np.title} (from Windows)`);
	broadcast();
	try {
		const res = await lookup.findAlbum(np);
		if (id !== state.trackId) return;
		if (res) {
			state.album = cleanAlbum(res.album);
			state.coverUrl = normalizeImage(res.coverUrl); state.hasCover = !!state.coverUrl;
			zeroInfo = { status: 'ok', detail: 'album from ' + res.source };
			log(`  album "${res.album.name}" from ${res.source}`);
		} else { zeroInfo = { status: 'not found', detail: 'no matching album on Deezer or iTunes' }; log('  album not found'); }
		broadcast();
	} catch (e) { zeroInfo = { status: 'error', detail: e.message }; log('  album lookup failed: ' + e.message); }
}

// ---------- file cache (video + cover) ----------
const downloads = new Map();
function filePath(kind, id) {
	if (kind === 'webm') return path.join(VIDEO_DIR, id + '.webm');
	return path.join(kind === 'video' ? VIDEO_DIR : COVER_DIR, id + (kind === 'video' ? '.mp4' : '.jpg'));
}

const converts = new Map();
async function ensureWebm(id) {
	const out = filePath('webm', id);
	try { await fsp.access(out); return out; } catch (e) { /* convert */ }
	if (converts.has(id)) return converts.get(id);
	const job = (async () => {
		let mp4 = filePath('video', id);
		try { await fsp.access(mp4); } catch (e) {
			const u = urlFor('video', id);
			if (!u) throw new Error('no canvas for this track');
			mp4 = await ensureFile('video', id, u);
		}
		const t = Date.now();
		await ffmpeg.toWebm(mp4, out);
		log(`  converted canvas to WebM in ${((Date.now() - t) / 1000).toFixed(1)}s`);
		return out;
	})();
	converts.set(id, job);
	try { return await job; } finally { converts.delete(id); }
}

async function ensureFile(kind, id, url) {
	const p = filePath(kind, id);
	try { await fsp.access(p); return p; } catch (e) { /* download */ }
	const key = kind + ':' + id;
	if (downloads.has(key)) return downloads.get(key);
	const job = (async () => {
		const res = await fetch(url);
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const buf = Buffer.from(await res.arrayBuffer());
		const tmp = p + '.part';
		await fsp.writeFile(tmp, buf);
		await fsp.rename(tmp, p);
		return p;
	})();
	downloads.set(key, job);
	try { return await job; } finally { downloads.delete(key); }
}

async function pruneCache() {
	const limit = (Number(config.maxCacheMB) || 500) * 1024 * 1024;
	const files = [];
	for (const dir of [VIDEO_DIR, COVER_DIR]) {
		for (const name of await fsp.readdir(dir)) {
			const p = path.join(dir, name);
			try { const st = await fsp.stat(p); files.push({ p, size: st.size, t: st.mtimeMs }); } catch (e) { /* gone */ }
		}
	}
	let total = files.reduce((s, f) => s + f.size, 0);
	files.sort((a, b) => a.t - b.t);
	for (const f of files) {
		if (total <= limit) break;
		await fsp.unlink(f.p).catch(() => {});
		total -= f.size;
	}
}

function urlFor(kind, id) {
	if (kind === 'video') {
		if (id === state.trackId && state.canvasUrl) return state.canvasUrl;
		const c = canvasCache[id];
		return c && c.url;
	}
	if (id === state.trackId) return state.coverUrl;
	return null;
}

async function serveFile(req, res, kind, id, fmt) {
	if (!TRACK_ID.test(id)) return send(res, 400, 'bad id');
	if (kind === 'video' && fmt === 'webm') {
		let w;
		try { w = await ensureWebm(id); } catch (e) { log('  WebM not available: ' + e.message); return send(res, 503, 'webm unavailable'); }
		return streamFile(req, res, w, 'video/webm');
	}
	let p = filePath(kind, id);
	try { await fsp.access(p); }
	catch (e) {
		const u = urlFor(kind, id);
		if (!u) return send(res, 404, 'not found');
		try { p = await ensureFile(kind, id, u); } catch (err) { return send(res, 502, 'download failed'); }
	}
	return streamFile(req, res, p, kind === 'video' ? 'video/mp4' : 'image/jpeg');
}

async function streamFile(req, res, p, type) {
	const st = await fsp.stat(p);
	const headers = {
		'Content-Type': type,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'public, max-age=86400'
	};
	const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
	if (range) {
		let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
		let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
		if (isNaN(start) || start < 0) start = 0;
		end = Math.min(end, st.size - 1);
		if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
		res.writeHead(206, Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 }));
		if (req.method === 'HEAD') return res.end();
		fs.createReadStream(p, { start, end }).pipe(res);
	} else {
		res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
		if (req.method === 'HEAD') return res.end();
		fs.createReadStream(p).pipe(res);
	}
}

// ---------- optional Web API polling ----------
const webapi = new WebApi({
	clientId: config.spotifyClientId,
	redirectUri: `http://127.0.0.1:${PORT}/callback`,
	tokenFile: path.join(DATA, 'webapi-tokens.json'),
	log
});

async function poll() {
	try {
		// The Spicetify bridge is better (it knows the canvas), so only poll when it's quiet.
		if (webapi.loggedIn && Date.now() - lastBridgeAt > 15000) {
			const cur = await webapi.currentlyPlaying();
			if (cur === null) { if (state.trackId || state.playing) await setTrack({ trackId: null, playing: false }, 'web api'); }
			else if (cur) {
				if (cur.trackId !== state.trackId || !state.album) {
					cur.albumName = cur.album;
					try { cur.album = await webapi.album(cur.albumUri); } catch (e) { cur.album = null; }
				}
				await setTrack(cur, 'web api');
			}
		}
	} catch (e) { log('poll error:', e.message); }
	setTimeout(poll, Math.max(1, Number(config.pollSeconds) || 3) * 1000);
}

// ---------- HTTP ----------
// Only the wallpaper (a file:// page: Origin "file://", "null" or none), the Spicetify bridge (Spotify's app) and the helper's own
// pages may talk to it. Stops other websites from reading or spoofing it, and blocks DNS-rebinding tricks.
const ALLOWED_HOSTS = new Set(['127.0.0.1:' + PORT, 'localhost:' + PORT, '[::1]:' + PORT]);
const ALLOWED_ORIGINS = new Set(['null', 'file://', 'https://xpui.app.spotify.com', 'sp://xpui', 'http://127.0.0.1:' + PORT, 'http://localhost:' + PORT]
	.concat(Array.isArray(config.extraOrigins) ? config.extraOrigins.filter(o => typeof o === 'string') : []));
const warnedOrigins = new Set();
function originOk(req) {
	const o = req.headers.origin;
	if (o === undefined) return true; // direct navigation, <video>, the wallpaper's file:// requests
	if (ALLOWED_ORIGINS.has(o)) return true;
	if (!warnedOrigins.has(o)) { warnedOrigins.add(o); log('  blocked a request from ' + String(o).slice(0, 100) + ' (add it to "extraOrigins" in config.json if it is yours)'); }
	return false;
}
function cors(req, res) {
	const o = req.headers.origin;
	if (o === undefined || !ALLOWED_ORIGINS.has(o)) return;
	res.setHeader('Access-Control-Allow-Origin', o);
	res.setHeader('Vary', 'Origin');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
	res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
	res.setHeader('Access-Control-Allow-Private-Network', 'true');
}
function send(res, code, body, type) {
	if (res.headersSent) return res.end();
	res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
	res.end(body);
}
function readJson(req, limit = 65536) {
	return new Promise((resolve, reject) => {
		let size = 0; const chunks = [];
		req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
		req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
		req.on('error', reject);
	});
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function statusPage() {
	const bridgeOk = Date.now() - lastBridgeAt < 20000;
	const rows = [
		['Now playing', state.trackId ? `${esc(state.artist)} – ${esc(state.title)}` : '—'],
		['Canvas', CANVASES ? esc(state.canvasStatus) : 'off ("enableCanvases": false in config.json)'],
		['Album tracklist', state.album ? `${esc(state.album.name)} (${state.album.tracks.length} tracks)` : '—'],
		['Song info from', state.source === 'windows' ? 'Windows media controls (no setup)' : state.source === 'spicetify' ? 'Spicetify bridge' : state.source === 'web api' ? 'Spotify Web API login' : '—'],
		['Spicetify bridge', bridgeOk ? '✅ connected' : 'not installed / not seen (only needed for canvases)'],
		['No-setup lookups', esc(zeroInfo.status) + (zeroInfo.detail ? ' — ' + esc(zeroInfo.detail) : '')],
		['Web API login', !webapi.enabled ? 'not configured (optional)' : webapi.loggedIn ? '✅ logged in' : `<a href="/login">Log in with Spotify</a>`],
		['Wallpapers connected', String(clients.size)],
		['ffmpeg (WebM for Wallpaper Engine)', esc(ffmpeg.status) + (ffmpeg.bin ? ' — ' + esc(ffmpeg.bin) : '')],
		['Wallpaper version', wallpaperDiag ? 'v' + (wallpaperDiag.v || '?') + (wallpaperDiag.v >= WALLPAPER_VERSION ? ' (up to date)' : ' — old, reload it in Wallpaper Engine') : '— (old version or not reloaded yet: reload it in Wallpaper Engine)'],
		['Wallpaper can play', wallpaperDiag ? `H.264 MP4: ${wallpaperDiag.h264 ? 'yes' : 'no'} · WebM VP9: ${wallpaperDiag.vp9 ? 'yes' : 'no'}` : '— (not reported yet)'],
		['Wallpaper last event', wallpaperDiag && wallpaperDiag.event ? esc(wallpaperDiag.event) : '—'],
		['Cached lookups', String(Object.keys(canvasCache).length)]
	];
	return `<!doctype html><meta charset="utf-8"><title>ACV helper</title>
<meta http-equiv="refresh" content="5">
<style>body{background:#000;color:#cfc;font:15px/1.6 Consolas,monospace;padding:30px}td{padding:2px 18px 2px 0}a{color:#8f8}h1{font-size:18px}</style>
<h1>ASCII Music Visualizer · helper on port ${PORT}</h1>
<table>${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>
${state.hasCanvas ? `<p><video src="/video/${state.trackId}" autoplay muted loop height="320"></video></p>` : ''}`;
}

const server = http.createServer(async (req, res) => {
	if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, 'forbidden');
	if (!originOk(req)) return send(res, 403, 'forbidden');
	cors(req, res);
	res.setHeader('X-Content-Type-Options', 'nosniff');
	if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
	const url = new URL(req.url, 'http://127.0.0.1');
	const parts = url.pathname.split('/').filter(Boolean);
	try {
		if (url.pathname === '/' && req.method === 'GET') return send(res, 200, statusPage(), 'text/html; charset=utf-8');

		if (url.pathname === '/events') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
			res.write('retry: 3000\n');
			res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
			clients.add(res);
			const ping = setInterval(() => res.write(': ping\n\n'), 20000);
			req.on('close', () => { clearInterval(ping); clients.delete(res); });
			return;
		}

		if (url.pathname === '/state') return send(res, 200, JSON.stringify(publicState()), 'application/json');

		if (parts[0] === 'font' && parts.length === 2 && FONTS[parts[1]]) {
			let fp;
			try { fp = await ensureFont(parts[1]); } catch (e) { log('  font download failed: ' + e.message); return send(res, 502, 'font unavailable'); }
			const buf = await fsp.readFile(fp);
			res.writeHead(200, { 'Content-Type': 'font/ttf', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=31536000' });
			return res.end(buf);
		}

		if (url.pathname === '/np') {
			const q = url.searchParams;
			const np = { title: (q.get('title') || '').slice(0, 300), artist: (q.get('artist') || '').slice(0, 300), album: (q.get('album') || '').slice(0, 300), playing: q.get('playing') !== '0' };
			if (np.title && zeroSetupActive()) zeroSetupTrack(np).catch(e => log('no-setup error: ' + e.message));
			return send(res, 200, '{"ok":true}', 'application/json');
		}

		if (url.pathname === '/diag') {
			let b = {};
			if (req.method === 'POST') b = await readJson(req, 8192);
			else {
				const q = url.searchParams;
				b = { v: Number(q.get('v')) || 0, h264: q.get('h264') === '1', vp9: q.get('vp9') === '1' };
				if (q.get('event')) b.event = q.get('event');
			}
			wallpaperDiag = Object.assign(wallpaperDiag || {}, b, { at: Date.now() });
			if (b.event) log('  wallpaper: ' + String(b.event).slice(0, 200));
			return send(res, 200, '{"ok":true}', 'application/json');
		}

		if (url.pathname === '/update' && req.method === 'POST') {
			const b = await readJson(req);
			lastBridgeAt = Date.now();
			if (CANVASES && typeof b.token === 'string' && b.token.length > 20) bridgeToken = b.token;
			let trackId = null;
			if (typeof b.uri === 'string' && b.uri.startsWith('spotify:track:')) trackId = b.uri.slice('spotify:track:'.length);
			if (trackId && !TRACK_ID.test(trackId)) trackId = null;
			const info = {
				trackId,
				title: b.title, artist: b.artist, coverUrl: b.coverUrl,
				albumName: typeof b.album === 'string' ? b.album : (b.album && typeof b.album.name === 'string' ? b.album.name : ''),
				playing: b.playing !== false,
				token: CANVASES && typeof b.token === 'string' ? b.token : undefined,
				album: b.album && typeof b.album === 'object' ? b.album : null
			};
			if (CANVASES && 'canvasUrl' in b) info.canvasUrl = b.canvasUrl === null ? null : (validCanvasUrl(b.canvasUrl) ? b.canvasUrl : null);
			await setTrack(info, 'spicetify');
			// Tell the bridge whether we still need canvas info for this track (e.g. after a helper restart).
			const need = CANVASES && !!trackId && trackId === state.trackId && (state.canvasStatus === 'idle' || state.canvasStatus === 'error');
			const needAlbum = !!trackId && trackId === state.trackId && !state.album;
			return send(res, 200, JSON.stringify({ ok: true, needCanvas: need, needAlbum, canvases: CANVASES }), 'application/json');
		}

		if (parts[0] === 'video' && !CANVASES) return send(res, 404, 'canvases are off');
		if ((parts[0] === 'video' || parts[0] === 'cover') && parts.length === 2 && (req.method === 'GET' || req.method === 'HEAD')) {
			return await serveFile(req, res, parts[0], parts[1], url.searchParams.get('fmt'));
		}

		if (url.pathname === '/login') {
			if (!webapi.enabled) return send(res, 400, 'Set "spotifyClientId" in helper/config.json first (see README).');
			res.writeHead(302, { Location: webapi.loginUrl() });
			return res.end();
		}
		if (url.pathname === '/callback') {
			const err = url.searchParams.get('error');
			if (err) return send(res, 400, 'Spotify login failed: ' + err);
			await webapi.handleCallback(url.searchParams.get('code'), url.searchParams.get('state'));
			log('Web API login OK');
			res.writeHead(302, { Location: '/' });
			return res.end();
		}

		send(res, 404, 'not found');
	} catch (e) {
		log('request error:', e.message);
		send(res, 500, 'error');
	}
});

server.on('error', e => {
	if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Is the helper already running? Change "port" in config.json (and "Helper port" in the wallpaper settings).`);
	else console.error(e);
	process.exit(1);
});

const PID_FILE = path.join(DATA, 'helper.pid');
function removePid() { try { if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE); } catch (e) { /* gone */ } }
process.on('exit', removePid);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));

server.listen(PORT, '127.0.0.1', () => {
	try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (e) { /* not critical */ }
	log(`ASCII Music Visualizer helper running → http://127.0.0.1:${PORT}`);
	if (webapi.enabled && !webapi.loggedIn) log(`Web API: open http://127.0.0.1:${PORT}/login once to log in`);
	pruneCache().catch(() => {});
	if (CANVASES) ffmpeg.find().catch(() => {}); // ffmpeg is only needed for canvases
	poll();
});

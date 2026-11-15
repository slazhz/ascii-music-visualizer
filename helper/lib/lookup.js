'use strict';
/*
 * Zero-setup mode: no Spicetify, no Spotify login.
 * The wallpaper tells us title / artist / album (from Windows' media controls),
 * and we look up the rest:
 *  - album tracklist + high-res cover from Deezer's public API (iTunes as a backup)
 * Canvases need the Spicetify bridge (or a Spotify login); they aren't available here.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function norm(s) {
	return String(s || '').toLowerCase()
		.replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ')     // (Remastered), [Deluxe] …
		.replace(/\s+-\s+.*$/, '')                   // " - Remastered 2011"
		.replace(/[^a-z0-9À-￿]+/g, ' ').trim();
}
function firstArtist(a) { return String(a || '').split(/,|&| feat\.? | ft\.? | x /i)[0].trim(); }
function similar(a, b) {
	a = norm(a); b = norm(b);
	if (!a || !b) return false;
	return a === b || a.includes(b) || b.includes(a);
}

async function getJson(url, headers) {
	const r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, headers || {}) });
	if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(url).host);
	return r.json();
}

// ---------- Deezer ----------
// Deezer's "advanced" search (artist:"x" track:"y") currently returns nothing, so we use plain
// searches and pick the best match ourselves.
function score(item, art, title, album) {
	let sc = 0;
	const an = item.artist && item.artist.name;
	if (similar(an, art)) sc += 4; else return -1;
	if (title && similar(item.title, title)) sc += 3;
	if (album && item.album && similar(item.album.title, album)) sc += 3;
	if (album && item.title && !item.album && similar(item.title, album)) sc += 3; // album search results
	return sc;
}
async function deezerAlbum({ title, artist, album }) {
	const art = firstArtist(artist);
	let albumId = null, best = -1;
	const tries = [];
	if (title) tries.push(['search', art + ' ' + (norm(title) || title)]);
	if (album) tries.push(['search/album', art + ' ' + (norm(album) || album)]);
	if (title) tries.push(['search', (norm(title) || title)]);
	for (const [path, q] of tries) {
		const j = await getJson('https://api.deezer.com/' + path + '?limit=25&q=' + encodeURIComponent(q));
		if (j && j.error) throw new Error('Deezer: ' + (j.error.message || 'error'));
		for (const it of (j.data || [])) {
			const sc = score(it, art, path === 'search' ? title : null, album);
			const id = path === 'search' ? it.album && it.album.id : it.id;
			// Prefer an exact album-name match; a title-only match is good enough when no album is known.
			if (id && sc > best && (sc >= 7 || (sc >= 4 && path === 'search/album') || (!album && sc >= 7))) { best = sc; albumId = id; }
		}
		if (best >= 10 || (albumId && !album)) break;
		if (albumId && best >= 7) break;
	}
	if (!albumId) return null;
	const a = await getJson('https://api.deezer.com/album/' + albumId);
	if (!a || a.error) return null;
	let tracks = (a.tracks && a.tracks.data) || [];
	if (a.nb_tracks > tracks.length) {
		try { const t = await getJson('https://api.deezer.com/album/' + albumId + '/tracks?limit=200'); if (t.data) tracks = t.data; } catch (e) { /* keep first page */ }
	}
	return {
		album: {
			uri: 'deezer:album:' + albumId,
			name: a.title || album || '',
			year: (a.release_date || '').slice(0, 4),
			tracks: tracks.map((t, i) => ({ n: t.track_position || i + 1, d: t.disk_number || 1, title: t.title, ms: (t.duration || 0) * 1000, uri: '' }))
		},
		coverUrl: a.cover_xl || a.cover_big || null,
		source: 'Deezer'
	};
}

// ---------- iTunes (backup) ----------
async function itunesAlbum({ title, artist, album }) {
	const art = firstArtist(artist);
	for (const country of ['th', 'us']) {
		let hit = null;
		if (album) {
			const j = await getJson('https://itunes.apple.com/search?entity=album&limit=15&country=' + country + '&term=' + encodeURIComponent(art + ' ' + album));
			hit = (j.results || []).find(r => similar(r.artistName, art) && similar(r.collectionName, album));
		}
		if (!hit && title) {
			const j = await getJson('https://itunes.apple.com/search?entity=song&limit=15&country=' + country + '&term=' + encodeURIComponent(art + ' ' + title));
			const song = (j.results || []).find(r => similar(r.artistName, art) && similar(r.trackName, title));
			if (song) hit = song;
		}
		if (!hit) continue;
		const l = await getJson('https://itunes.apple.com/lookup?entity=song&limit=200&country=' + country + '&id=' + hit.collectionId);
		const coll = (l.results || []).find(r => r.wrapperType === 'collection') || hit;
		const songs = (l.results || []).filter(r => r.wrapperType === 'track');
		if (!songs.length) continue;
		return {
			album: {
				uri: 'itunes:album:' + hit.collectionId,
				name: coll.collectionName || album || '',
				year: (coll.releaseDate || '').slice(0, 4),
				tracks: songs.map(s2 => ({ n: s2.trackNumber, d: s2.discNumber || 1, title: s2.trackName, ms: s2.trackTimeMillis || 0, uri: '' }))
			},
			coverUrl: coll.artworkUrl100 ? coll.artworkUrl100.replace(/\/\d+x\d+bb\./, '/1000x1000bb.') : null,
			source: 'iTunes'
		};
	}
	return null;
}

const albumCache = new Map();
async function findAlbum(info) {
	const key = norm(firstArtist(info.artist)) + '|' + norm(info.album || info.title);
	if (albumCache.has(key)) return albumCache.get(key);
	let res = null, errs = [];
	for (const fn of [deezerAlbum, itunesAlbum]) {
		try { res = await fn(info); if (res) break; } catch (e) { errs.push(e.message); }
	}
	if (!res && errs.length) throw new Error(errs.join('; '));
	if (res) albumCache.set(key, res);
	return res;
}

module.exports = { findAlbum, norm };

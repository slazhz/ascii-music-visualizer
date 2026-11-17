// NAME: Wallpaper Bridge
// AUTHOR: ASCII Music Visualizer contributors
// DESCRIPTION: Sends the current track (and, unless canvases are turned off in the helper,
//              its Spotify Canvas, plus synced lyrics while the wallpaper's lyrics setting is on) to the local ASCII Music Visualizer helper (http://127.0.0.1:7777).
//
// OPTIONAL and UNOFFICIAL: Spicetify modifies the Spotify app, and the Canvas lookup uses Spotify's
// private, undocumented API. Neither is endorsed by Spotify and either may break or go against
// Spotify's terms. Use at your own risk. Nothing is sent anywhere except your own computer (127.0.0.1).

(function wallpaperBridge() {
	var PORT = 7777; // change this if you changed "port" in helper/config.json
	var BASE = 'http://127.0.0.1:' + PORT;
	// Fallback persisted-query hash for the "canvas" GraphQL operation, used only
	// if this Spotify version doesn't expose the definition itself.
	var CANVAS_HASH = '575138ab27cd5c1b3e54da54d0a7cc8d85485402de26340c2145f0f6bb5e7a9f';

	if (!window.Spicetify || !Spicetify.Player || !Spicetify.Player.addEventListener || !Spicetify.Platform) {
		setTimeout(wallpaperBridge, 300);
		return;
	}

	function currentItem() {
		var d = Spicetify.Player.data || {};
		return d.item || d.track || null;
	}

	function imageUrl(u) {
		if (!u || typeof u !== 'string') return null;
		if (u.indexOf('spotify:image:') === 0) return 'https://i.scdn.co/image/' + u.slice(14);
		return u.indexOf('https://') === 0 ? u : null;
	}

	function accessToken() {
		try {
			var P = Spicetify.Platform;
			if (P.Session && P.Session.accessToken) return P.Session.accessToken;
			if (P.AuthorizationAPI && P.AuthorizationAPI.getState) {
				var s = P.AuthorizationAPI.getState();
				if (s && s.token && s.token.accessToken) return s.token.accessToken;
			}
		} catch (e) { /* ignore */ }
		return null;
	}

	// Returns the canvas URL, null (track has no canvas) or undefined (couldn't ask).
	async function getCanvas(uri) {
		try {
			if (!Spicetify.GraphQL || !Spicetify.GraphQL.Request) return undefined;
			var defs = Spicetify.GraphQL.Definitions || {};
			var def = defs.canvas || { name: 'canvas', operation: 'query', sha256Hash: CANVAS_HASH, value: null };
			var res = await Spicetify.GraphQL.Request(def, { trackUri: uri });
			if (res && res.errors && res.errors.length) return undefined;
			var tu = res && res.data && res.data.trackUnion;
			if (!tu) return undefined;
			return (tu.canvas && tu.canvas.url) || null;
		} catch (e) {
			return undefined;
		}
	}

	// The current album's tracklist (cached per album).
	var albumCache = {};
	async function apiGet(url) {
		try {
			var j = await Spicetify.CosmosAsync.get(url);
			if (j && !j.error) return j;
		} catch (e) { /* fall back to a plain request */ }
		var tok = accessToken();
		if (!tok) return null;
		try {
			var r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
			return r.ok ? await r.json() : null;
		} catch (e) { return null; }
	}
	async function getAlbum(item) {
		var uri = (item.album && item.album.uri) || (item.metadata && item.metadata.album_uri);
		if (!uri || uri.indexOf('spotify:album:') !== 0) return null;
		if (albumCache[uri]) return albumCache[uri];
		var j = await apiGet('https://api.spotify.com/v1/albums/' + uri.split(':')[2] + '?market=from_token');
		if (!j || !j.tracks) return null;
		var items = j.tracks.items || [], next = j.tracks.next, pages = 0;
		while (next && pages < 4) {
			pages++;
			var k = await apiGet(next);
			if (!k || !k.items) break;
			items = items.concat(k.items); next = k.next;
		}
		var info = {
			uri: uri,
			name: j.name || '',
			year: (j.release_date || '').slice(0, 4),
			tracks: items.map(function (t) { return { n: t.track_number, d: t.disc_number, title: t.name, ms: t.duration_ms, uri: t.uri }; })
		};
		albumCache[uri] = info;
		return info;
	}

	// Synced lyrics for a track (the same ones Spotify shows). Only fetched when the helper asks,
	// i.e. while the wallpaper's "Show lyrics" setting is on. Returns { synced, lines: [{ t, text }] } or null.
	async function getLyrics(uri) {
		try {
			var id = uri.split(':')[2];
			var j = await Spicetify.CosmosAsync.get(
				'https://spclient.wg.spotify.com/color-lyrics/v2/track/' + id + '?format=json&vocalRemoval=false&market=from_token',
				null, { 'app-platform': 'WebPlayer' });
			var l = j && j.lyrics;
			if (!l || !Array.isArray(l.lines)) return null;
			return {
				synced: l.syncType === 'LINE_SYNCED',
				lines: l.lines.map(function (x) { return { t: Number(x.startTimeMs) || 0, text: String(x.words || '') }; })
			};
		} catch (e) {
			return null; // no lyrics for this track (or not available in this country)
		}
	}
	var lyricsTried = {};

	async function post(payload) {
		try {
			var r = await fetch(BASE + '/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			return await r.json();
		} catch (e) {
			return null; // helper not running – that's fine
		}
	}

	var busy = false;
	var lastPos = null; // last position sent, to notice seeks
	var canvasesOn = false; // the helper tells us; canvases stay off unless you enabled them there
	async function send(withCanvas) {
		if (busy && withCanvas) { setTimeout(function () { send(true); }, 400); return; }
		var item = currentItem();
		var playing = !!(Spicetify.Player.isPlaying && Spicetify.Player.isPlaying());
		if (!item || !item.uri || item.uri.indexOf('spotify:track:') !== 0) {
			post({ uri: null, playing: playing });
			return;
		}
		var md = item.metadata || {};
		var payload = {
			uri: item.uri,
			title: md.title || item.name || '',
			artist: md.artist_name || (item.artists || []).map(function (a) { return a.name; }).join(', '),
			album: md.album_title || (item.album && item.album.name) || '',
			coverUrl: imageUrl(md.image_xlarge_url || md.image_large_url || md.image_url ||
				(item.images && item.images[0] && item.images[0].url)),
			playing: playing
		};
		// Exact playback position, so synced lyrics line up (Windows doesn't always report it).
		try {
			var pg = Spicetify.Player.getProgress(), du = Spicetify.Player.getDuration();
			if (typeof pg === 'number' && isFinite(pg)) { payload.progressMs = Math.round(pg); payload.durationMs = Math.round(du || 0); lastPos = { at: Date.now(), ms: pg, playing: playing }; }
		} catch (e) { /* older Spotify: the wallpaper falls back to Windows' timeline */ }
		if (withCanvas) {
			busy = true;
			if (canvasesOn) {
				var c = await getCanvas(item.uri);
				if (c === undefined) payload.token = accessToken(); // let the helper try
				else payload.canvasUrl = c;
			}
			busy = false;
			var album = await getAlbum(item);
			if (album) payload.album = album;
		}
		var reply = await post(payload);
		if (reply) canvasesOn = reply.canvases === true;
		if (reply && reply.needLyrics && !lyricsTried[item.uri]) {
			lyricsTried[item.uri] = true;
			payload.lyrics = await getLyrics(item.uri);
			post(payload);
		}
		if (reply && (reply.needCanvas || reply.needAlbum) && !withCanvas) send(true);
	}

	Spicetify.Player.addEventListener('songchange', function () { setTimeout(function () { send(true); }, 150); });
	Spicetify.Player.addEventListener('onplaypause', function () { send(false); });
	setInterval(function () { send(false); }, 10000); // heartbeat; also recovers after a helper restart
	// Seeking: send the new position right away when it jumps away from where it should be.
	Spicetify.Player.addEventListener('onprogress', function () {
		if (!lastPos) return;
		var expect = lastPos.ms + (lastPos.playing ? Date.now() - lastPos.at : 0), now = Spicetify.Player.getProgress();
		if (Math.abs(now - expect) > 1500) { lastPos = { at: Date.now(), ms: now, playing: lastPos.playing }; send(false); }
	});
	send(true);
})();

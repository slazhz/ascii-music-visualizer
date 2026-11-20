/* Web demo: runs only in a normal browser (not inside Wallpaper Engine).
   - A built-in demo song, the visitor's own audio file, or the microphone.
   - Spotify sign-in (owner + up to 4 approved accounts): shows what's playing, the album
     tracklist and synced lyrics. Bars can follow the computer's sound via screen sharing.
   - A settings panel built from project.json, so it always matches the Steam version.
   Nothing is uploaded: audio files are played locally, settings stay in this browser. */
(function () {
	if (typeof window.wallpaperRegisterMediaPropertiesListener === 'function') return; // inside Wallpaper Engine
	var M = ACV.media, A = ACV.audio, S = ACV.settings;
	if (!M || !A) return;
	M.web = M.web || { album: null, trackUri: '', lyrics: null };
	var CFG = window.ACV_WEB || {};
	var inFrame = (function () { try { return window.top !== window; } catch (e) { return true; } })();

	var store = {
		get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
		set: function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } }
	};

	// Local helper can't be reached from a hosted page; online lookups only where they make sense.
	S.directAlbums = false;

	// ---------- Demo song (cover drawn in code, no third-party artwork) ----------
	function demoCover() {
		var size = 640, c = document.createElement('canvas');
		c.width = c.height = size;
		var g = c.getContext('2d');
		var bg = g.createLinearGradient(0, 0, 0, size);
		bg.addColorStop(0, '#1b2f6b'); bg.addColorStop(0.55, '#2a1846'); bg.addColorStop(1, '#120b22');
		g.fillStyle = bg; g.fillRect(0, 0, size, size);
		var cx = size / 2, cy = size * 0.56;
		var ring = ['#3fb6c9', '#e0894a', '#8a5cc9', '#d2484f', '#4f86d9', '#e7c46a'];
		for (var r = size * 0.62, i = 0; r > size * 0.16; r -= 14, i++) {
			g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
			g.strokeStyle = ring[i % ring.length]; g.globalAlpha = 0.55 + 0.4 * (i % 2); g.lineWidth = 6; g.stroke();
		}
		g.globalAlpha = 1;
		var sun = g.createRadialGradient(cx, cy - 10, 10, cx, cy, size * 0.15);
		sun.addColorStop(0, '#f6e2a8'); sun.addColorStop(1, '#c9a35a');
		g.fillStyle = sun; g.beginPath(); g.arc(cx, cy, size * 0.15, 0, Math.PI * 2); g.fill();
		return c.toDataURL('image/png');
	}
	var DEMO = {
		title: 'Satellite Hearts', artist: 'Neon Tide', album: 'Demo',
		thumbnail: demoCover(),
		colors: { primary: [0.25, 0.71, 0.79], secondary: [0.88, 0.54, 0.29], tertiary: [0.54, 0.36, 0.79], text: [0.96, 0.89, 0.66] }
	};

	function emit() {
		M._handlers.forEach(function (fn) { try { fn(); } catch (e) { /* keep going */ } });
	}
	function clearWeb() { M.web.album = null; M.web.trackUri = ''; M.web.lyrics = null; }
	function setSong(s) {
		clearWeb();
		M.we.title = s.title; M.we.artist = s.artist; M.we.album = s.album || '';
		M.we.thumbnail = s.thumbnail || DEMO.thumbnail;
		M.we.colors = s.colors || DEMO.colors;
		M.we.playing = true; M.we.position = 0; M.we.duration = 0; M.we.timelineAt = performance.now();
		emit();
	}

	// ---------- Web Audio: file, microphone, or the computer's sound (screen share) ----------
	var ctx = null, analyser = null, freq = null, srcNode = null, stream = null, audioEl = null;
	var mode = 'demo';      // what's shown: demo | file | mic | spotify
	var listen = 'none';    // what the bars hear: none (animated) | file | mic | screen
	function ensureCtx() {
		if (!ctx) {
			var AC = window.AudioContext || window.webkitAudioContext;
			if (!AC) return null;
			ctx = new AC();
			analyser = ctx.createAnalyser();
			analyser.fftSize = 512;
			analyser.smoothingTimeConstant = 0.6;
			freq = new Uint8Array(analyser.frequencyBinCount);
		}
		if (ctx.state === 'suspended') ctx.resume();
		return ctx;
	}
	// Map the analyser's linear bins onto the visualizer's 64 bands (low frequencies first, log spaced).
	function feed(raw) {
		analyser.getByteFrequencyData(freq);
		var n = raw.length, max = freq.length * 0.75;
		for (var i = 0; i < n; i++) {
			var a = Math.floor(Math.pow(i / n, 2) * max) + 1, b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / n, 2) * max) + 1);
			var s = 0;
			for (var k = a; k < b; k++) s += freq[k];
			raw[i] = Math.min(1.6, (s / (b - a)) / 255 * 1.35);
		}
	}
	function stopAudio() {
		if (srcNode) { try { srcNode.disconnect(); } catch (e) { /* ignore */ } srcNode = null; }
		if (analyser) { try { analyser.disconnect(); } catch (e) { /* not connected */ } }
		if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
		if (audioEl) { audioEl.pause(); URL.revokeObjectURL(audioEl.src); audioEl = null; }
		A.external = null;
		listen = 'none';
	}
	function listenTo(mediaStream, kind) {
		stopAudio();
		stream = mediaStream;
		srcNode = ctx.createMediaStreamSource(mediaStream);
		srcNode.connect(analyser); // not to the speakers, to avoid an echo
		A.external = feed;
		listen = kind;
		mediaStream.getAudioTracks().forEach(function (t) {
			t.addEventListener('ended', function () { if (stream === mediaStream) { stopAudio(); syncUi(); } });
		});
	}

	function playFile(file) {
		if (!file || !ensureCtx()) return;
		leaveSpotify();
		stopAudio();
		audioEl = new Audio();
		audioEl.src = URL.createObjectURL(file);
		audioEl.loop = true;
		srcNode = ctx.createMediaElementSource(audioEl);
		srcNode.connect(analyser);
		analyser.connect(ctx.destination);
		A.external = feed;
		listen = 'file';
		var name = file.name.replace(/\.[^.]+$/, '');
		var parts = name.split(' - ');
		S.directAlbums = true; // "Artist - Title" files can find their tracklist online
		store.set('acv-web-mode', 'demo');
		setSong({ title: parts.length > 1 ? parts.slice(1).join(' - ') : name, artist: parts.length > 1 ? parts[0] : 'Your file', album: '' });
		audioEl.addEventListener('timeupdate', function () {
			M.we.position = audioEl.currentTime; M.we.duration = audioEl.duration || 0; M.we.timelineAt = performance.now();
		});
		audioEl.addEventListener('play', function () { M.we.playing = true; emit(); syncUi(); });
		audioEl.addEventListener('pause', function () { M.we.playing = false; emit(); syncUi(); });
		audioEl.play().catch(function () { /* needs a click; the button is one */ });
		mode = 'file'; syncUi();
	}

	function useMic() {
		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !ensureCtx()) { note('This browser cannot use the microphone.'); return; }
		navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(function (s) {
			listenTo(s, 'mic');
			if (mode !== 'spotify') { // on its own the mic is the "song"; with Spotify it only drives the bars
				S.directAlbums = false;
				store.set('acv-web-mode', 'demo');
				setSong({ title: 'Listening', artist: 'Microphone', album: '' });
				mode = 'mic';
			}
			syncUi();
		}).catch(function () { note('Microphone access was blocked. Allow it in the address bar and try again.'); });
	}

	// The computer's own sound, through the browser's screen-share dialog (Chrome / Edge).
	function useScreenAudio() {
		if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || !ensureCtx()) { note('This browser cannot capture the computer’s sound. Try Chrome or Edge, or use the microphone.'); return; }
		navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' }).then(function (s) {
			if (!s.getAudioTracks().length) {
				s.getTracks().forEach(function (t) { t.stop(); });
				note('No sound was shared. Share your entire screen and turn on “Also share system audio”.');
				return;
			}
			s.getVideoTracks().forEach(function (t) { t.enabled = false; }); // only the sound is used
			listenTo(s, 'screen');
			syncUi();
		}).catch(function () { /* the visitor closed the dialog */ });
	}

	function backToDemo() {
		leaveSpotify();
		stopAudio();
		S.directAlbums = false;
		setSong(DEMO);
		mode = 'demo';
		store.set('acv-web-mode', 'demo');
		syncUi();
	}

	// ---------- Spotify (Authorization Code with PKCE: no secret in the page) ----------
	var SP = { token: store.get('acv-spotify'), timer: 0, lastId: '', albumId: '', sig: '', want: false, status: '', lyInfo: null };
	var SCOPES = 'user-read-currently-playing user-read-playback-state';
	function redirectUri() { return location.origin + location.pathname; }
	function b64url(bytes) {
		var s = '';
		for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
		return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}
	function randomString(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a).slice(0, n); }
	function cleanUrl() {
		var u = new URL(location.href);
		['code', 'state', 'error', 'connect'].forEach(function (k) { u.searchParams.delete(k); });
		history.replaceState(null, '', u.pathname + u.search + u.hash);
	}

	// Returns true when the page is about to go to Spotify's sign-in page.
	function spLogin() {
		if (!CFG.spotifyClientId) { openDrawer(); spStatus('Spotify isn’t set up yet: add your Client ID to js/web-config.js.'); return false; }
		if (inFrame) {
			window.open(redirectUri() + '?connect=spotify', '_blank');
			SP.want = true;
			spStatus('Finish connecting in the new tab. This page picks it up automatically.');
			return false;
		}
		if (!window.crypto || !crypto.subtle) { note('Spotify sign-in needs a secure (https) page.'); return false; }
		var verifier = randomString(64), state = randomString(16);
		crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (hash) {
			store.set('acv-spotify-pkce', { v: verifier, s: state });
			var q = new URLSearchParams({
				response_type: 'code', client_id: CFG.spotifyClientId, scope: SCOPES,
				redirect_uri: redirectUri(), code_challenge_method: 'S256',
				code_challenge: b64url(new Uint8Array(hash)), state: state
			});
			location.assign('https://accounts.spotify.com/authorize?' + q.toString());
		});
		return true;
	}

	function tokenRequest(params) {
		params.client_id = CFG.spotifyClientId;
		return fetch('https://accounts.spotify.com/api/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(params).toString()
		}).then(function (r) {
			return r.json().catch(function () { return {}; }).then(function (j) {
				if (!r.ok) { var err = new Error(j.error_description || j.error || ('HTTP ' + r.status)); err.auth = r.status === 400 || r.status === 401; throw err; }
				return j;
			});
		}).then(function (j) {
			SP.token = { access: j.access_token, refresh: j.refresh_token || (SP.token && SP.token.refresh), exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
			store.set('acv-spotify', SP.token);
			return SP.token.access;
		});
	}

	// Coming back from Spotify's sign-in page with ?code=...
	function handleRedirect() {
		var q = new URLSearchParams(location.search);
		if (q.get('connect') === 'spotify' && !q.get('code')) { cleanUrl(); return Promise.resolve(spLogin() ? 'leaving' : false); }
		if (!q.get('code') && !q.get('error')) return Promise.resolve(false);
		var pk = store.get('acv-spotify-pkce');
		store.set('acv-spotify-pkce', null);
		var code = q.get('code'), state = q.get('state'), error = q.get('error');
		cleanUrl();
		if (error) { note('Spotify connection was cancelled.'); return Promise.resolve(false); }
		if (!pk || pk.s !== state) { note('The Spotify sign-in didn’t match. Please try connecting again.'); return Promise.resolve(false); }
		return tokenRequest({ grant_type: 'authorization_code', code: code, redirect_uri: redirectUri(), code_verifier: pk.v })
			.then(function () { return true; }, function (e) { note('Couldn’t connect to Spotify: ' + e.message); return false; });
	}

	function accessToken(force) {
		if (!SP.token) return Promise.reject(Object.assign(new Error('not signed in'), { auth: true }));
		if (!force && Date.now() < SP.token.exp) return Promise.resolve(SP.token.access);
		if (!SP.token.refresh) return Promise.reject(Object.assign(new Error('expired'), { auth: true }));
		return tokenRequest({ grant_type: 'refresh_token', refresh_token: SP.token.refresh });
	}
	function api(path, retried) {
		var url = /^https:/.test(path) ? path : 'https://api.spotify.com/v1' + path;
		return accessToken(false).then(function (t) {
			return fetch(url, { headers: { Authorization: 'Bearer ' + t } });
		}).then(function (r) {
			if (r.status === 204) return null;
			if (r.status === 401 && !retried) return accessToken(true).then(function () { return api(path, true); });
			if (!r.ok) {
				var err = new Error('HTTP ' + r.status);
				err.status = r.status; err.retry = Number(r.headers.get('Retry-After')) || 0; err.auth = r.status === 401;
				throw err;
			}
			return r.json();
		});
	}

	function startSpotify() {
		if (!SP.token) { spLogin(); return; }
		if (audioEl) stopAudio(); // a playing file would fight with Spotify; mic / screen sound can stay
		mode = 'spotify';
		SP.lastId = ''; SP.albumId = ''; SP.sig = '';
		clearWeb();
		S.directAlbums = true;
		store.set('acv-web-mode', 'spotify');
		spStatus('Connected. Play something on Spotify (any device).');
		syncUi();
		spPoll();
	}
	function leaveSpotify() {
		clearTimeout(SP.timer);
		if (mode === 'spotify') clearWeb();
	}
	function disconnectSpotify() {
		store.set('acv-spotify', null);
		SP.token = null;
		spStatus('Disconnected.');
		if (mode === 'spotify') backToDemo(); else syncUi();
	}

	function spSchedule(ms) { clearTimeout(SP.timer); if (mode === 'spotify') SP.timer = setTimeout(spPoll, ms); }
	function spPoll() {
		clearTimeout(SP.timer);
		if (mode !== 'spotify') return;
		api('/me/player/currently-playing?additional_types=track,episode').then(function (j) {
			if (!j || !j.item) spNothing(j); else spApply(j);
			spSchedule(document.hidden ? 15000 : 3000);
		}).catch(function (e) {
			if (e.status === 429) { spSchedule(Math.max(5, e.retry) * 1000); return; }
			if (e.status === 403) { spStatus('Spotify refused this account. In the Spotify Developer Dashboard, add its email under User Management.'); spSchedule(30000); return; }
			if (e.auth) { disconnectSpotify(); spStatus('The Spotify sign-in expired. Connect again.'); return; }
			spSchedule(10000);
		});
	}
	function spNothing() {
		var sig = 'nothing';
		if (SP.sig === sig) return;
		SP.sig = sig; SP.lastId = '';
		clearWeb();
		M.we.title = ''; M.we.artist = ''; M.we.album = ''; M.we.thumbnail = null; M.we.playing = false; M.we.duration = 0;
		spStatus('Connected. Nothing is playing on Spotify right now.');
		emit();
	}
	function spApply(j) {
		var it = j.item, ep = it.type === 'episode';
		var album = ep ? null : it.album;
		var images = ((album ? album.images : it.images) || []).slice().sort(function (a, b) { return (b.width || 0) - (a.width || 0); });
		M.we.title = it.name || '';
		M.we.artist = ep ? ((it.show && it.show.name) || '') : (it.artists || []).map(function (a) { return a.name; }).join(', ');
		M.we.album = album ? album.name : ((it.show && it.show.name) || '');
		M.we.playing = !!j.is_playing;
		M.we.position = (j.progress_ms || 0) / 1000;
		M.we.duration = (it.duration_ms || 0) / 1000;
		M.we.timelineAt = performance.now();
		M.web.trackUri = it.uri || '';
		if (it.id !== SP.lastId) {
			SP.lastId = it.id;
			M.we.thumbnail = images[0] ? images[0].url : DEMO.thumbnail;
			M.web.lyrics = null;
			if (images[0]) coverColors(images[0].url); else M.we.colors = DEMO.colors;
			if (album) loadAlbum(album);
			SP.lyInfo = ep ? null : { title: it.name, artist: (it.artists && it.artists[0] && it.artists[0].name) || '', album: album ? album.name : '', sec: Math.round((it.duration_ms || 0) / 1000), id: it.id };
			if (S.showLyrics) loadLyrics();
			spStatus('Connected. Showing what’s playing on Spotify.');
		}
		var sig = it.id + '|' + M.we.playing;
		if (sig !== SP.sig) { SP.sig = sig; emit(); }
	}

	// Album colours for the bars and titles (Wallpaper Engine normally provides these).
	function coverColors(url) {
		var img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = function () {
			try {
				var c = document.createElement('canvas'); c.width = c.height = 24;
				var g = c.getContext('2d'); g.drawImage(img, 0, 0, 24, 24);
				var d = g.getImageData(0, 0, 24, 24).data, px = [];
				for (var i = 0; i < d.length; i += 4) {
					var r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
					var mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
					px.push({ c: [r, gg, b], sat: mx ? (mx - mn) / mx : 0, lum: 0.2126 * r + 0.7152 * gg + 0.0722 * b });
				}
				var vivid = px.filter(function (p) { return p.lum > 0.15 && p.lum < 0.9; }).sort(function (a, b) { return b.sat * (0.4 + b.lum) - a.sat * (0.4 + a.lum); });
				var pick = function (k) { return (vivid[k] || px[k] || { c: [1, 1, 1] }).c; };
				var avg = [0, 0, 0];
				px.forEach(function (p) { avg[0] += p.c[0]; avg[1] += p.c[1]; avg[2] += p.c[2]; });
				avg = avg.map(function (v) { return v / px.length; });
				var far = vivid.filter(function (p) { return Math.abs(p.c[0] - pick(0)[0]) + Math.abs(p.c[1] - pick(0)[1]) + Math.abs(p.c[2] - pick(0)[2]) > 0.45; });
				M.we.colors = { primary: pick(0), secondary: far[0] ? far[0].c : avg, tertiary: far[1] ? far[1].c : avg, text: [0.96, 0.96, 0.96] };
				if (SP.lastId && url === M.we.thumbnail) emit();
			} catch (e) { M.we.colors = DEMO.colors; }
		};
		img.onerror = function () { M.we.colors = DEMO.colors; };
		img.src = url;
	}

	// Tracklist for the back of the cover.
	function loadAlbum(album) {
		if (!album.id || album.id === SP.albumId) return;
		SP.albumId = album.id;
		var id = album.id, tracks = [];
		function page(url) {
			return api(url).then(function (j) {
				(j && j.items || []).forEach(function (t) {
					tracks.push({ n: t.track_number, d: t.disc_number || 1, title: t.name, ms: t.duration_ms || 0, uri: t.uri || '' });
				});
				return j && j.next && tracks.length < 400 ? page(j.next) : null;
			});
		}
		page('/albums/' + id + '/tracks?limit=50').then(function () {
			if (SP.albumId !== id || !tracks.length) return;
			M.web.album = {
				uri: 'spotify:album:' + id,
				name: album.name || '',
				year: (album.release_date || '').slice(0, 4),
				artist: (album.artists || []).map(function (a) { return a.name; }).join(', '),
				label: '', genre: '', country: '', source: 'Spotify',
				tracks: tracks
			};
			emit();
		}).catch(function () { /* the online lookup (Deezer / iTunes) may still find it */ });
	}

	// Synced lyrics from LRCLIB (free, public), only when "Show lyrics" is on.
	function parseLrc(text) {
		var out = [];
		String(text || '').split(/\r?\n/).forEach(function (line) {
			var re = /\[(\d+):(\d+(?:\.\d+)?)\]/g, m, times = [], last = 0;
			while ((m = re.exec(line))) { times.push((Number(m[1]) * 60 + Number(m[2])) * 1000); last = re.lastIndex; }
			var words = line.slice(last).trim();
			times.forEach(function (t) { out.push({ t: Math.round(t), text: words }); });
		});
		return out.sort(function (a, b) { return a.t - b.t; });
	}
	function loadLyrics() {
		var info = SP.lyInfo;
		if (!info || !info.title || !info.artist) return;
		var q = new URLSearchParams({ track_name: info.title, artist_name: info.artist, album_name: info.album, duration: String(info.sec) });
		fetch('https://lrclib.net/api/get?' + q.toString()).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
			if (!j || !j.syncedLyrics || !SP.lyInfo || SP.lyInfo.id !== info.id) return;
			var lines = parseLrc(j.syncedLyrics);
			if (lines.length) { M.web.lyrics = { synced: true, lines: lines }; emit(); }
		}).catch(function () { /* no lyrics for this song */ });
	}
	ACV.onSettings(function (changed) {
		if (changed.indexOf('showLyrics') >= 0 && S.showLyrics && mode === 'spotify' && !M.web.lyrics) loadLyrics();
	});

	// Another tab finished the Spotify sign-in (used when this page is embedded).
	window.addEventListener('storage', function (e) {
		if (e.key !== 'acv-spotify') return;
		SP.token = store.get('acv-spotify');
		if (SP.token && SP.want) { SP.want = false; startSpotify(); } else syncUi();
	});

	// ---------- UI: small control panel + settings drawer ----------
	var css = document.createElement('style');
	css.textContent =
		'#webdemo{position:fixed;left:16px;top:16px;z-index:50;display:flex;flex-direction:column;gap:8px;align-items:flex-start;font:500 13px/1.3 ui-monospace,Consolas,monospace;color:#e8eefc;transition:opacity .4s}' +
		'#webdemo.hide{opacity:0;pointer-events:none}' +
		'#webdemo .row{display:flex;gap:6px;flex-wrap:wrap}' +
		'#webdemo [hidden],#wd-drawer [hidden]{display:none!important}' +
		'#webdemo button,#webdemo a,#webdemo label,#wd-drawer .btn{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border-radius:8px;border:1px solid rgba(232,238,252,.25);background:rgba(10,15,30,.72);color:#e8eefc;font:inherit;cursor:pointer;text-decoration:none;backdrop-filter:blur(6px)}' +
		'#webdemo button:hover,#webdemo a:hover,#webdemo label:hover,#wd-drawer .btn:hover{border-color:rgba(232,238,252,.6)}' +
		'#webdemo button[aria-pressed=true],#wd-drawer .btn[aria-pressed=true]{background:#e8eefc;color:#0a0f1e}' +
		'#webdemo :focus-visible,#webdemo label:focus-within,#wd-drawer :focus-visible{outline:2px solid #fdba74;outline-offset:2px}' +
		'#webdemo .note{max-width:340px;padding:6px 10px;border-radius:8px;background:rgba(10,15,30,.8)}' +
		'#webdemo input[type=file]{position:absolute;width:1px;height:1px;opacity:0}' +
		'#wd-drawer{position:fixed;top:0;right:0;bottom:0;width:min(380px,100vw);z-index:60;overflow-y:auto;background:rgba(8,12,24,.95);backdrop-filter:blur(10px);color:#e8eefc;font:14px/1.45 system-ui,"Segoe UI",sans-serif;border-left:1px solid rgba(232,238,252,.15);box-sizing:border-box;padding:0 0 24px}' +
		'#wd-drawer *{box-sizing:border-box}' +
		'#wd-drawer .head{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:rgba(8,12,24,.98);border-bottom:1px solid rgba(232,238,252,.12)}' +
		'#wd-drawer h2{margin:0;font-size:17px;font-weight:600}' +
		'#wd-drawer .box{margin:14px 16px;padding:14px;border:1px solid rgba(232,238,252,.15);border-radius:10px;display:flex;flex-direction:column;gap:10px}' +
		'#wd-drawer .box h3{margin:0;font-size:15px}' +
		'#wd-drawer .muted{color:#a9b4c8;font-size:13px;margin:0}' +
		'#wd-drawer .btns{display:flex;gap:6px;flex-wrap:wrap}' +
		'#wd-drawer details{margin:0 16px;border-bottom:1px solid rgba(232,238,252,.1)}' +
		'#wd-drawer summary{cursor:pointer;padding:12px 0;font-weight:600;list-style-position:outside}' +
		'#wd-drawer .set{display:flex;flex-direction:column;gap:4px;padding:8px 0}' +
		'#wd-drawer .set.inline{flex-direction:row;align-items:center;justify-content:space-between;gap:12px}' +
		'#wd-drawer .set label{font-size:13.5px}' +
		'#wd-drawer .set .hint{font-size:12px;color:#a9b4c8}' +
		'#wd-drawer .set .val{float:right;font-family:ui-monospace,Consolas,monospace;color:#a9b4c8}' +
		'#wd-drawer input[type=range]{width:100%;accent-color:#fdba74}' +
		'#wd-drawer input[type=checkbox]{width:20px;height:20px;accent-color:#fdba74;flex:none}' +
		'#wd-drawer select,#wd-drawer input[type=text]{width:100%;min-height:34px;padding:4px 8px;border-radius:6px;border:1px solid rgba(232,238,252,.25);background:#111a2e;color:#e8eefc;font:inherit}' +
		'#wd-drawer input[type=color]{width:44px;height:30px;padding:0;border:1px solid rgba(232,238,252,.25);border-radius:6px;background:none}' +
		'#wd-drawer .foot{margin:16px}';
	document.head.appendChild(css);

	var panel = document.createElement('div');
	panel.id = 'webdemo';
	panel.innerHTML =
		'<div class="note" id="wd-note" role="status" hidden></div>' +
		'<div class="row">' +
		'<button type="button" id="wd-demo">Demo song</button>' +
		'<label id="wd-file-l">Play your own music<input type="file" id="wd-file" accept="audio/*"></label>' +
		'<button type="button" id="wd-mic">Use microphone</button>' +
		'<button type="button" id="wd-spotify">Spotify</button>' +
		'<button type="button" id="wd-pause" hidden>Pause</button>' +
		'</div>' +
		'<div class="row" id="wd-sprow" hidden>' +
		'<button type="button" id="wd-screen">Bars follow computer sound</button>' +
		'<button type="button" id="wd-spmic">Bars follow microphone</button>' +
		'<button type="button" id="wd-stoplisten" hidden>Stop listening</button>' +
		'</div>' +
		'<div class="row">' +
		'<button type="button" id="wd-open" aria-expanded="false" aria-controls="wd-drawer">Settings</button>' +
		'<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3840312660" target="_blank" rel="noopener">Get it on Steam Workshop</a>' +
		'<a href="https://github.com/slazhz/ascii-music-visualizer" target="_blank" rel="noopener">Source on GitHub</a>' +
		'</div>';
	document.body.appendChild(panel);

	var drawer = document.createElement('aside');
	drawer.id = 'wd-drawer';
	drawer.hidden = true;
	drawer.setAttribute('aria-label', 'Settings');
	drawer.innerHTML =
		'<div class="head"><h2>Settings</h2><button type="button" class="btn" id="wd-close">Close</button></div>' +
		'<section class="box" id="wd-spbox">' +
		'<h3>Spotify</h3>' +
		'<p class="muted" id="wd-spstatus"></p>' +
		'<div class="btns"><button type="button" class="btn" id="wd-spconnect">Connect Spotify</button><button type="button" class="btn" id="wd-spshow" hidden>Show Spotify</button><button type="button" class="btn" id="wd-spout" hidden>Disconnect</button></div>' +
		'<p class="muted">Spotify only lets approved accounts sign in to this demo. Bars can follow your computer’s sound: share your entire screen and turn on “Also share system audio”.</p>' +
		'</section>' +
		'<div id="wd-groups"><p class="muted" style="margin:16px">Loading settings…</p></div>' +
		'<div class="foot"><button type="button" class="btn" id="wd-reset">Reset all settings</button></div>';
	document.body.appendChild(drawer);

	// Clicks on the controls must not spin the cover underneath them.
	[panel, drawer].forEach(function (el) {
		['mousedown', 'mouseup'].forEach(function (ev) { el.addEventListener(ev, function (e) { e.stopPropagation(); }); });
	});

	var noteTimer = 0;
	function $(id) { return document.getElementById(id); }
	function note(text) {
		var el = $('wd-note'); el.textContent = text; el.hidden = false;
		wake();
		clearTimeout(noteTimer); noteTimer = setTimeout(function () { el.hidden = true; }, 7000);
	}
	function spStatus(text) { SP.status = text; var el = $('wd-spstatus'); if (el) el.textContent = text; }
	function syncUi() {
		var connected = !!SP.token;
		$('wd-demo').setAttribute('aria-pressed', String(mode === 'demo'));
		$('wd-mic').setAttribute('aria-pressed', String(mode === 'mic'));
		$('wd-spotify').setAttribute('aria-pressed', String(mode === 'spotify'));
		$('wd-spotify').hidden = !connected; // visitors connect from Settings (Spotify only allows approved accounts)
		$('wd-pause').hidden = mode !== 'file';
		if (audioEl) $('wd-pause').textContent = audioEl.paused ? 'Play' : 'Pause';
		$('wd-sprow').hidden = mode !== 'spotify';
		$('wd-screen').setAttribute('aria-pressed', String(listen === 'screen'));
		$('wd-spmic').setAttribute('aria-pressed', String(listen === 'mic'));
		$('wd-stoplisten').hidden = !(mode === 'spotify' && (listen === 'screen' || listen === 'mic'));
		$('wd-spconnect').hidden = connected;
		$('wd-spshow').hidden = !connected || mode === 'spotify';
		$('wd-spout').hidden = !connected;
		if (!SP.status) spStatus(!CFG.spotifyClientId ? 'Spotify isn’t set up yet: add your Client ID to js/web-config.js.' : connected ? 'Connected.' : 'Not connected.');
	}

	$('wd-demo').addEventListener('click', backToDemo);
	$('wd-mic').addEventListener('click', function () { if (mode === 'spotify') backToDemo(); useMic(); });
	$('wd-file').addEventListener('change', function (e) { playFile(e.target.files[0]); e.target.value = ''; });
	$('wd-pause').addEventListener('click', function () { if (!audioEl) return; if (audioEl.paused) audioEl.play(); else audioEl.pause(); });
	$('wd-spotify').addEventListener('click', function () { if (SP.token) startSpotify(); else { openDrawer(); spLogin(); } });
	$('wd-screen').addEventListener('click', useScreenAudio);
	$('wd-spmic').addEventListener('click', useMic);
	$('wd-stoplisten').addEventListener('click', function () { stopAudio(); syncUi(); });
	$('wd-spconnect').addEventListener('click', spLogin);
	$('wd-spshow').addEventListener('click', function () { startSpotify(); });
	$('wd-spout').addEventListener('click', disconnectSpotify);
	$('wd-open').addEventListener('click', function () { if (drawer.hidden) openDrawer(); else closeDrawer(); });
	$('wd-close').addEventListener('click', closeDrawer);
	drawer.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

	function openDrawer() { drawer.hidden = false; $('wd-open').setAttribute('aria-expanded', 'true'); $('wd-close').focus(); }
	function closeDrawer() { drawer.hidden = true; $('wd-open').setAttribute('aria-expanded', 'false'); $('wd-open').focus(); }

	// Drop a file anywhere on the page.
	window.addEventListener('dragover', function (e) { e.preventDefault(); });
	window.addEventListener('drop', function (e) {
		e.preventDefault();
		var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
		if (f && /^audio\//.test(f.type)) playFile(f);
	});

	// Fade the panel out when the mouse is still; embedded pages can hide it with ?ui=0.
	var hideTimer = 0, uiOff = /[?&]ui=0\b/.test(location.search);
	function wake() {
		if (uiOff) return;
		panel.classList.remove('hide');
		clearTimeout(hideTimer);
		hideTimer = setTimeout(function () {
			if (!panel.matches(':hover') && !panel.contains(document.activeElement)) panel.classList.add('hide');
		}, 3500);
	}
	if (uiOff) panel.classList.add('hide');
	['mousemove', 'touchstart', 'keydown'].forEach(function (ev) { window.addEventListener(ev, wake, { passive: true }); });

	// ---------- Settings, built from the wallpaper's own project.json ----------
	var HIDDEN = { helperport: 1, canvaslayout: 1, onlinealbums: 1 }; // need the desktop helper, or handled automatically here
	var HINTS = { showlyrics: 'Synced lyrics from LRCLIB for the song playing on Spotify.' };
	var GROUPS = [
		[100, 'ASCII and colour'], [200, 'Audio and bars'], [300, 'Image'], [380, 'Title, cover and card'],
		[410, 'Custom text'], [420, 'Lyrics'], [430, 'Clock']
	];
	var props = null, defaults = {}, vals = {}, rows = {}, SAVE_KEY = 'acv-web-settings';

	function textOf(html) { return new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent.trim(); }
	function label(p) {
		var t = String(p.text || ''), hint = (t.match(/<small>([\s\S]*?)<\/small>/i) || [])[1] || '';
		return { main: textOf(t.replace(/<small>[\s\S]*?<\/small>/gi, '').replace(/<br\s*\/?>/gi, ' ')), hint: textOf(hint) };
	}
	function lit(s) {
		if (s === 'true') return true;
		if (s === 'false') return false;
		if (/^(['"]).*\1$/.test(s)) return s.slice(1, -1);
		var n = Number(s); return isNaN(n) ? s : n;
	}
	// Wallpaper Engine conditions, e.g. "showbars.value == true && barpreset.value == 'custom'".
	function visible(expr) {
		if (!expr) return true;
		return expr.split('&&').every(function (part) {
			var m = part.trim().match(/^(\w+)\.value\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
			if (!m) return true;
			var a = vals[m[1]], b = lit(m[3].trim());
			switch (m[2]) {
				case '==': return a == b; // eslint-disable-line eqeqeq
				case '!=': return a != b; // eslint-disable-line eqeqeq
				case '>': return a > b; case '<': return a < b;
				case '>=': return a >= b; default: return a <= b;
			}
		});
	}
	function toHex(v) {
		var c = ACV.parseColor(v) || [1, 1, 1];
		return '#' + c.map(function (x) { var h = Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16); return h.length < 2 ? '0' + h : h; }).join('');
	}
	function save() {
		var out = {};
		Object.keys(vals).forEach(function (k) { if (vals[k] !== defaults[k]) out[k] = vals[k]; });
		store.set(SAVE_KEY, out);
	}
	function set(key, v) {
		vals[key] = v;
		var o = {}; o[key] = v;
		ACV.applySettings(o);
		save();
		refresh();
	}
	function refresh() {
		Object.keys(rows).forEach(function (k) { rows[k].hidden = !visible(props[k].condition); });
	}

	function control(key, p) {
		var L = label(p), id = 'wd-s-' + key, row = document.createElement('div'), lab = document.createElement('label');
		row.className = 'set';
		lab.htmlFor = id;
		lab.textContent = L.main;
		var hintText = HINTS[key] || L.hint, input;
		if (p.type === 'bool') {
			row.className = 'set inline';
			input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!vals[key];
			input.addEventListener('change', function () { set(key, input.checked); });
			row.appendChild(lab); row.appendChild(input);
		} else if (p.type === 'slider') {
			var out = document.createElement('span'); out.className = 'val'; out.textContent = vals[key];
			lab.appendChild(out);
			input = document.createElement('input'); input.type = 'range';
			input.min = p.min; input.max = p.max; input.step = p.step || 1; input.value = vals[key];
			input.addEventListener('input', function () { out.textContent = input.value; set(key, Number(input.value)); });
			row.appendChild(lab); row.appendChild(input);
		} else if (p.type === 'combo') {
			input = document.createElement('select');
			(p.options || []).forEach(function (o) {
				var opt = document.createElement('option'); opt.value = o.value; opt.textContent = textOf(o.label || o.value);
				if (String(o.value) === String(vals[key])) opt.selected = true;
				input.appendChild(opt);
			});
			input.addEventListener('change', function () { set(key, input.value); });
			row.appendChild(lab); row.appendChild(input);
		} else if (p.type === 'color') {
			row.className = 'set inline';
			input = document.createElement('input'); input.type = 'color'; input.value = toHex(vals[key]);
			input.addEventListener('input', function () { set(key, input.value); });
			row.appendChild(lab); row.appendChild(input);
		} else if (p.type === 'textinput') {
			input = document.createElement('input'); input.type = 'text'; input.value = vals[key] == null ? '' : vals[key];
			var t = 0;
			input.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { set(key, input.value); }, 300); });
			row.appendChild(lab); row.appendChild(input);
		} else return null;
		input.id = id;
		if (hintText) {
			var h = document.createElement('span'); h.className = 'hint'; h.textContent = hintText;
			if (row.className === 'set inline') { var wrap = document.createElement('div'); wrap.style.display = 'flex'; wrap.style.flexDirection = 'column'; wrap.appendChild(lab); wrap.appendChild(h); row.insertBefore(wrap, input); }
			else row.appendChild(h);
		}
		return row;
	}

	function build() {
		var box = $('wd-groups');
		box.textContent = '';
		rows = {};
		var keys = Object.keys(props).filter(function (k) { return !HIDDEN[k]; })
			.sort(function (a, b) { return (props[a].order || 0) - (props[b].order || 0); });
		GROUPS.forEach(function (g, gi) {
			var lo = g[0], hi = GROUPS[gi + 1] ? GROUPS[gi + 1][0] : Infinity;
			var mine = keys.filter(function (k) { var o = props[k].order || 0; return o >= lo && o < hi; });
			if (!mine.length) return;
			var det = document.createElement('details'), sum = document.createElement('summary');
			sum.textContent = g[1];
			det.appendChild(sum);
			if (gi === 0) det.open = true;
			mine.forEach(function (k) { var r = control(k, props[k]); if (r) { rows[k] = r; det.appendChild(r); } });
			box.appendChild(det);
		});
		refresh();
	}

	function applyAll() {
		var flat = {};
		Object.keys(vals).forEach(function (k) { if (!HIDDEN[k]) flat[k] = vals[k]; });
		ACV.applySettings(flat);
	}

	$('wd-reset').addEventListener('click', function () {
		store.set(SAVE_KEY, null);
		vals = Object.assign({}, defaults);
		applyAll();
		build();
		note('Settings reset to the defaults.');
	});

	fetch('project.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (pj) {
		props = (pj.general && pj.general.properties) || {};
		Object.keys(props).forEach(function (k) {
			var p = props[k], v = p.value;
			if (p.type === 'slider') v = Number(v);
			if (p.type === 'bool') v = v === true || v === 'true';
			defaults[k] = v;
		});
		vals = Object.assign({}, defaults, store.get(SAVE_KEY) || {});
		applyAll();
		build();
	}).catch(function () {
		$('wd-groups').innerHTML = '<p class="muted" style="margin:16px">Settings couldn’t be loaded.</p>';
	});

	// ---------- Start ----------
	syncUi();
	wake();
	handleRedirect().then(function (connected) {
		if (connected === 'leaving') return;
		if (connected || (SP.token && store.get('acv-web-mode') === 'spotify')) startSpotify();
		else backToDemo();
	});
})();

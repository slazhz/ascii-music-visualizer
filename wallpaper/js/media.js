/* Media: now-playing info from Wallpaper Engine (Windows media controls) plus the
   local helper (track ID, high-res cover, Spotify Canvas video). */
window.ACV = window.ACV || {};

(function () {
	var M = ACV.media = {
		we: { title: '', artist: '', album: '', thumbnail: null, colors: null, playing: true, position: 0, duration: 0, timelineAt: 0, enabled: true },
		helper: { connected: false, state: null },
		_handlers: []
	};
	M.onChange = function (fn) { M._handlers.push(fn); };
	function emit() { if (M.sendNowPlaying) M.sendNowPlaying(); M._handlers.forEach(function (fn) { fn(); }); }

	// ---- Wallpaper Engine media integration (register immediately) ----
	function reg(name, fn) { if (typeof window[name] === 'function') window[name](fn); }

	reg('wallpaperRegisterMediaStatusListener', function (e) { M.we.enabled = !!e.enabled; emit(); });
	reg('wallpaperRegisterMediaPropertiesListener', function (e) {
		M.we.title = e.title || '';
		M.we.artist = e.artist || '';
		M.we.album = e.albumTitle || '';
		emit();
	});
	reg('wallpaperRegisterMediaThumbnailListener', function (e) {
		M.we.thumbnail = e.thumbnail || null;
		M.we.colors = {
			primary: ACV.parseColor(e.primaryColor),
			secondary: ACV.parseColor(e.secondaryColor),
			tertiary: ACV.parseColor(e.tertiaryColor),
			text: ACV.parseColor(e.textColor)
		};
		emit();
	});
	reg('wallpaperRegisterMediaPlaybackListener', function (e) {
		var I = window.wallpaperMediaIntegration || {};
		var playing = I.PLAYBACK_PLAYING !== undefined ? e.state === I.PLAYBACK_PLAYING
			: (I.playback && I.playback.PLAYING !== undefined) ? e.state === I.playback.PLAYING
			: e.state === 1;
		M.we.playing = playing;
		emit();
	});
	reg('wallpaperRegisterMediaTimelineListener', function (e) {
		M.we.position = e.position || 0;
		M.we.duration = e.duration || 0;
		M.we.timelineAt = performance.now();
	});

	// ---- What this browser can decode (Wallpaper Engine's CEF has no H.264) ----
	var probe = document.createElement('video');
	M.canPlay = {
		h264: !!probe.canPlayType('video/mp4; codecs="avc1.42E01E"'),
		vp9: !!probe.canPlayType('video/webm; codecs="vp9"')
	};

	// Send diagnostics to the helper so they show on its status page.
	M.report = function (event) {
		if (!M.helper.connected) return;
		var q = 'v=' + (ACV.VERSION || 0) + '&h264=' + (M.canPlay.h264 ? 1 : 0) + '&vp9=' + (M.canPlay.vp9 ? 1 : 0);
		if (event) q += '&event=' + encodeURIComponent(String(event).slice(0, 200));
		// A plain GET, the same kind of request as the event stream that already works.
		try { fetch(M.helperBase() + '/diag?' + q, { mode: 'no-cors', cache: 'no-store' }).catch(function () {}); } catch (e) { /* ignore */ }
	};

	// Tell the helper what Windows says is playing (used when Spicetify isn't installed).
	var lastNp = '';
	M.sendNowPlaying = function (force) {
		if (!M.helper.connected || !M.we.title) return;
		var q = 'title=' + encodeURIComponent(M.we.title) + '&artist=' + encodeURIComponent(M.we.artist || '') +
			'&album=' + encodeURIComponent(M.we.album || '') + '&playing=' + (M.we.playing ? 1 : 0);
		if (q === lastNp && !force) return;
		lastNp = q;
		try { fetch(M.helperBase() + '/np?' + q, { mode: 'no-cors', cache: 'no-store' }).catch(function () {}); } catch (e) { /* ignore */ }
	};

	// ---- Local helper (Server-Sent Events) ----
	var es = null, port = null;
	M.helperBase = function () { return 'http://127.0.0.1:' + (ACV.settings.helperPort || 7777); };

	function connect() {
		if (es) { es.close(); es = null; }
		M.helper.connected = false;
		if (typeof EventSource === 'undefined') { emit(); return; }
		port = ACV.settings.helperPort;
		try {
			es = new EventSource(M.helperBase() + '/events');
		} catch (e) { return; }
		es.onopen = function () { M.helper.connected = true; M.report(); M.sendNowPlaying(true); emit(); };
		es.onmessage = function (ev) {
			try { M.helper.state = JSON.parse(ev.data); } catch (e) { return; }
			M.helper.connected = true;
			emit();
		};
		es.onerror = function () {
			if (M.helper.connected) { M.helper.connected = false; emit(); }
			// EventSource retries automatically (the helper sets retry: 3000).
		};
	}
	ACV.onSettings(function (changed) {
		if (changed.indexOf('helperPort') >= 0 && ACV.settings.helperPort !== port) connect();
	});

	// ---- What should be on screen right now? ----
	function norm(s) {
		return (s || '').toLowerCase().replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ').replace(/[^a-z0-9À-￿]+/g, ' ').trim();
	}

	M.current = function () {
		var we = M.we, h = M.helper.connected ? M.helper.state : null;
		var hasWe = !!we.title;
		var match = false;
		if (h && h.trackId && h.title) {
			if (!hasWe) match = true;
			else {
				var a = norm(we.title), b = norm(h.title);
				match = a === b || (a.length > 3 && b.length > 3 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0));
			}
		}
		var base = M.helperBase();
		var cover = null;
		if (match && h.hasCover) cover = base + '/cover/' + h.trackId;
		else if (we.thumbnail) cover = we.thumbnail;

		var playing = hasWe ? we.playing : (h ? h.playing !== false : true);
		return {
			key: (match ? h.trackId : '') + '|' + (we.title || (h && h.title) || ''),
			title: we.title || (h && h.title) || '',
			artist: we.artist || (h && h.artist) || '',
			albumName: we.album || (h && h.albumName) || '',
			cover: cover,
			coverIsCrossOrigin: !!(match && h.hasCover),
			canvas: (match && h.hasCanvas && ACV.settings.canvasLayout !== 'off') ? base + '/video/' + h.trackId + (M.canPlay.h264 ? '' : '?fmt=webm') : null,
			album: (match && h.album && h.album.tracks && h.album.tracks.length) ? h.album
				: (ACV.albums && ACV.settings.directAlbums !== false && hasWe ? ACV.albums.get({ title: we.title, artist: we.artist, album: we.album }, emit) : null),
			trackUri: match ? 'spotify:track:' + h.trackId : '',
			colors: we.colors,
			playing: playing,
			helperConnected: M.helper.connected
		};
	};

	M.progress = function () {
		var we = M.we;
		if (!we.duration) return -1;
		var pos = we.position + (we.playing ? (performance.now() - we.timelineAt) / 1000 : 0);
		return Math.max(0, Math.min(1, pos / we.duration));
	};

	// Connect once the page has loaded so settings from Wallpaper Engine are applied first.
	if (document.readyState === 'complete') setTimeout(connect, 0);
	else window.addEventListener('load', function () { setTimeout(connect, 0); });
})();

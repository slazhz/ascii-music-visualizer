/*
 * Album tracklists straight from the wallpaper — no helper, no local port.
 * Uses the song info Wallpaper Engine already gives us (title / artist / album) and asks
 * Deezer's public API, then iTunes, via JSONP (a <script> request), which works from a
 * file:// page without CORS.
 */
(function () {
	'use strict';
	var ACV = window.ACV = window.ACV || {};
	var cache = {}, pending = {}, missUntil = {}, seq = 0;

	function norm(s) {
		return String(s || '').toLowerCase()
			.replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ')
			.replace(/\s+-\s+.*$/, '')
			.replace(/[^a-z0-9À-￿]+/g, ' ').trim();
	}
	function firstArtist(a) { return String(a || '').split(/,|&| feat\.? | ft\.? | x /i)[0].trim(); }
	function similar(a, b) {
		a = norm(a); b = norm(b);
		if (!a || !b) return false;
		return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
	}

	// JSONP request: resolves with the parsed object, or rejects after a timeout.
	function jsonp(url, cbParam) {
		return new Promise(function (resolve, reject) {
			var name = '__acvJsonp' + (++seq), s = document.createElement('script'), done = false;
			function clean() { done = true; try { delete window[name]; } catch (e) { window[name] = undefined; } if (s.parentNode) s.parentNode.removeChild(s); }
			window[name] = function (data) { if (done) return; clean(); resolve(data); };
			s.onerror = function () { if (done) return; clean(); reject(new Error('network')); };
			setTimeout(function () { if (done) return; clean(); reject(new Error('timeout')); }, 9000);
			s.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + cbParam + '=' + name;
			document.head.appendChild(s);
		});
	}
	function deezer(path) { return jsonp('https://api.deezer.com/' + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'output=jsonp', 'callback'); }
	function itunes(path) { return jsonp('https://itunes.apple.com/' + path, 'callback'); }

	function score(item, art, title, album) {
		var sc = 0, an = item.artist && item.artist.name;
		if (similar(an, art)) sc += 4; else return -1;
		if (title && similar(item.title, title)) sc += 3;
		if (album && item.album && similar(item.album.title, album)) sc += 3;
		if (album && item.title && !item.album && similar(item.title, album)) sc += 3;
		return sc;
	}

	function fromDeezer(info) {
		var art = firstArtist(info.artist), title = info.title, album = info.album;
		var tries = [];
		if (title) tries.push(['search', art + ' ' + (norm(title) || title)]);
		if (album) tries.push(['search/album', art + ' ' + (norm(album) || album)]);
		if (title) tries.push(['search', norm(title) || title]);
		var albumId = null, best = -1;
		function step(i) {
			if (i >= tries.length || best >= 10 || (albumId && (!album || best >= 7))) return Promise.resolve(albumId);
			var path = tries[i][0], q = tries[i][1];
			return deezer(path + '?limit=25&q=' + encodeURIComponent(q)).then(function (j) {
				(j && j.data || []).forEach(function (it) {
					var sc = score(it, art, path === 'search' ? title : null, album);
					var id = path === 'search' ? it.album && it.album.id : it.id;
					if (id && sc > best && (sc >= 7 || (sc >= 4 && path === 'search/album'))) { best = sc; albumId = id; }
				});
				return step(i + 1);
			});
		}
		return step(0).then(function (id) {
			if (!id) return null;
			return deezer('album/' + id).then(function (a) {
				if (!a || a.error) return null;
				var tracks = (a.tracks && a.tracks.data) || [];
				var more = a.nb_tracks > tracks.length
					? deezer('album/' + id + '/tracks?limit=200').then(function (t) { return (t && t.data) || tracks; }, function () { return tracks; })
					: Promise.resolve(tracks);
				return more.then(function (list) {
					return {
						uri: 'deezer:album:' + id,
						name: a.title || album || '',
						year: (a.release_date || '').slice(0, 4),
						artist: (a.artist && a.artist.name) || '',
						label: a.label || '',
						genre: (a.genres && a.genres.data && a.genres.data[0] && a.genres.data[0].name) || '',
						country: '',
						source: 'Deezer',
						tracks: list.map(function (t, i) { return { n: t.track_position || i + 1, d: t.disk_number || 1, title: t.title, ms: (t.duration || 0) * 1000, uri: '' }; })
					};
				});
			});
		});
	}

	function fromItunes(info) {
		var art = firstArtist(info.artist), title = info.title, album = info.album;
		var countries = ['th', 'us'];
		function tryCountry(ci) {
			if (ci >= countries.length) return Promise.resolve(null);
			var c = countries[ci];
			var find = album
				? itunes('search?entity=album&limit=15&country=' + c + '&term=' + encodeURIComponent(art + ' ' + album)).then(function (j) {
					return (j.results || []).filter(function (r) { return similar(r.artistName, art) && similar(r.collectionName, album); })[0] || null;
				})
				: Promise.resolve(null);
			return find.then(function (hit) {
				if (hit || !title) return hit;
				return itunes('search?entity=song&limit=15&country=' + c + '&term=' + encodeURIComponent(art + ' ' + title)).then(function (j) {
					return (j.results || []).filter(function (r) { return similar(r.artistName, art) && similar(r.trackName, title); })[0] || null;
				});
			}).then(function (hit) {
				if (!hit) return tryCountry(ci + 1);
				return itunes('lookup?entity=song&limit=200&country=' + c + '&id=' + hit.collectionId).then(function (l) {
					var res = l.results || [];
					var coll = res.filter(function (r) { return r.wrapperType === 'collection'; })[0] || hit;
					var songs = res.filter(function (r) { return r.wrapperType === 'track'; });
					if (!songs.length) return tryCountry(ci + 1);
					return {
						uri: 'itunes:album:' + hit.collectionId,
						name: coll.collectionName || album || '',
						year: (coll.releaseDate || '').slice(0, 4),
						artist: coll.artistName || '',
						label: '',
						genre: coll.primaryGenreName || '',
						country: coll.country || '',
						source: 'iTunes',
						tracks: songs.map(function (s) { return { n: s.trackNumber, d: s.discNumber || 1, title: s.trackName, ms: s.trackTimeMillis || 0, uri: '' }; })
					};
				});
			});
		}
		return tryCountry(0);
	}

	// Returns the album right away if we already have it; otherwise starts a lookup and calls onReady when done.
	ACV.albums = {
		get: function (info, onReady) {
			if (!info || !info.artist || !(info.title || info.album)) return null;
			var key = norm(firstArtist(info.artist)) + '|' + norm(info.album || info.title);
			if (cache[key]) return cache[key];
			if (!pending[key] && !(missUntil[key] > Date.now())) {
				pending[key] = true;
				fromDeezer(info).catch(function () { return null; }).then(function (a) {
					return a || fromItunes(info).catch(function () { return null; });
				}).then(function (a) {
					delete pending[key];
					if (a && a.tracks && a.tracks.length) { cache[key] = a; if (onReady) onReady(a); }
					else missUntil[key] = Date.now() + 120000; // not found / offline: try again in 2 minutes
				});
			}
			return null;
		}
	};
})();

/* Main: builds the composite image (Canvas video or cover + bars), feeds it to the
   ASCII renderer, and keeps the now-playing card in sync. */
(function () {
	var S = ACV.settings, A = ACV.audio, M = ACV.media;
	var B = ACV.barSettings(); // effective bar settings (mode or custom sliders)

	var glCanvas = document.getElementById('gl');
	var overlay = document.getElementById('bars');
	var octx = overlay.getContext('2d');
	var overlayUsed = false;
	var comp = document.createElement('canvas');
	var cctx = comp.getContext('2d', { willReadFrequently: true });
	var textCanvas = document.createElement('canvas');
	var tctx = textCanvas.getContext('2d');
	var barsCanvas = document.createElement('canvas');
	var bctx = barsCanvas.getContext('2d');
	var ascii;
	try {
		ascii = new ACV.Ascii(glCanvas);
	} catch (e) {
		document.body.classList.add('no-webgl');
		console.error(e);
		return;
	}

	// ---------- fonts: a modern Thai font served by the helper (falls back to Windows' Leelawadee UI) ----------
	var THAI_RANGE = 'U+0E00-0E7F, U+200C-200D, U+25CC';
	var FONT_DEFS = {
		anuphan: [{ key: 'anuphan', w: '100 900' }],
		noto: [{ key: 'noto', w: '100 900', thaiOnly: true }],
		plex: [{ key: 'plex-400', w: '400' }, { key: 'plex-700', w: '700' }],
		kanit: [{ key: 'kanit-400', w: '400' }, { key: 'kanit-700', w: '700' }],
		prompt: [{ key: 'prompt-400', w: '400' }, { key: 'prompt-700', w: '700' }],
		system: []
	};
	function applyFonts() {
		var defs = FONT_DEFS[S.thaiFont] || FONT_DEFS.anuphan, base = M.helperBase();
		var css = defs.map(function (d) {
			return '@font-face{font-family:"ACV Thai";src:url("' + base + '/font/' + d.key + '") format("truetype");font-weight:' + d.w +
				';font-display:swap;' + (d.thaiOnly ? 'unicode-range:' + THAI_RANGE + ';' : '') + '}';
		}).join('\n');
		if (defs.length) css += '\n:root{--thai:"ACV Thai";}';
		document.getElementById('acv-fonts').textContent = css;
		tlLayoutKey = '';
	}
	ACV.onSettings(function (changed) { if (changed.indexOf('thaiFont') >= 0 || changed.indexOf('helperPort') >= 0) applyFonts(); });

	// ---------- layout ----------
	var W = 0, H = 0, cellW = 7, cellH = 12, cols = 1, rows = 1, atlasKey = '';

	function charsetString() {
		if (S.charset === 'custom') return S.customChars && S.customChars.length > 1 ? S.customChars : ' .oO0@';
		return ACV.CHARSETS[S.charset] || ACV.CHARSETS.standard;
	}

	function layout() {
		var dpr = window.devicePixelRatio || 1;
		W = Math.max(1, Math.round(window.innerWidth * dpr));
		H = Math.max(1, Math.round(window.innerHeight * dpr));
		glCanvas.width = W; glCanvas.height = H;

		cellH = Math.max(4, Math.round(S.cellSize * dpr));
		cellW = Math.max(3, Math.round(cellH * 0.6));
		cols = Math.ceil(W / cellW);
		rows = Math.ceil(H / cellH);

		if (S.ascii) { comp.width = cols; comp.height = rows; }
		else { comp.width = Math.round(W / 1.5); comp.height = Math.round(H / 1.5); }

		var key = charsetString() + '|' + cellW + 'x' + cellH;
		if (key !== atlasKey) { ascii.buildAtlas(charsetString(), cellW, cellH); atlasKey = key; }
	}
	window.addEventListener('resize', layout);
	ACV.onSettings(function (changed) {
		if (changed.some(function (k) { return ['cellSize', 'charset', 'customChars', 'ascii'].indexOf(k) >= 0; })) layout();
		applyCardSettings();
		if (changed.some(function (k) { return ['titleStyle', 'headingStyle', 'artSize', 'artColor', 'thaiFont'].indexOf(k) >= 0; })) { tlKey = ''; tlArtKey = ''; btArtKey = ''; ckKey = ''; btAKey = ''; lyKey = ''; cardArtKey = ''; if (lastC) updateCard(lastC); }
		if (changed.some(function (k) { return /^text/.test(k); })) bgKey = '';
		if (changed.indexOf('canvasLayout') >= 0 || tlKey === '' || changed.some(function (k) { return /^text/.test(k); })) refresh();
	});

	// ---------- sources: one crossfading stack for the cover, one for the canvas video ----------
	var failedVideos = {}; // canvas URLs that couldn't play, so we don't retry them on every update
	var FADE = 0.9;        // seconds

	function loadImage(src, cross) {
		return new Promise(function (resolve, reject) {
			var img = new Image();
			if (cross) img.crossOrigin = 'anonymous';
			img.onload = function () { resolve(img); };
			img.onerror = reject;
			img.src = src;
		});
	}

	function loadVideo(src) {
		return new Promise(function (resolve, reject) {
			var v = document.createElement('video');
			v.crossOrigin = 'anonymous';
			v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
			v.preload = 'auto';
			var done = false;
			// WebM may need converting first on the helper side, so allow a while.
			var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('video timeout')); } }, 45000);
			v.addEventListener('canplay', function () {
				if (done) return; done = true; clearTimeout(timer);
				var p = v.play(); if (p && p.catch) p.catch(function () {});
				resolve(v);
			});
			v.addEventListener('error', function () {
				if (done) return; done = true; clearTimeout(timer);
				var code = v.error ? v.error.code : '?', msg = v.error && v.error.message ? v.error.message : '';
				reject(new Error('video error ' + code + (msg ? ' (' + msg + ')' : '')));
			});
			v.src = src;
		});
	}

	function webmOf(src) { return src.indexOf('fmt=webm') >= 0 ? src : src + (src.indexOf('?') < 0 ? '?' : '&') + 'fmt=webm'; }
	function dropVideo(el) { try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) { /* ignore */ } }

	function Stack(isVideo) { this.isVideo = isVideo; this.layers = []; this.src = null; }
	Stack.prototype.set = function (src, cross, slide) {
		var self = this;
		if (src === this.src) return;
		this.src = src;
		if (!src) { this.layers.forEach(function (l) { l.target = 0; }); return; }
		(this.isVideo ? loadVideo(src) : loadImage(src, cross)).then(function (el) {
			if (self.src !== src) { if (self.isVideo) dropVideo(el); return; }
			// New cover: take its colours right away (bars, palette, back of the sleeve).
			if (!self.isVideo) { albumColors = extractAlbumColors(el); paletteSrc = null; barColsCache = null; updateTlAccent(); bgKey = ''; }
			// slide = a new song (slide in/out); otherwise the same song got a better cover: swap in place.
			var last = self.layers[self.layers.length - 1];
			if (!slide && last && last.slide && last.target === 1 && last.alpha < 1) {
				// A sharper cover arrived while the new song is still sliding in: take over its place in the slide.
				self.layers.pop();
				self.layers.push({ el: el, alpha: last.alpha, target: 1, born: last.born, slide: true });
				return;
			}
			self.layers.forEach(function (l) { l.target = 0; l.slide = !!slide; });
			self.layers.push({ el: el, alpha: 0, target: 1, born: performance.now(), slide: !!slide });
			if (slide) ACV._slides = (ACV._slides || 0) + 1;
			if (self.isVideo) M.report('canvas playing (' + (src.indexOf('fmt=webm') >= 0 ? 'WebM' : 'MP4') + ')');
		}).catch(function (err) {
			if (self.src !== src || !self.isVideo) return;
			M.report('canvas failed: ' + err.message + ' — ' + src.replace(/^.*\/video\//, ''));
			failedVideos[src] = true;
			self.src = null;
			var alt = webmOf(src); // MP4 failed: try the WebM version once
			if (alt !== src && !failedVideos[alt]) self.set(alt, true);
			else self.set(null);
		});
	};
	Stack.prototype.update = function (dt) {
		var step = dt / FADE, self = this;
		for (var i = this.layers.length - 1; i >= 0; i--) {
			var L = this.layers[i];
			L.alpha += Math.sign(L.target - L.alpha) * Math.min(step, Math.abs(L.target - L.alpha));
			if (L.target === 0 && L.alpha <= 0) { if (self.isVideo) dropVideo(L.el); this.layers.splice(i, 1); }
		}
	};
	// 0..1: how present this stack currently is on screen.
	Stack.prototype.presence = function () {
		var p = 0;
		this.layers.forEach(function (l) { p = Math.max(p, l.alpha); });
		return p;
	};
	Stack.prototype.each = function (fn) { this.layers.forEach(fn); };

	var coverStack = new Stack(false), videoStack = new Stack(true);
	var videoPresence = 0; // smoothed, drives the layout animation

	var wasPlaying = null, lastCoverSong = null;
	function refresh() {
		var c = M.current();
		lastC = c;
		if (wasPlaying === false && c.playing) spinOnce(1);
		wasPlaying = c.playing;
		document.body.classList.toggle('helper-on', c.helperConnected);
		renderTracklist(c);
		updateCard(c);
		var tv = textVars(c);
		var songKey = (c.title || '') + '|' + (c.artist || '');
		if (c.title && songKey !== btKey) {
			btKey = songKey;
			if (S.showTitle) showBigTitle(fillText(S.textTitle, tv), fillText(S.textArtist, tv));
			spinOnce(1);
		} else if (c.title && !btEl.hidden) {
			// Album details can arrive a moment later: update the showing title if the text changed.
			var nt = fillText(S.textTitle, tv), na = fillText(S.textArtist, tv);
			if (nt !== btText) { btText = nt; btArtKey = ''; }
			btArtist = na;
		}
		var coverSong = (c.title || '') + '|' + (c.artist || '');
		var newSong = coverSong !== lastCoverSong && !!c.cover;
		if (newSong && c.cover !== coverStack.src) lastCoverSong = coverSong;
		coverStack.set(c.cover, c.coverIsCrossOrigin, newSong);
		var vsrc = S.canvasLayout === 'off' ? null : c.canvas;
		if (vsrc && failedVideos[vsrc]) { vsrc = webmOf(vsrc); if (failedVideos[vsrc]) vsrc = null; }
		videoStack.set(vsrc, true);
		videoStack.each(function (l) {
			if (c.playing && !ACV.paused) { var p = l.el.play(); if (p && p.catch) p.catch(function () {}); }
			else l.el.pause();
		});
	}
	M.onChange(refresh);

	ACV.onPause(function (p) {
		videoStack.each(function (l) { if (p) l.el.pause(); else { var x = l.el.play(); if (x && x.catch) x.catch(function () {}); } });
	});

	// Text colour for a "colour mode": follow the album cover, white, green, or the user's own colour.
	function tintOf(mode, custom) {
		if (mode === 'white') return [1, 1, 1];
		if (mode === 'green') return [0.49, 1, 0.54];
		if (mode === 'custom' && custom) return custom;
		return tlColors.acc;
	}
	function titleTint() { return tintOf(S.artColor, S.artCustom); }
	// How much denser characters fade towards white: less when the user picked their own colour, so it shows.
	function whiten(own, k) { return own ? 0.08 + 0.22 * k : 0.35 + 0.5 * k; }
	function clockOwn() { return S.clockColor === 'custom' || (S.clockColor === 'title' && S.artColor === 'custom'); }
	function clockTint() { return S.clockColor === 'title' ? titleTint() : tintOf(S.clockColor, S.clockCustom); }

	// ---------- clock ----------
	var ckEl = document.getElementById('clock'), ckCv = document.getElementById('clock-canvas'), ckCtx = ckCv.getContext('2d');
	var ckT = ckEl.querySelector('.ck-t'), ckD = ckEl.querySelector('.ck-d'), ckKey = '';
	function clockStrings() {
		var d = new Date(), h = d.getHours(), m = ('0' + d.getMinutes()).slice(-2), sec = ('0' + d.getSeconds()).slice(-2), ampm = '';
		if (!S.clock24) { ampm = h < 12 ? ' AM' : ' PM'; h = h % 12 || 12; } else h = ('0' + h).slice(-2);
		var t = h + ':' + m + (S.clockSeconds ? ':' + sec : '') + ampm;
		var date = S.clockDate ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/,/g, '').toUpperCase() : '';
		return [t, date];
	}
	// Draws text lines as fine ASCII (same recipe as the big title: normal text → coverage → characters + dark halo).
	function drawAsciiLines(cv, ctx, lines, align, tint, own) {
		var dpr = window.devicePixelRatio || 1, SS = 2;
		var tc0 = tint || clockTint(), isOwn = tint ? !!own : clockOwn();
		// Each line gets its own character grid (big time: coarse like the title; small date: finer so it stays readable).
		var parts = lines.map(function (l) {
			var mc = document.createElement('canvas'), mx = mc.getContext('2d', { willReadFrequently: true });
			mx.font = l.weight + ' ' + l.px + 'px ' + artFont();
			var tw = mx.measureText(l.text).width, ch = Math.max(2.2, l.px / (l.fine || 12)), cw = ch * ACV.measureMono();
			var thai = /[\u0E00-\u0E7F]/.test(l.text); // room for Thai marks above/below the letters
			// Draw on a generous width, then crop to where the ink really ends (measureText can come out short).
			var W0 = Math.ceil(tw * 1.3 + l.px * 2), H = Math.ceil(l.px * (thai ? 1.55 : 1.18));
			mc.width = W0 * SS; mc.height = H * SS;
			mx.scale(SS, SS); mx.font = l.weight + ' ' + l.px + 'px ' + artFont(); mx.textBaseline = 'top'; mx.fillStyle = '#fff';
			mx.globalAlpha = l.alpha || 1; mx.fillText(l.text, ch, l.px * (thai ? 0.3 : 0.1));
			var dd = mx.getImageData(0, 0, W0 * SS, H * SS).data, maxX = 0;
			for (var yy0 = 0; yy0 < H * SS; yy0 += 2) for (var xx0 = W0 * SS - 1; xx0 > maxX; xx0--) if (dd[(yy0 * W0 * SS + xx0) * 4 + 3] > 8) { maxX = xx0; break; }
			var W = Math.min(W0, Math.ceil(maxX / SS + ch * 1.5));
			return { l: l, mc: mc, mx: mx, W: W, W0: W0, H: H, ch: ch, cw: cw };
		});
		var halo = Math.ceil(parts[0].ch * 3);
		var W = Math.max.apply(null, parts.map(function (p) { return p.W; })), H = 0;
		parts.forEach(function (p) { p.y = H; H += p.H * (p.l.gap || 1); });
		H = Math.ceil(H);
		var OW = W + halo * 2, OH = H + halo * 2;
		cv.width = Math.round(OW * dpr); cv.height = Math.round(OH * dpr);
		cv.style.width = OW + 'px'; cv.style.height = OH + 'px';
		ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
		parts.forEach(function (p) { p.x = align === 'left' ? 0 : align === 'center' ? (W - p.W) / 2 : W - p.W; });
		// dark halo from the text shapes
		parts.forEach(function (p) {
			ctx.filter = 'brightness(0) blur(' + (p.ch * dpr * 1.4).toFixed(1) + 'px)';
			for (var pass = 0; pass < 3; pass++) ctx.drawImage(p.mc, 0, 0, p.W * SS, p.H * SS, (halo + p.x) * dpr, (halo + p.y) * dpr, p.W * dpr, p.H * dpr);
		});
		ctx.filter = 'none';
		parts.forEach(function (p) {
			var ch = p.ch, cw = p.cw, W2 = p.W0 * SS, Wc = p.W * SS, d = p.mx.getImageData(0, 0, W2, p.H * SS).data;
			var cols = Math.ceil(p.W / cw), rows = Math.ceil(p.H / ch);
			ctx.setTransform(dpr, 0, 0, dpr, (halo + p.x) * dpr, (halo + p.y) * dpr);
			var fpx = ch * 1.05; ctx.font = '700 ' + fpx.toFixed(2) + 'px ' + MONO_FONT;
			var adv = ctx.measureText('@@@@@@@@@@').width / 10; if (adv > 0) { fpx *= cw / adv; ctx.font = '700 ' + fpx.toFixed(2) + 'px ' + MONO_FONT; }
			ctx.textBaseline = 'middle';
			for (var cy = 0; cy < rows; cy++) {
				var lev = [], used = {}, ya = Math.floor(cy * ch * SS), yb = Math.min(p.H * SS, Math.floor((cy + 1) * ch * SS));
				for (var cx = 0; cx < cols; cx++) {
					var xa = Math.floor(cx * cw * SS), xb = Math.min(Wc, Math.floor((cx + 1) * cw * SS)), sum = 0, cnt = 0;
					for (var yy = ya; yy < yb; yy++) { var o = (yy * W2 + xa) * 4 + 3; for (var xx = xa; xx < xb; xx++, o += 4) { sum += d[o]; cnt++; } }
					var cov = cnt ? Math.min(1, sum / cnt / 255 * (p.l.boost || 1)) : 0, idx = cov < 0.08 ? 0 : Math.max(1, Math.round(Math.pow(cov, 0.8) * (TITLE_RAMP.length - 1)));
					lev.push(idx); if (idx) used[idx] = true;
				}
				for (var key in used) {
					var L2 = +key, line = '', kk = L2 / (TITLE_RAMP.length - 1);
					for (cx = 0; cx < cols; cx++) line += lev[cx] === L2 ? TITLE_RAMP[L2] : ' ';
					ctx.fillStyle = rgbStr(mix3(tc0, [1, 1, 1], whiten(isOwn, kk)), 0.85 + 0.15 * kk);
					ctx.fillText(line, 0, (cy + 0.5) * ch, cols * cw); // exact row width (tiny fonts round their spacing)
					if (p.l.bright) { ctx.globalCompositeOperation = 'lighter'; ctx.fillText(line, 0, (cy + 0.5) * ch, cols * cw); ctx.globalCompositeOperation = 'source-over'; }
				}
			}
		});
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		return halo;
	}
	function updateClock() {
		if (!S.showClock) { if (!ckEl.hidden) { ckEl.hidden = true; ckKey = ''; } return; }
		ckEl.hidden = false;
		var st = clockStrings(), art0 = S.clockStyle !== 'plain', px = Math.round(window.innerHeight * (art0 ? 0.1 : 0.075) * S.clockSize);
		var pos = S.clockPosition, art = S.clockStyle !== 'plain';
		var key = st.join('|') + '|' + px + '|' + pos + '|' + art + '|' + clockTint().join();
		if (key === ckKey) return; // only redraws when the shown time changes
		ckKey = key;
		ckEl.className = 'pos-' + pos + (art ? '' : ' plain');
		ckEl.style.setProperty('--fs', px + 'px');
		if (!art) { var pc = 'rgb(' + mix3(clockTint(), [1, 1, 1], clockOwn() ? 0 : 0.25).map(function (v) { return Math.round(v * 255); }).join(',') + ')'; ckT.style.color = pc; ckD.style.color = pc; ckT.textContent = st[0]; ckD.textContent = st[1]; ckD.style.display = st[1] ? '' : 'none'; ckEl.style.setProperty('--m', '28px'); return; }
		var lines = [{ text: st[0], px: px, weight: '800', gap: 0.95 }];
		if (st[1]) lines.push({ text: st[1], px: Math.round(px * 0.34), weight: '800', fine: 7, gap: 1 });
		var align = /left/.test(pos) ? 'left' : /center/.test(pos) ? 'center' : 'right';
		var halo = drawAsciiLines(ckCv, ckCtx, lines, align);
		ckEl.style.setProperty('--m', Math.max(4, 28 - halo) + 'px'); // keep the visible text ~28px from the edge
	}

	// ---------- lyrics (synced, from the helper) ----------
	var lyEl = document.getElementById('lyrics'), lyCv = document.getElementById('ly-canvas'), lyCtx = lyCv.getContext('2d');
	var lyT = lyEl.querySelector('.ly-t'), lyN = lyEl.querySelector('.ly-n'), lyKey = '';
	// Where the lyrics band sits (the big title lines up against it, even when lyrics are off).
	function lyAnchor() {
		var vh = window.innerHeight, top = S.showLyrics && S.lyricsPosition === 'top';
		return { top: top, y: vh * (top ? 0.1 : 0.9), px: Math.round(Math.max(14, vh * 0.05 * S.lyricsSize)) };
	}
	function curLyrics() { return (lastC && lastC.lyrics) || null; }
	function lyHide() { if (!lyEl.hidden) { lyEl.hidden = true; lyKey = ''; } }
	function updateLyrics() {
		var c = lastC, ly = curLyrics();
		if (!S.showLyrics || !c || !c.title) return lyHide();
		var cur = '', next = '', i = -1, pos = M.positionMs();
		if (ly && pos >= 0) {
			var L = ly.lines;
			var lead = 400 + (S.lyricsOffset || 0) * 100; // show each line a touch early (it animates in), plus the user's adjustment
			for (var k = 0; k < L.length; k++) { if (L[k].t <= pos + lead) i = k; else break; }
			cur = i >= 0 ? L[i].text.trim() : ''; next = i + 1 < L.length ? L[i + 1].text.trim() : '';
		}
		if (!ly && !btEl.hidden) return lyHide(); // no lyrics: the title is shown in their place
		var dots = !cur || /^[\s♪♫·.…-]*$/.test(cur); // no lyrics, before the first line, or an instrumental gap
		var vw = window.innerWidth, vh = window.innerHeight, A = lyAnchor();
		var x = vw / 2, y = A.y, maxW = A.top ? vw * 0.6 : vw * 0.7;
		if (!card.hidden) { // stay clear of the now-playing card when it sits on the same band
			var cr = card.getBoundingClientRect();
			if (cr.width && cr.bottom > y - vh * 0.06 && cr.top < y + vh * 0.06) {
				var room = cr.left > vw / 2 ? cr.left - x : x - cr.right;
				maxW = Math.max(vw * 0.25, Math.min(maxW, (room - 24) * 2));
			}
		}
		var px = A.px, art = S.lyricsStyle !== 'plain';
		lyEl.hidden = false;
		lyEl.style.left = x + 'px'; lyEl.style.top = y + 'px';
		if (dots) { if (lyKey.indexOf('dots|') !== 0) { lyKey = 'dots|'; lyEl.className = 'dots'; dotStep = -1; } return drawLyDots(px); }
		var key = [i, cur, next, px, Math.round(maxW), art, titleTint().join()].join('|');
		if (key !== lyKey) {
			lyKey = key;
			lyEl.className = (art ? '' : 'plain');
			void lyEl.offsetWidth; lyEl.classList.add('pop'); // each new line pops in
			if (art) {
				// shrink long lines so they fit
				var mx = document.createElement('canvas').getContext('2d'); mx.font = '800 ' + px + 'px ' + artFont();
				var fit = Math.max(0.55, Math.min(1, maxW / (mx.measureText(cur).width + px)));
				var lines = [{ text: cur, px: Math.round(px * fit), weight: '800', fine: 10, boost: 1.2, bright: true }];
				if (next) lines.push({ text: next, px: Math.round(px * 0.5), weight: '700', fine: 8, alpha: 0.55 });
				drawAsciiLines(lyCv, lyCtx, lines, 'center', titleTint(), S.artColor === 'custom');
				var w = parseFloat(lyCv.style.width), h = parseFloat(lyCv.style.height);
				if (w > maxW) { var kk = maxW / w; w *= kk; h *= kk; lyCv.style.width = w + 'px'; lyCv.style.height = h + 'px'; }
			} else {
				lyT.textContent = cur; lyN.textContent = next;
				lyEl.style.setProperty('--fs', px + 'px'); lyEl.style.maxWidth = maxW + 'px';
				lyT.style.color = 'rgb(' + mix3(titleTint(), [1, 1, 1], 0.3).map(function (v) { return Math.round(v * 255); }).join(',') + ')';
			}
		}
	}
	// Retro "..." loader: dots light up one by one in hard steps, like an old terminal.
	var dotSprite = document.createElement('canvas'), dotKey = '', dotStep = -1;
	function drawLyDots(px) {
		var P = Math.round(px * 0.9), k = P + '|' + titleTint().join() + '|' + S.artColor;
		if (k !== dotKey) { dotKey = k; dotStep = -1; drawAsciiLines(dotSprite, dotSprite.getContext('2d'), [{ text: '●', px: P, weight: '800', fine: 7, boost: 1.3, bright: true }], 'center', titleTint(), S.artColor === 'custom'); }
		var step = Math.floor(performance.now() / 380) % 5; // 0 · 1 · 2 · 3 lit, then a beat with all three
		if (step === dotStep) return;
		dotStep = step;
		var sw = parseFloat(dotSprite.style.width) || P, sh = parseFloat(dotSprite.style.height) || P, dpr = window.devicePixelRatio || 1;
		var gap = P * 1.15, W = sw + gap * 2, H = sh;
		if (lyCv.width !== Math.round(W * dpr) || lyCv.height !== Math.round(H * dpr)) {
			lyCv.width = Math.round(W * dpr); lyCv.height = Math.round(H * dpr); lyCv.style.width = W + 'px'; lyCv.style.height = H + 'px';
		}
		lyCtx.setTransform(1, 0, 0, 1, 0, 0); lyCtx.clearRect(0, 0, lyCv.width, lyCv.height);
		var lit = Math.min(step, 3);
		for (var d = 0; d < 3; d++) {
			lyCtx.globalAlpha = d < lit ? 1 : 0.18;
			lyCtx.drawImage(dotSprite, Math.round(gap * d * dpr), 0, Math.round(sw * dpr), Math.round(sh * dpr));
		}
		lyCtx.globalAlpha = 1;
	}

	// ---------- custom text: "{title} — {album}" etc. ----------
	var lastC = null;
	function mmss(ms) { var t = Math.round((ms || 0) / 1000), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60; return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + sec).slice(-2); }
	function textVars(c) {
		c = c || lastC || {};
		var al = curAlbum, tr = al && tlCurrent >= 0 ? al.tracks[tlCurrent] : null;
		var total = al ? al.tracks.reduce(function (a, t) { return a + (t.ms || 0); }, 0) : 0;
		var n = al ? al.tracks.length : 0;
		var songMs = (M.we && M.we.duration ? M.we.duration * 1000 : 0) || (tr && tr.ms) || 0;
		return {
			title: c.title || '', artist: c.artist || '', currentartist: c.artist || '',
			albumartist: (al && al.artist) || c.artist || '',
			album: (al && al.name) || c.albumName || '',
			year: (al && al.year) || '',
			kind: !al ? '' : n === 1 ? 'SINGLE' : n <= 6 ? 'EP' : 'ALBUM',
			track: tr ? String(tr.n || tlCurrent + 1) : '', tracks: n ? String(n) : '',
			time: songMs ? mmss(songMs) : '', albumtime: total ? mmss(total) : '',
			albummin: total ? String(Math.max(1, Math.round(total / 60000))) : '',
			label: (al && al.label) || '', genre: (al && al.genre) || '', country: (al && al.country) || ''
		};
	}
	// Fills the placeholders, then tidies separators left dangling by empty values ("Artist ·  " → "Artist").
	function fillText(tpl, v) {
		if (tpl == null) return '';
		v = v || textVars();
		var out = String(tpl).replace(/\{(\w+)\}/g, function (m, k) { k = k.toLowerCase(); return k in v ? v[k] : ''; }); // unknown placeholders → blank
		var SEP = '[·•|\\/–—-]';
		out = out.replace(new RegExp('(\\s' + SEP + '\\s*)(' + SEP + '\\s*)+', 'g'), '$1');
		out = out.replace(new RegExp('^\\s*' + SEP + '\\s+|\\s+' + SEP + '\\s*$', 'g'), '');
		out = out.replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s{2,}/g, ' ').trim();
		return /^[\s·•|\/–—-]*$/.test(out) ? '' : out;
	}
	ACV.fillText = fillText;

	// ---------- now-playing card ----------
	var card = document.getElementById('card');
	var cardImg = document.getElementById('card-cover');
	var cardTitle = document.getElementById('card-title');
	var cardArtist = document.getElementById('card-artist');
	var cardBar = document.getElementById('card-progress');
	var cardBadge = document.getElementById('card-badge');
	var shownCover; // undefined so the first update always applies
	var cardTitleCv = document.getElementById('card-title-art'), cardArtistCv = document.getElementById('card-artist-art');
	var cardArtKey = '';
	function renderCardArt(title, artist) {
		if (!S.cardAscii) return;
		var key = [title, artist, S.cardPosition, titleTint().join()].join('|');
		if (key === cardArtKey) return;
		cardArtKey = key;
		var align = S.cardPosition === 'top-right' ? 'right' : S.cardPosition === 'center' ? 'center' : 'left', own = S.artColor === 'custom';
		drawAsciiLines(cardTitleCv, cardTitleCv.getContext('2d'), [{ text: title || ' ', px: 26, weight: '800', fine: 7, bright: true }], align, titleTint(), own);
		if (artist) drawAsciiLines(cardArtistCv, cardArtistCv.getContext('2d'), [{ text: artist, px: 18, weight: '800', fine: 6, boost: 1.25, bright: true }], align, [1, 1, 1], false);
		cardArtistCv.style.display = artist ? '' : 'none';
		[cardTitleCv, cardArtistCv].forEach(function (cv) { // never wider than the card allows
			var w = parseFloat(cv.style.width), lim = window.innerWidth * 0.34;
			if (w > lim) { var k = lim / w; cv.style.width = w * k + 'px'; cv.style.height = parseFloat(cv.style.height) * k + 'px'; }
		});
	}


	function applyCardSettings() {
		card.className = 'card pos-' + S.cardPosition + (S.cardAscii ? ' mono art' : '');
		cardArtKey = '';
		card.style.setProperty('--scale', S.cardScale);
		card.hidden = !S.showCard;
	}

	function updateCard(c) {
		var has = !!(c.title || c.cover);
		card.classList.toggle('empty', !has);
		var tv = textVars(c);
		cardTitle.textContent = c.title ? fillText(S.textCardTitle, tv) : 'Nothing playing';
		cardArtist.textContent = c.title ? fillText(S.textCardArtist, tv) : '';
		if (c.cover !== shownCover) {
			shownCover = c.cover;
			if (c.cover) cardImg.src = c.cover;
			card.classList.toggle('no-cover', !c.cover);
		}
		cardBadge.hidden = true;
		renderCardArt(cardTitle.textContent, cardArtist.textContent);
		var col = c.colors && c.colors.primary;
		if (col) card.style.setProperty('--accent', 'rgb(' + col.map(function (x) { return Math.round(x * 255); }).join(',') + ')');
	}

	// ---------- drawing ----------
	// Composite pixels are one character cell each, and cells are taller than wide,
	// so images are laid out in "screen units" (w * ax) and squeezed back with a transform.
	function pixelAspect() { return S.ascii ? cellW / cellH : 1; }

	function srcSize(el) {
		return [el.videoWidth || el.naturalWidth || el.width, el.videoHeight || el.naturalHeight || el.height];
	}

	// Cover the whole area (crops the image).
	function drawFill(el, w, h, zoom, panX, panY) {
		var sz = srcSize(el), sw = sz[0], sh = sz[1];
		if (!sw || !sh) return;
		var s = Math.max(w / sw, h / sh) * zoom;
		var dw = sw * s, dh = sh * s;
		var dx = (w - dw) / 2 + panX * Math.max(0, dw - w) / 2;
		var dy = (h - dh) / 2 + panY * Math.max(0, dh - h) / 2;
		cctx.drawImage(el, dx, dy, dw, dh);
	}

	// Show the whole image, centred (no cropping).
	function drawFit(el, w, h, zoom) {
		var sz = srcSize(el), sw = sz[0], sh = sz[1];
		if (!sw || !sh) return;
		var s = Math.min(w / sw, h / sh) * zoom;
		var dw = sw * s, dh = sh * s;
		cctx.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
	}

	// Fit el inside the rect (x, y, rw, rh), centred.
	function drawInRect(el, x, y, rw, rh) {
		var sz = srcSize(el), sw = sz[0], sh = sz[1];
		if (!sw || !sh) return;
		var s = Math.min(rw / sw, rh / sh);
		var dw = sw * s, dh = sh * s;
		cctx.drawImage(el, x + (rw - dw) / 2, y + (rh - dh) / 2, dw, dh);
	}
	function lerp(a, b, k) { return a + (b - a) * k; }

	function eachWithAlpha(stack, mul, fn) {
		var base = cctx.globalAlpha;
		stack.each(function (L) {
			var a = Math.max(0, Math.min(1, L.alpha * mul));
			if (a <= 0) return;
			cctx.globalAlpha = a;
			fn(L);
		});
		cctx.globalAlpha = base;
	}

	function blurredFill(stack, vw, h, mul, filter) {
		cctx.filter = filter;
		eachWithAlpha(stack, mul, function (L) { drawFill(L.el, vw, h, 1.1, 0, 0); });
		cctx.filter = 'none';
	}

	function drawScene(w, h, now, pulseZoom) {
		var ax = pixelAspect();
		var vw = w * ax; // width in screen units
		sceneVw = vw;
		var mode = S.canvasLayout;
		var vp = mode === 'off' ? 0 : videoPresence;
		var blur = 'blur(' + Math.max(1, Math.round(h / 30)) + 'px) brightness(0.5)';
		cctx.save();
		cctx.scale(1 / ax, 1);

		// Cover only, "Fill" layout: crop to fill the screen with a slow drift.
		if (vp <= 0 && S.coverLayout === 'fill') {
			eachWithAlpha(coverStack, 1, function (L) {
				var age = (now - L.born) / 1000, zoom = pulseZoom * S.imageZoom, px = 0, py = 0;
				if (S.kenBurns) { zoom *= 1.04 + 0.03 * Math.sin(age * 0.05); px = Math.sin(age * 0.031) * 0.8; py = Math.cos(age * 0.023) * 0.8; }
				drawFill(L.el, vw, h, zoom, px, py);
			});
			coverRect = null;
			cctx.restore();
			return;
		}

		// Background: blurred cover, with the canvas fading in over it.
		blurredFill(coverStack, vw, h, 1, blur);
		if (vp > 0) {
			if (mode === 'behind') {
				cctx.filter = 'brightness(0.6)';
				eachWithAlpha(videoStack, vp, function (L) { drawFill(L.el, vw, h, pulseZoom, 0, 0); });
				cctx.filter = 'none';
			} else blurredFill(videoStack, vw, h, vp, blur);
		}

		var drift = S.kenBurns ? Math.sin(now / 1000 * 0.05) : 0;
		var zoom = pulseZoom * S.imageZoom * (1 + 0.015 * drift);
		var full = Math.min(vw, h) * zoom; // cover size when it's alone
		var cx = vw / 2, cy = h / 2;
		var LW = 0.95, lp = 0; // (side tracklist removed; it lives on the back of the cover now)

		// Lay items out in a centred row (widths relative to height H), shrinking to fit the screen.
		function row(H, items) {
			var tot = 0;
			items.forEach(function (it, i) { tot += it.w * it.p + (i ? 0.06 * it.p : 0); });
			var fitK = Math.min(1, (vw * 0.92) / (tot * H));
			H *= fitK;
			var x = cx - tot * H / 2, out = [];
			items.forEach(function (it, i) {
				if (i) x += 0.06 * it.p * H;
				out.push({ x: x, y: cy - H / 2, w: it.w * it.p * H, h: H });
				x += it.w * it.p * H;
			});
			return out;
		}

		var vEl = videoStack.layers.length ? videoStack.layers[videoStack.layers.length - 1].el : null;
		var vs = vEl ? srcSize(vEl) : [9, 16];
		var va = vs[0] && vs[1] ? vs[0] / vs[1] : 9 / 16;
		var Hbase = lerp(full, h * 0.8 * zoom, Math.max(vp, lp));
		var r;

		if (mode === 'side') {
			// Cover, tracklist, canvas — side by side.
			r = row(Hbase, [{ w: 1, p: 1 }, { w: LW, p: lp }, { w: va, p: vp }]);
			drawCoverFlip(r[0], 1);
			eachWithAlpha(videoStack, vp, function (L) { drawInRect(L.el, r[2].x, r[2].y, r[2].w, r[2].h); });
		} else if (mode === 'behind') {
			// Cover (and tracklist) in front of the canvas, on a soft dark plate.
			r = row(full * lerp(1, 0.72, vp), [{ w: 1, p: 1 }, { w: LW, p: lp }]);
			if (vp > 0) {
				var pad = r[0].h * 0.06;
				cctx.fillStyle = 'rgba(0,0,0,' + (0.55 * vp) + ')';
				cctx.fillRect(r[0].x - pad, r[0].y - pad, r[0].w + pad * 2, r[0].h + pad * 2);
			}
			drawCoverFlip(r[0], 1);
		} else {
			// 'off' or 'canvas': one image (the canvas fades in over the cover), tracklist beside it.
			r = row(Hbase, [{ w: lerp(1, va, vp), p: 1 }, { w: LW, p: lp }]);
			drawCoverFlip(r[0], 1 - vp);
			if (vp > 0) eachWithAlpha(videoStack, vp, function (L) { drawInRect(L.el, r[0].x, r[0].y, r[0].w, r[0].h); });
		}
		var vis = mode === 'canvas' ? 1 - vp : 1;
		// Same rect without the bass pulse / slow drift, for placing text that must not jitter.
		var kz = pulseZoom * (1 + 0.015 * drift);
		var calm = { x: cx + (r[0].x - cx) / kz, y: cy + (r[0].y - cy) / kz, w: r[0].w / kz, h: r[0].h / kz };
		coverRect = { x: r[0].x, y: r[0].y, w: r[0].w, h: r[0].h, vis: vis, vw: vw, sh: h, calm: calm };
		cctx.restore();
	}

	// ---------- album tracklist (crisp text panel placed where drawScene left room) ----------
	var tlEl = document.getElementById('tracklist');
	var tlAlbum = tlEl.querySelector('.tl-album'), tlKind = tlEl.querySelector('.tl-kind'), tlArtist = tlEl.querySelector('.tl-artist'),
		tlList = tlEl.querySelector('.tl-list'), tlPos = tlEl.querySelector('.tl-pos'), tlTotal = tlEl.querySelector('.tl-total');
	var tlRows = [], tlCurrent = -1, tlKey = '', tlLayoutKey = '', curAlbum = null, tlArtKey = '';
	var tlArtEl = tlEl.querySelector('.tl-art'), tlArtOk = false;

	function fmtTime(ms) { var sec = Math.round((ms || 0) / 1000); return Math.floor(sec / 60) + ':' + ('0' + sec % 60).slice(-2); }
	function normTitle(x) { return (x || '').toLowerCase().replace(/[^a-z0-9À-￿]+/g, ''); }

	// "Song (feat. X)" / "Song - Remastered" → main part + dimmed extra part.
	function splitTitle(t) {
		var m = String(t || '').match(/^(.+?)(\s+(?:\(|\[|-\s).*)$/);
		return m ? [m[1], m[2]] : [String(t || ''), ''];
	}

	function renderTracklist(c) {
		curAlbum = c.album;
		if (!curAlbum) { tlKey = ''; return; }
		var key = curAlbum.uri + '|' + c.trackUri + '|' + c.title + '|' + S.headingStyle;
		if (key === tlKey) return;
		var sameAlbum = tlKey.split('|')[0] === curAlbum.uri && tlKey.split('|')[3] === S.headingStyle;
		tlKey = key; tlLayoutKey = '';
		var n = curAlbum.tracks.length;
		if (!sameAlbum) {
			var kind = n === 1 ? 'Single' : n <= 6 ? 'EP' : 'Album';
			tlKind.textContent = [kind, curAlbum.year].filter(Boolean).join(' · ');
			tlArtKey = '';
			tlAlbum.textContent = curAlbum.name || '';
			tlArtist.textContent = c.artist || '';
			var total = curAlbum.tracks.reduce(function (s2, t) { return s2 + (t.ms || 0); }, 0);
			tlTotal.textContent = (n === 1 ? fmtTime(total) : Math.max(1, Math.round(total / 60000)) + ' min') + (n > 1 ? ' · ' + n + ' songs' : '');
			var multiDisc = curAlbum.tracks.some(function (t) { return t.d > 1; });
			tlList.textContent = '';
			tlRows = curAlbum.tracks.map(function (t, i) {
				var li = document.createElement('li');
				var num = document.createElement('span'); num.className = 'n';
				li.dataset.num = (multiDisc ? t.d + '.' : '') + (t.n || i + 1) + ')';
				num.textContent = li.dataset.num;
				var tt = document.createElement('span'); tt.className = 't';
				var parts = splitTitle(t.title);
				tt.appendChild(document.createTextNode(parts[0]));
				if (parts[1]) { var x = document.createElement('span'); x.className = 'x'; x.textContent = parts[1]; tt.appendChild(x); }
				var d = document.createElement('span'); d.className = 'd'; d.textContent = '[' + fmtTime(t.ms) + ']';
				li.dataset.dur = d.textContent;
				li.appendChild(num); li.appendChild(tt); li.appendChild(d);
				tlList.appendChild(li);
				return li;
			});
		}
		tlCurrent = -1;
		curAlbum.tracks.forEach(function (t, i) { if (tlCurrent < 0 && c.trackUri && t.uri === c.trackUri) tlCurrent = i; });
		if (tlCurrent < 0) curAlbum.tracks.forEach(function (t, i) { if (tlCurrent < 0 && normTitle(t.title) === normTitle(c.title)) tlCurrent = i; });
		if (tlCurrent < 0) curAlbum.tracks.forEach(function (t, i) { if (tlCurrent < 0 && normTitle(splitTitle(t.title)[0]) === normTitle(splitTitle(c.title)[0])) tlCurrent = i; });
		tlRows.forEach(function (li, i) {
			li.classList.toggle('now', i === tlCurrent);
			var num = li.firstChild;
			num.textContent = li.dataset.num;
			li.lastChild.textContent = i === tlCurrent ? '[PLAYING]' : li.dataset.dur;
		});
		tlPos.textContent = tlCurrent >= 0 && n > 1 ? 'Track ' + (tlCurrent + 1) + ' of ' + n : (n === 1 ? 'Now playing' : '');
		updateTlAccent();
	}

	// ---------- spinning cover: the front is drawn in the ASCII image, the back is the tracklist ----------
	var coverRect = null;
	// The cover turns around its vertical axis. flipAngle is continuous: 0 = front, PI = back, 2PI = front again.
	var flipAngle = 0, flipVel = 0, flipGoal = 0, nextFlipAt = 0, backUntil = 0, dragging = null, flipT = 0;
	function isBack(a) { return Math.cos(a) < 0; }

	// During a fast spin the back isn't shown (squeezed fine text just smears);
	// the cover art shows on both sides instead, so the spin stays crisp.
	function fastSpin() { return !!spinAnim || Math.abs(flipVel) > 4; }
	// Where a cover layer sits during a song change: the new one slides in from the left,
	// the old one slides out to the right. Returns [x offset, alpha].
	var sceneVw = 0;
	function slideOf(L, r) {
		if (S.coverTransition !== 'slide' || !L.slide) return [0, L.alpha];
		var dist = sceneVw / 2 + r.w; // fully off screen
		if (L.target === 1) { var e = 1 - Math.pow(1 - L.alpha, 3); return [-(1 - e) * dist, 1]; }
		var e2 = Math.pow(1 - L.alpha, 2); return [e2 * dist, 1];
	}
	function drawCoverFlip(r, mul) {
		var sx = Math.cos(flipAngle);
		if (sx < -0.002 && !fastSpin() && !curAlbum) { drawCoverBack(r, mul, -sx); return; } // no tracklist: blurred back
		sx = Math.abs(sx);
		if (sx <= 0.002) return;
		var base = cctx.globalAlpha;
		coverStack.each(function (L) {
			var sz = srcSize(L.el), sw = sz[0], sh = sz[1];
			if (!sw || !sh) return;
			var so = slideOf(L, r), a = Math.max(0, Math.min(1, so[1] * mul));
			if (a <= 0) return;
			cctx.globalAlpha = a;
			var k = Math.min(r.w / sw, r.h / sh), dw = sw * k, dh = sh * k;
			var cx = r.x + r.w / 2 + so[0];
			cctx.drawImage(L.el, cx - dw * sx / 2, r.y + (r.h - dh) / 2, dw * sx, dh);
			if (sx < 1) { // darken as it turns away
				cctx.fillStyle = 'rgba(0,0,0,' + ((1 - sx) * 0.6).toFixed(3) + ')';
				cctx.fillRect(cx - r.w * sx / 2, r.y, r.w * sx, r.h);
			}
		});
		cctx.globalAlpha = base;
	}


	// Back of the sleeve: the cover itself, mirrored, blurred and darkened, drawn into the ASCII
	// image so it always matches the album. Static on purpose, so the characters don't flicker.
	function drawCoverBack(r, mul, sx) {
		var w = r.w * sx, x = r.x + r.w / 2 - w / 2, y = r.y, h = r.h;
		if (w < 1) return;
		var blur = Math.max(2, Math.round(Math.min(r.w, r.h) / 14));
		cctx.save();
		cctx.beginPath(); cctx.rect(x, y, w, h); cctx.clip();
		cctx.filter = 'blur(' + blur + 'px) saturate(1.2) brightness(0.95)';
		eachWithAlpha(coverStack, mul, function (L) {
			var sz = srcSize(L.el), sw = sz[0], sh = sz[1];
			if (!sw || !sh) return;
			// Fill the sleeve (a little oversized so the blur has no soft edges), mirrored.
			var k = Math.max(r.w / sw, r.h / sh) * 1.25, dw = sw * k * sx, dh = sh * k;
			cctx.save();
			cctx.translate(x + w / 2, y + h / 2);
			cctx.scale(-1, 1);
			cctx.drawImage(L.el, -dw / 2, -dh / 2, dw, dh);
			cctx.restore();
		});
		cctx.filter = 'none';
		var a0 = cctx.globalAlpha;
		cctx.globalAlpha = a0 * mul;
		cctx.fillStyle = 'rgba(0,0,0,0.3)';
		cctx.fillRect(x, y, w, h);
		if (sx < 1) { cctx.fillStyle = 'rgba(0,0,0,' + ((1 - sx) * 0.6).toFixed(3) + ')'; cctx.fillRect(x, y, w, h); }
		cctx.globalAlpha = a0;
		cctx.restore();
	}

	// Turning by hand works even without a tracklist (the back then shows the blurred cover);
	// the automatic flip only happens when there's a tracklist to show.
	function canFlip() { return S.coverFlip !== 'off' && coverRect && coverRect.vis > 0.5; }

	function nearestFront(a, dir) { var k = a / (2 * Math.PI); return 2 * Math.PI * (dir > 0 ? Math.ceil(k - 0.001) : dir < 0 ? Math.floor(k + 0.001) : Math.round(k)); }
	function nearestBack(a, dir) { var k = (a - Math.PI) / (2 * Math.PI); return Math.PI + 2 * Math.PI * (dir > 0 ? Math.ceil(k - 0.001) : dir < 0 ? Math.floor(k + 0.001) : Math.round(k)); }
	function goFront(dir) { flipGoal = nearestFront(flipAngle + (dir > 0 ? 0.01 : dir < 0 ? -0.01 : 0), dir || 0); nextFlipAt = performance.now() + S.flipEvery * 1000; }
	function goBack(dir) { flipGoal = nearestBack(flipAngle + (dir > 0 ? 0.01 : dir < 0 ? -0.01 : 0), dir || 0); backUntil = performance.now() + 1200 + S.flipShow * 1000; }
	// A full turn back to the front (song start / play pressed).
	// A timed spin: fast at first, easing out to land on the front.
	var spinAnim = null;
	function spinOnce(turns) {
		if (S.coverFlip === 'off' || dragging) return;
		poke();
		turns = Math.max(1, Math.round(turns || 1));
		var from = flipAngle, to = nearestFront(flipAngle, 0) + turns * 2 * Math.PI;
		spinAnim = { from: from, to: to, start: performance.now(), dur: 450 + turns * 150 };
		flipGoal = to; flipVel = 0;
		nextFlipAt = performance.now() + S.flipEvery * 1000;
	}

	// Idle: after a few minutes without activity the cover turns very slowly, round and round.
	var lastActivity = performance.now(), idleSpin = false;
	function poke() {
		lastActivity = performance.now();
		if (idleSpin) { idleSpin = false; flipGoal = nearestFront(flipAngle, 1); flipVel = 0; nextFlipAt = lastActivity + S.flipEvery * 1000; }
	}
	['mousemove', 'mousedown', 'wheel', 'keydown'].forEach(function (ev) { document.addEventListener(ev, poke, { passive: true }); });

	function updateFlip(dt, now) {
		if (!nextFlipAt) nextFlipAt = now + S.flipEvery * 1000;
		var onBack = isBack(flipGoal);
		if (!idleSpin && S.idleMinutes > 0 && S.coverFlip !== 'off' && !dragging && now - lastActivity > S.idleMinutes * 60000 && Math.abs(flipGoal - flipAngle) < 0.01) {
			idleSpin = true; flipVel = 0;
		}
		if (idleSpin) {
			// One turn takes about idleSeconds; ease in from a standstill.
			var target = 2 * Math.PI / Math.max(10, S.idleSeconds);
			flipVel += (target - flipVel) * (1 - Math.exp(-dt * 0.5));
			flipAngle += flipVel * dt;
			flipGoal = flipAngle;
			flipT = 1;
			return;
		}
		if (spinAnim && !dragging) {
			var p0 = Math.min(1, (now - spinAnim.start) / spinAnim.dur), e0 = 1 - Math.pow(1 - p0, 4);
			flipAngle = spinAnim.from + (spinAnim.to - spinAnim.from) * e0;
			flipGoal = spinAnim.to; flipVel = 0;
			if (p0 >= 1) spinAnim = null;
			flipT = 1;
			return;
		}
		if (dragging) spinAnim = null;
		if (!dragging) {
			if (onBack && (!canFlip() || now > backUntil)) goFront(1);
			else if (!onBack && S.coverFlip === 'auto' && canFlip() && curAlbum && now > nextFlipAt && Math.abs(flipGoal - flipAngle) < 0.01) goBack(1);
			// Spring towards the goal.
			var k = 38, c = 11;
			flipVel += ((flipGoal - flipAngle) * k - flipVel * c) * dt;
			flipAngle += flipVel * dt;
			if (Math.abs(flipGoal - flipAngle) < 0.002 && Math.abs(flipVel) < 0.01) { flipAngle = flipGoal; flipVel = 0; }
		}
		// Keep the numbers small.
		if (Math.abs(flipAngle) > 20 * Math.PI && Math.abs(flipGoal - flipAngle) < 0.01) { var w = Math.round(flipAngle / (2 * Math.PI)) * 2 * Math.PI; flipAngle -= w; flipGoal -= w; }
		flipT = Math.min(1, Math.abs(Math.sin(flipAngle)) + (isBack(flipAngle) ? 1 : 0) + Math.min(1, Math.abs(flipVel) / 2));
	}

	var stable = null;
	function stableCover() {
		var r = coverCss();
		if (!r) return stable;
		if (!stable || Math.abs(r.w - stable.w) > r.w * 0.15) stable = { x: r.x, y: r.y, w: r.w, h: r.h };
		var k = 0.02;
		['x', 'y', 'w', 'h'].forEach(function (p) { stable[p] += (r[p] - stable[p]) * k; });
		return { x: Math.round(stable.x / 4) * 4, y: Math.round(stable.y / 4) * 4, w: Math.round(stable.w / 8) * 8, h: Math.round(stable.h / 8) * 8 };
	}

	function calmCss() {
		if (!coverRect || !coverRect.calm) return null;
		var kx = window.innerWidth / coverRect.vw, ky = window.innerHeight / coverRect.sh, c = coverRect.calm;
		return { x: Math.round(c.x * kx), y: Math.round(c.y * ky), w: Math.round(c.w * kx), h: Math.round(c.h * ky) };
	}

	function coverCss() {
		if (!coverRect) return null;
		var kx = window.innerWidth / coverRect.vw, ky = window.innerHeight / coverRect.sh;
		return { x: coverRect.x * kx, y: coverRect.y * ky, w: coverRect.w * kx, h: coverRect.h * ky };
	}

	// Drag the cover sideways to spin it; a click (no drag) flips it.
	// (Wallpaper Engine passes desktop mouse events to the wallpaper.)
	function overCover(ev) {
		var r = coverCss();
		return r && ev.clientX >= r.x && ev.clientX <= r.x + r.w && ev.clientY >= r.y && ev.clientY <= r.y + r.h;
	}
	document.addEventListener('mousedown', function (ev) {
		if (ev.button !== 0 || S.coverFlip === 'off' || !overCover(ev)) return;
		var r = coverCss();
		dragging = { x0: ev.clientX, a0: flipAngle, w: r.w, lastX: ev.clientX, lastT: performance.now(), v: 0, moved: false };
		flipVel = 0;
	});
	document.addEventListener('mousemove', function (ev) {
		if (!dragging) return;
		var now = performance.now(), dx = ev.clientX - dragging.x0;
		if (Math.abs(dx) > 4) dragging.moved = true;
		flipAngle = dragging.a0 + dx / dragging.w * Math.PI;
		var dtm = Math.max(1, now - dragging.lastT);
		dragging.v = dragging.v * 0.6 + ((ev.clientX - dragging.lastX) / dragging.w * Math.PI / (dtm / 1000)) * 0.4;
		dragging.lastX = ev.clientX; dragging.lastT = now;
	});
	document.addEventListener('mouseup', function () {
		if (!dragging) return;
		var d = dragging; dragging = null;
		if (!d.moved) { // plain click: flip to the other side
			if (isBack(flipGoal)) goFront(1); else if (canFlip()) goBack(1); else spinOnce();
			return;
		}
		flipVel = d.v;
		// Throw: carry on in the direction of the swipe and settle on the next face.
		var aim = flipAngle + d.v * 0.25, dir = d.v > 0.5 ? 1 : d.v < -0.5 ? -1 : 0;
		var wantBack = isBack(aim) && canFlip();
		flipAngle = flipAngle; // keep where the drag left it
		if (wantBack) { flipGoal = nearestBack(aim, 0); backUntil = performance.now() + 1200 + S.flipShow * 1000; }
		else { flipGoal = nearestFront(aim, 0); nextFlipAt = performance.now() + S.flipEvery * 1000; }
		if (dir && Math.sign(flipGoal - flipAngle) !== dir && Math.abs(flipGoal - flipAngle) > 0.3) flipGoal += dir * 2 * Math.PI;
	});

	// ---------- big title when a song starts ----------
	var btEl = document.getElementById('bigtitle'), btT = btEl.querySelector('.bt-t'), btA = btEl.querySelector('.bt-a');
	var btMode = 'sharp', btOutAt = 0;
	var btKey = null, btTimer = null, btStart = 0, btText = '', btArtist = '';
	var btACv = document.createElement('canvas'), btACtx = btACv.getContext('2d'), btAKey = '';
	btACv.className = 'bt-acv';
	var SCRAMBLE = '!<>-_\\/[]{}=+*^?#%@';
	function showBigTitle(title, artist) {
		btText = title || ''; btArtist = artist || '';
		btStart = performance.now();
		btEl.hidden = false;
		btEl.classList.remove('out', 'rise'); void btEl.offsetWidth; btEl.classList.add('rise'); // restart the rise
		clearTimeout(btTimer);
		btOutAt = 0; btFrozen = null; btFrozenSet = false; btArtKey = '';
		btTimer = setTimeout(function out() {
			if (titleStays()) { btTimer = setTimeout(out, 1000); return; } // no lyrics: the title takes their place
			btEl.classList.add('out'); btOutAt = performance.now(); btTimer = setTimeout(function () { btEl.hidden = true; }, 900);
		}, S.titleSeconds * 1000);
	}
	// With lyrics switched on, a song that has none keeps its title on screen instead.
	function titleStays() { return !!(S.showLyrics && lastC && lastC.title && !curLyrics()); }
	var btArt = null, btArtKey = '', btFrozen = null, btFrozenSet = false;
	function artFont() { return '"ACV Thai", "Leelawadee UI", "Segoe UI", sans-serif'; }
	function artColor() {
		return 'rgb(' + titleTint().map(function (x) { return Math.round(x * 255); }).join(',') + ')';
	}
	// Fit ASCII art into a width: tries big letters first, smaller ones (and 2 lines) if needed.
	function fitArt(text, widthPx, sizePx, maxRows, maxLines) {
		var maxCols = Math.max(12, Math.floor(widthPx / (sizePx * ACV.measureMono() * 1.02)));
		var minRows = Math.max(8, Math.round(maxRows * 0.6));
		for (var rows = maxRows; rows >= minRows; rows--) {
			if (artFits(text, maxCols, rows)) return ACV.asciiArt(text, { maxCols: maxCols, rows: rows, maxLines: 1, font: artFont() });
		}
		return ACV.asciiArt(text, { maxCols: maxCols, rows: minRows, maxLines: maxLines, font: artFont() });
	}
	var _mc = null;
	function artFits(text, maxCols, rows) {
		_mc = _mc || document.createElement('canvas').getContext('2d');
		_mc.font = '800 ' + (rows * 20 * 0.82) + 'px ' + artFont();
		return _mc.measureText(text).width + 30 <= maxCols * 10;
	}

	var btCanvas = document.getElementById('bt-canvas'), btCtx = btCanvas.getContext('2d');
	var TITLE_RAMP = ' .:-=+*#%@';
	function buildTitleArt(text, maxW, coverH, pxWant) {
		var dpr = window.devicePixelRatio || 1;
		var rc = document.createElement('canvas'), rx = rc.getContext('2d', { willReadFrequently: true });
		var font = function (px) { return '800 ' + px + 'px ' + artFont(); };
		// Font size: big, but shrink to fit the width; wrap long titles to two lines.
		var px = pxWant || Math.max(60, Math.min(150, coverH * 0.13)) * (S.artSize / 8);
		rx.font = font(px);
		var lines = [text];
		if (rx.measureText(text).width > maxW) {
			var fit = px * maxW / rx.measureText(text).width;
			if (fit >= px * 0.62) px = fit;
			else {
				// Split near the middle at a space (or anywhere for Thai, which has no spaces).
				var mid = Math.floor(text.length / 2), cut = text.lastIndexOf(' ', mid);
				if (cut < text.length * 0.25) cut = text.indexOf(' ', mid);
				if (cut < 0) { var g = graphemes(text); cut = g.slice(0, Math.ceil(g.length / 2)).join('').length; lines = [text.slice(0, cut), text.slice(cut)]; }
				else lines = [text.slice(0, cut), text.slice(cut + 1)];
				rx.font = font(px);
				var widest = Math.max.apply(null, lines.map(function (l) { return rx.measureText(l).width; }));
				if (widest > maxW) px *= maxW / widest;
			}
		}
		rx.font = font(px);
		var widest2 = Math.max.apply(null, lines.map(function (l) { return rx.measureText(l).width; }));
		var lineH = px * 1.55; // room for Thai marks above and below
		var W = Math.ceil(widest2 + px * 0.2), H = Math.ceil(lineH * lines.length);
		rc.width = W; rc.height = H;
		rx.font = font(px); rx.fillStyle = '#fff'; rx.textBaseline = 'middle'; rx.textAlign = 'center';
		lines.forEach(function (l, i) { rx.fillText(l, W / 2, lineH * (i + 0.5)); });
		// Fine ASCII grid: ~12 character rows per line of text.
		var ch = Math.max(5, px / 12), cw = ch * ACV.measureMono();
		var cols = Math.ceil(W / cw), rows = Math.ceil(H / ch);
		var d = rx.getImageData(0, 0, W, H).data, grid = [];
		var top = rows, bottom = 0;
		for (var y = 0; y < rows; y++) {
			var line = '';
			for (var x = 0; x < cols; x++) {
				var x0 = Math.floor(x * cw), x1 = Math.min(W, Math.floor((x + 1) * cw)), y0 = Math.floor(y * ch), y1 = Math.min(H, Math.floor((y + 1) * ch));
				var sum = 0, n = 0;
				for (var yy = y0; yy < y1; yy += 1) for (var xx = x0; xx < x1; xx += 1) { sum += d[(yy * W + xx) * 4 + 3]; n++; }
				var cov = n ? sum / n / 255 : 0;
				var idx = cov < 0.08 ? 0 : Math.max(1, Math.round(Math.pow(cov, 0.8) * (TITLE_RAMP.length - 1)));
				line += TITLE_RAMP[idx];
			}
			if (line.trim()) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
			grid.push(line);
		}
		grid = grid.slice(top, bottom + 1);
		var pad = Math.ceil(ch * 2.5); // room for the dark halo
		var outW = Math.ceil(cols * cw) + pad * 2, outH = Math.ceil(grid.length * ch) + pad * 2;
		btCanvas.width = Math.round(outW * dpr); btCanvas.height = Math.round(outH * dpr);
		btCanvas.style.width = outW + 'px'; btCanvas.style.height = outH + 'px';
		return { grid: grid, cw: cw, ch: ch, cols: cols, dpr: dpr, w: outW, h: outH, pad: pad, shown: -1 };
	}
	function drawTitleArt(A, progress) {
		var upTo = Math.round(A.cols * progress);
		if (upTo === A.shown) return; // finished: nothing changes, nothing redrawn
		A.shown = upTo;
		var g = btCtx;
		g.setTransform(A.dpr, 0, 0, A.dpr, 0, 0);
		g.clearRect(0, 0, A.w, A.h);
		g.translate(A.pad, A.pad);
		g.font = '700 ' + (A.ch * 1.05).toFixed(2) + 'px ' + MONO_FONT;
		g.textBaseline = 'middle';
		var c = titleTint();
		// Strong contrast: a dark halo pass first, then bright characters tinted with the album colour.
		var cells = [];
		for (var y = 0; y < A.grid.length; y++) {
			var row = A.grid[y];
			for (var x = 0; x < Math.min(upTo, row.length); x++) if (row[x] !== ' ') cells.push([x, y, row[x]]);
		}
		g.shadowColor = 'rgba(0,0,0,1)'; g.shadowBlur = A.ch * 2.2;
		g.fillStyle = 'rgba(0,0,0,0.9)';
		cells.forEach(function (q) { g.fillText(q[2], q[0] * A.cw, (q[1] + 0.5) * A.ch); });
		// Bright pass with a soft glow in the album colour, then a second additive pass so the
		// title is the brightest thing on screen (brighter than the lyrics).
		var own = S.artColor === 'custom';
		g.shadowColor = rgbStr(mix3(c, [1, 1, 1], 0.15), 0.9); g.shadowBlur = A.ch * 1.6;
		cells.forEach(function (q) {
			var k = TITLE_RAMP.indexOf(q[2]) / (TITLE_RAMP.length - 1);
			g.fillStyle = rgbStr(mix3(c, [1, 1, 1], whiten(own, k) * 0.8), 1);
			g.fillText(q[2], q[0] * A.cw, (q[1] + 0.5) * A.ch);
		});
		g.shadowBlur = 0; g.globalCompositeOperation = 'lighter';
		cells.forEach(function (q) {
			var k = TITLE_RAMP.indexOf(q[2]) / (TITLE_RAMP.length - 1);
			g.fillStyle = rgbStr(mix3(c, [1, 1, 1], whiten(own, k) * 0.6), 0.55 + 0.35 * k);
			g.fillText(q[2], q[0] * A.cw, (q[1] + 0.5) * A.ch);
		});
		g.globalCompositeOperation = 'source-over';
	}

	function updateBigTitle(now) {
		if (btEl.hidden) return;
		btEl.classList.toggle('flipped', isBack(flipAngle) || Math.abs(flipGoal - flipAngle) > 0.05 || !!dragging);
		var tt = (now - btStart) / 1000;
		// Position and size are worked out once per song and then frozen, so nothing shifts.
		var r = calmCss();
		if (!r && coverStack.layers.length) return; // wait until the cover is placed
		var cx = window.innerWidth / 2; // always centred on the screen (even when a canvas pushes the cover aside)
		// Title, artist and lyrics read as one stack: sizes follow the lyrics size, with even spacing.
		var LA = lyAnchor(), withLy = !!(S.showLyrics && curLyrics());
		var gapT = withLy ? LA.px * 1.05 : -LA.px * 0.9; // above the lyrics block, or sitting where it would be
		var bottom = LA.top ? LA.y + gapT : LA.y - gapT;
		btEl.classList.toggle('below', LA.top);
		var EDGE = 16, vw = window.innerWidth;
		var fsBox = parseFloat(btEl.style.getPropertyValue('--fs')) || 40;
		// Never wider than the screen (minus the box padding), however long the title is.
		var maxW = Math.max(120, Math.min(vw - EDGE * 2, vw * 0.62));
		if (!card.hidden) { // stay clear of the now-playing card when the title is down on its level
			var cr = card.getBoundingClientRect(), tTop = LA.top ? bottom : bottom - LA.px * 3.2, tBot = LA.top ? bottom + LA.px * 3.2 : bottom;
			if (cr.width && cr.bottom > tTop && cr.top < tBot) {
				var room = cr.left > vw / 2 ? cr.left - cx : cx - cr.right;
				maxW = Math.max(vw * 0.22, Math.min(maxW, (room - 24) * 2));
			}
		}
		// Keep the whole box on screen, even when the cover sits off-centre.
		var bw = btEl.offsetWidth || 0;
		if (bw) cx = Math.max(EDGE + bw / 2, Math.min(vw - EDGE - bw / 2, cx));
		btEl.style.left = cx + 'px';
		btEl.style.top = bottom + 'px';
		btEl.style.maxWidth = maxW + 'px';
		var art = S.titleStyle === 'art';
		btEl.classList.toggle('art', art);
		if (art) {
			// The title is drawn as normal text, then run through a fine ASCII filter (once per song).
			var wb = Math.round(maxW / 120) + '|' + LA.px;
			if (btArtKey !== btText + '|' + S.artSize + '|' + titleTint().join() + '|' + wb) {
				btArtKey = btText + '|' + S.artSize + '|' + titleTint().join() + '|' + wb;
				btArt = buildTitleArt(btText, maxW, 0, Math.max(36, LA.px * 1.9 * (S.artSize / 8)));
				// The finished art (with its halo) must still fit: scale it down if needed.
				var fitK = Math.min(1, maxW / btArt.w);
				btCanvas.style.width = (btArt.w * fitK) + 'px'; btCanvas.style.height = (btArt.h * fitK) + 'px';
			}
			drawTitleArt(btArt, Math.min(1, tt / 0.6));
			btEl.style.setProperty('--acc-rgb', tlColors.acc.map(function (x) { return Math.round(x * 255); }).join(','));
			var ta0 = tt - 0.65;
			var fsA = Math.max(14, LA.px * 0.6);
			btEl.style.setProperty('--fs', fsA.toFixed(0) + 'px');
			// Artist name: the same fine ASCII as the title, inside its box.
			if (btACv.parentNode !== btA) { btA.textContent = ''; btA.appendChild(btACv); }
			var aKey = btArtist + '|' + Math.round(fsA) + '|' + titleTint().join() + '|' + Math.round(maxW);
			if (btArtist && aKey !== btAKey) {
				btAKey = aKey;
				var spaced = /[\u0E00-\u0E7F]/.test(btArtist) ? btArtist : graphemes(btArtist.toUpperCase()).join('\u200A'); // a little letter spacing (not for Thai)
				drawAsciiLines(btACv, btACtx, [{ text: spaced, px: Math.round(fsA * 1.15), weight: '800', fine: 9, boost: 1.4, bright: true }], 'center', titleTint(), false);
				var aw = parseFloat(btACv.style.width), lim = maxW - fsA;
				if (aw > lim) { var ak = lim / aw; btACv.style.width = (aw * ak) + 'px'; btACv.style.height = (parseFloat(btACv.style.height) * ak) + 'px'; }
			}
			var rev = btArtist && ta0 > 0 ? Math.min(1, ta0 / Math.max(0.3, btArtist.length * 0.03)) : 0;
			btA.style.visibility = rev > 0 ? 'visible' : 'hidden';
			btACv.style.clipPath = 'inset(0 ' + ((1 - rev) * 100).toFixed(1) + '% 0 0)';
			return;
		}
		// Normal text, typed in with a little scramble.
		var perChar = Math.min(0.045, 0.9 / Math.max(1, btText.length));
		var shown = Math.floor(tt / perChar), out = '';
		for (var i = 0; i < btText.length; i++) {
			if (i < shown || btText[i] === ' ') out += btText[i];
			else if (i < shown + 3) out += SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)];
		}
		btT.textContent = out;
		var ta = tt - btText.length * perChar - 0.15;
		btA.style.visibility = '';
		btA.textContent = ta > 0 ? btArtist.slice(0, Math.floor(ta / 0.03)) : '';
		var fs = Math.max(24, LA.px * 1.6);
		btEl.style.setProperty('--fs', fs.toFixed(0) + 'px');
	}

	// Text colours for the back of the sleeve, taken from the album: light, vivid accents for
	// readability on the dark sleeve, plus a deep shade of the same hue for the backdrop.
	var tlColors = { acc: [1, 1, 1], deep: [0, 0, 0] };
	function accentFor() { return S.charTextColor === 'white' ? [1, 1, 1] : tlColors.acc; }

	// Draw text into the character layer so the letters are built from ASCII characters.
	// x/y/w are in CSS pixels; the layer is the composite (one pixel per character cell).
	function drawCharText(text, x, y, w, fontPx, color, align, maxLines, flipCx, flipSx) {
		if (!text || w < 4) return false;
		var k = comp.height / window.innerHeight, ax = pixelAspect();
		var fp = fontPx * k;
		if (fp < 3) return false;
		tctx.save();
		tctx.scale(1 / ax, 1);
		if (flipSx != null) { tctx.translate(flipCx * k, 0); tctx.scale(flipSx, 1); tctx.translate(-flipCx * k, 0); }
		tctx.font = '700 ' + fp.toFixed(1) + 'px "ACV Thai", "Leelawadee UI", "Segoe UI", sans-serif';
		tctx.textBaseline = 'top';
		var maxW = w * k;
		// Wrap: by words when there are spaces, otherwise by characters (Thai has no spaces).
		var words = text.indexOf(' ') >= 0 ? text.split(' ') : Array.from(text);
		var sep = text.indexOf(' ') >= 0 ? ' ' : '';
		var lines = [], cur = '';
		words.forEach(function (wd) {
			var test = cur ? cur + sep + wd : wd;
			if (tctx.measureText(test).width <= maxW || !cur) cur = test; else { lines.push(cur); cur = wd; }
		});
		if (cur) lines.push(cur);
		if (lines.length > maxLines) {
			lines = lines.slice(0, maxLines);
			var last = lines[maxLines - 1];
			while (last.length > 1 && tctx.measureText(last + '\u2026').width > maxW) last = last.slice(0, -1);
			lines[maxLines - 1] = last + '\u2026';
		}
		var lh = fp * 1.12;
		tctx.lineJoin = 'round';
		tctx.lineWidth = Math.max(1, fp * 0.22);
		tctx.strokeStyle = 'rgba(0,0,0,0.3)';
		tctx.fillStyle = rgbStr(color);
		lines.forEach(function (ln, i) {
			var lw = tctx.measureText(ln).width;
			var lx = align === 'center' ? x * k + (maxW - lw) / 2 : x * k;
			tctx.strokeText(ln, lx, y * k + i * lh);
		});
		lines.forEach(function (ln, i) {
			var lw = tctx.measureText(ln).width;
			var lx = align === 'center' ? x * k + (maxW - lw) / 2 : x * k;
			tctx.fillText(ln, lx, y * k + i * lh);
		});
		tctx.restore();
		return true;
	}

	function updateTlAccent() {
		try {
			var src = (albumColors || []).concat(albumBarColors());
			var byColour = src.slice().sort(function (a, b) { return rgb2hsl(b)[1] - rgb2hsl(a)[1]; });
			var c1 = rgb2hsl(byColour[0] || [1, 1, 1]);
			var c2 = rgb2hsl(byColour.find(function (c) { var h = rgb2hsl(c); var d = Math.abs(h[0] - c1[0]); return Math.min(d, 1 - d) > 0.06; }) || byColour[1] || byColour[0] || [1, 1, 1]);
			function v(hsl) { return hsl2rgb(hsl).map(function (x) { return Math.round(x * 255); }).join(','); }
			tlColors = { acc: hsl2rgb([c1[0], Math.max(c1[1], 0.55), 0.74]), deep: hsl2rgb([c1[0], Math.min(0.55, c1[1]), 0.07]) };
			tlEl.style.setProperty('--acc', v([c1[0], Math.max(c1[1], 0.55), 0.74]));
			btEl.style.setProperty('--acc', v([c1[0], Math.max(c1[1], 0.55), 0.74]));
			tlEl.style.setProperty('--acc2', v([c2[0], Math.max(c2[1], 0.45), 0.8]));
			tlEl.style.setProperty('--ink', v([c1[0], Math.min(0.5, c1[1]), 0.95]));
			tlEl.style.setProperty('--deep', v([c1[0], Math.min(0.55, c1[1]), 0.07]));
		} catch (e) { /* palette not ready yet */ }
	}

	// ---------- back of the sleeve: one ASCII "screen" on a single character grid ----------
	var bgEl = document.getElementById('backgrid'), bgCtx = bgEl.getContext('2d'), bgKey = '';
	var MONO_FONT = 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace';
	if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { bgKey = ''; btArtKey = ''; ckKey = ''; btAKey = ''; lyKey = ''; cardArtKey = ''; if (lastC) updateCard(lastC); });

	function graphemes(str) {
		str = String(str || '');
		if (window.Intl && Intl.Segmenter) {
			try { return Array.from(new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(str), function (x) { return x.segment; }); } catch (e) { /* fall back */ }
		}
		var out = [];
		Array.from(str).forEach(function (ch) {
			if (out.length && /[ัิ-ฺ็-๎̀-ͯ]/.test(ch)) out[out.length - 1] += ch; else out.push(ch);
		});
		return out;
	}
	function fitCells(str, n) {
		var g = graphemes(str);
		if (g.length <= n) return g;
		return g.slice(0, Math.max(0, n - 1)).concat(['…']);
	}
	function css(c, a) { return rgbStr(c, a); }

	var bgPending = '', bgPendingAt = 0, bgPos = '', backMs = 0, backRenders = 0;
	function backKey(r) {
		var L0 = coverStack.layers[coverStack.layers.length - 1];
		return [Math.round(r.w), Math.round(r.h), tlKey, tlCurrent, S.textBackName, S.textBackMeta, S.textBackLeft, S.textBackRight, titleTint().join(), S.artSize, tlColors.acc.join(), L0 ? (L0.el.currentSrc || L0.el.src || '') : ''].join('|');
	}
	// Draw the back ahead of time, while the front is showing and nothing is moving, so turning it around never stalls.
	function ensureBack(r, now, urgent) {
		var key = backKey(r);
		if (key === bgKey) return;
		if (!urgent) {
			if (key !== bgPending) { bgPending = key; bgPendingAt = now; return; }
			if (now - bgPendingAt < 300) return; // wait until the cover / tracklist has settled
		}
		bgKey = key;
		var t0 = performance.now();
		renderBackGrid(Math.round(r.w), Math.round(r.h));
		backMs = Math.round(performance.now() - t0); backRenders++;
	}
	function placeBack() {
		var r = calmCss(), now = performance.now();
		var back = isBack(flipAngle);
		if (r && curAlbum) {
			var calm = !spinAnim && !dragging && Math.abs(flipVel) < 0.3;
			if (calm || (back && !fastSpin())) ensureBack(r, now, back && !fastSpin());
		}
		if (!r || !curAlbum || !back || fastSpin()) { if (!bgEl.hidden) bgEl.hidden = true; tlEl.hidden = true; return; }
		tlEl.hidden = true;
		bgEl.hidden = false;
		var sx = -Math.cos(flipAngle); // 0 → 1 as the back turns towards us
		bgEl.style.transform = 'scaleX(' + sx.toFixed(4) + ')';
		bgEl.style.filter = 'brightness(' + (0.4 + 0.6 * sx).toFixed(3) + ')';
		var pos = [r.x, r.y, r.w, r.h].join('|');
		if (pos === bgPos) return;
		bgPos = pos;
		bgEl.style.left = r.x + 'px'; bgEl.style.top = r.y + 'px';
		bgEl.style.width = r.w + 'px'; bgEl.style.height = r.h + 'px';
	}

	function renderBackGrid(Wd, Ht) {
		// The back shows the same cover as the front (drawn by the main ASCII filter underneath).
		// This layer only holds the text: drawn normally, then turned into fine ASCII like the big song title.
		var dpr = window.devicePixelRatio || 1, SS = 2; // text is laid out at 2x for clean sampling
		var tracks = curAlbum.tracks, n = tracks.length;
		var UI = artFont();
		var big0 = Ht * 0.11, pad = Wd * 0.07, innerW = Wd - pad * 2;
		function layer() { var c = document.createElement('canvas'); c.width = Wd * SS; c.height = Ht * SS; var g = c.getContext('2d', { willReadFrequently: true }); g.scale(SS, SS); g.textBaseline = 'top'; g.fillStyle = '#fff'; return { c: c, g: g }; }
		var bigL = layer(), smL = layer(), x = bigL.g;
		function fitText(g, t, px, weight, maxW) {
			g.font = weight + ' ' + px + 'px ' + UI;
			if (g.measureText(t).width <= maxW) return t;
			var gr = graphemes(t);
			while (gr.length > 1 && g.measureText(gr.join('') + '…').width > maxW) gr.pop();
			return gr.join('') + '…';
		}
		var y = pad * 0.9;
		var kind = n === 1 ? 'SINGLE' : n <= 6 ? 'EP' : 'ALBUM';
		// Album name: as large as fits, up to two lines (big layer, coarser ASCII like the title).
		var tv = textVars();
		var big = big0, name = fillText(S.textBackName, tv);
		x.font = '800 ' + big + 'px ' + UI;
		var nameLines = [name];
		if (x.measureText(name).width > innerW) {
			var fitPx = big * innerW / x.measureText(name).width;
			if (fitPx > big * 0.6) big = fitPx;
			else {
				big *= 0.7; x.font = '800 ' + big + 'px ' + UI;
				var words = name.split(' '), l1 = '';
				while (words.length && x.measureText((l1 ? l1 + ' ' : '') + words[0]).width <= innerW) l1 += (l1 ? ' ' : '') + words.shift();
				nameLines = l1 ? [l1, words.join(' ')] : [name];
			}
		}
		if (name) {
			nameLines.slice(0, 2).forEach(function (ln, i) { x.fillText(fitText(x, ln, big, '800', innerW), pad, y + i * big * 1.12); });
			y += big * 1.12 * Math.min(2, nameLines.length) + big * 0.25;
		}
		var bigCh = Math.max(3, big / 12);

		// Everything else: small layer, finer ASCII.
		var g2 = smL.g, meta = Ht * 0.042;
		g2.globalAlpha = 0.95;
		var metaTxt = fillText(S.textBackMeta, tv);
		if (metaTxt) { g2.fillText(fitText(g2, metaTxt, meta, '800', innerW), pad, y); y += meta * 2; }
		else y += meta * 0.6;
		var footH = Ht * 0.07, avail = Ht - y - footH - pad * 0.5;
		var two = n > 8, per = two ? Math.ceil(n / 2) : n;
		var rowH = Math.min(Ht * 0.052, avail / Math.max(per, 1));
		var fs = rowH * 0.68, colW = two ? (innerW - pad * 0.5) / 2 : innerW;
		var start = 0, visible = Math.min(n, Math.floor(avail / rowH) * (two ? 2 : 1));
		if (n > visible) start = Math.max(0, Math.min(n - visible, (tlCurrent < 0 ? 0 : tlCurrent) - Math.floor(visible / 2)));
		for (var k = 0; k < visible && start + k < n; k++) {
			var i = start + k, t = tracks[i], now = i === tlCurrent;
			var col = two ? Math.floor(k / per) : 0, rr = two ? k % per : k;
			var x0 = pad + col * (colW + pad * 0.5), y0 = y + rr * rowH;
			var tag = now ? '<' : fmtTime(t.ms);
			g2.font = '800 ' + fs + 'px ' + UI;
			var tagW = g2.measureText(tag).width, num = now ? '>' : String(t.n || i + 1);
			var numW = g2.measureText('00').width + fs * 0.35;
			g2.globalAlpha = now ? 1 : 0.8; // the playing song is the brightest
			g2.fillText(num, x0, y0);
			g2.fillText(fitText(g2, t.title, fs, '800', colW - numW - tagW - fs * 0.6), x0 + numW, y0);
			g2.font = '800 ' + fs + 'px ' + UI;
			g2.fillText(tag, x0 + colW - tagW, y0);
		}
		var total = tracks.reduce(function (s2, tt) { return s2 + (tt.ms || 0); }, 0);
		g2.globalAlpha = 0.8;
		g2.font = '800 ' + meta * 0.85 + 'px ' + UI;
		var fy = Ht - pad * 0.6 - meta;
		var fl = fillText(S.textBackLeft, tv), fr = fillText(S.textBackRight, tv);
		if (n === 1) fr = fr.replace(/\b1 SONGS\b/, '1 SONG');
		var frW = fr ? g2.measureText(fr).width : 0;
		if (fl) g2.fillText(fitText(g2, fl, meta * 0.85, '800', innerW - frW - pad * 0.5), pad, fy);
		if (fr) g2.fillText(fr, Wd - pad - frW, fy);
		var smCh = Math.max(2, Math.min(4, fs / 6));

		// Turn both layers into ASCII on one transparent canvas: a soft dark halo, then bright characters.
		var BW = Math.round(Wd * dpr), BH = Math.round(Ht * dpr);
		var txt = document.createElement('canvas'); txt.width = BW; txt.height = BH;
		var tg = txt.getContext('2d');
		// Same look as the big song title: fine characters, brighter and whiter where the text is denser,
		// tinted with the title colour (album / white / green, from the "art colour" setting).
		var tc0 = titleTint();
		var levelStyle = [];
		for (var lv = 1; lv < TITLE_RAMP.length; lv++) { var kk = lv / (TITLE_RAMP.length - 1); levelStyle[lv] = rgbStr(mix3(tc0, [1, 1, 1], whiten(S.artColor === 'custom', kk)), 0.85 + 0.15 * kk); }
		function asciiOf(L, ch) {
			var cw = ch * ACV.measureMono(), cols = Math.floor(Wd / cw), rows = Math.floor(Ht / ch);
			var W2 = Wd * SS, d = L.g.getImageData(0, 0, W2, Ht * SS).data;
			tg.setTransform(dpr, 0, 0, dpr, 0, 0);
			var fpx = ch * 1.05;
			tg.font = '700 ' + fpx.toFixed(2) + 'px ' + MONO_FONT;
			var adv = tg.measureText('@@@@@@@@@@').width / 10;
			if (adv > 0) { fpx *= cw / adv; tg.font = '700 ' + fpx.toFixed(2) + 'px ' + MONO_FONT; }
			tg.textBaseline = 'middle';
			for (var cy = 0; cy < rows; cy++) {
				var lev = [], used = {};
				var ya = Math.floor(cy * ch * SS), yb = Math.floor((cy + 1) * ch * SS);
				for (var cx = 0; cx < cols; cx++) {
					var xa = Math.floor(cx * cw * SS), xb = Math.floor((cx + 1) * cw * SS), sum = 0, cnt = 0;
					for (var yy = ya; yy < yb; yy += 1) { var o = (yy * W2 + xa) * 4 + 3; for (var xx = xa; xx < xb; xx++, o += 4) { sum += d[o]; cnt++; } }
					var cov = cnt ? sum / cnt / 255 : 0;
					var idx = cov < 0.08 ? 0 : Math.max(1, Math.round(Math.pow(cov, 0.8) * (TITLE_RAMP.length - 1)));
					lev.push(idx); if (idx) used[idx] = true;
				}
				// one fillText per brightness level per row (each level has its own colour)
				for (var key in used) {
					var L2 = +key, line = '';
					for (cx = 0; cx < cols; cx++) line += lev[cx] === L2 ? TITLE_RAMP[L2] : ' ';
					tg.fillStyle = levelStyle[L2];
					tg.fillText(line, 0, (cy + 0.5) * ch, cols * cw); // exact row width (tiny fonts round their spacing)
				}
			}
		}
		asciiOf(bigL, bigCh);
		asciiOf(smL, smCh);

		bgEl.width = BW; bgEl.height = BH;
		var g = bgCtx;
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.clearRect(0, 0, BW, BH);
		// Dark halo behind the characters (like the big title), so the text reads on any cover.
		[[bigL, bigCh], [smL, smCh]].forEach(function (pr) {
			g.filter = 'brightness(0) blur(' + (pr[1] * dpr * 1.3).toFixed(1) + 'px)';
			for (var pass = 0; pass < 3; pass++) g.drawImage(pr[0].c, 0, 0, BW, BH);
		});
		g.filter = 'none';
		g.drawImage(txt, 0, 0);
	}


	var artCache = {};
	function artLayout(name, innerPx, f, ratio) {
		var key = name + '|' + Math.round(innerPx) + '|' + f;
		if (artCache[key]) return artCache[key];
		function widest(ls) { return ls.reduce(function (m, l) { return Math.max(m, l.length); }, 1); }
		var one = ACV.asciiArt(name, { maxCols: 2000, rows: 12, maxLines: 1, font: artFont() });
		var af = innerPx / (widest(one) * ratio * 1.03), res;
		if (af >= f * 0.4) res = { lines: one, af: Math.min(af, f * 0.85) };
		else {
			var af2 = f * 0.42, maxCols = Math.floor(innerPx / (af2 * ratio * 1.03));
			var two = ACV.asciiArt(name, { maxCols: maxCols, rows: 11, maxLines: 2, font: artFont() });
			res = { lines: two, af: Math.min(f * 0.6, innerPx / (widest(two) * ratio * 1.03)) };
		}
		artCache[key] = res;
		return res;
	}

	function sampleCover(cols, rows) {
		var L0 = coverStack.layers[coverStack.layers.length - 1];
		if (!L0) return null;
		try {
			var cv = document.createElement('canvas'); cv.width = cols; cv.height = rows;
			var c2 = cv.getContext('2d', { willReadFrequently: true });
			c2.imageSmoothingQuality = 'high';
			// The grid covers the sleeve exactly, and the sleeve has the cover's shape, so a straight stretch lines up.
			c2.drawImage(L0.el, 0, 0, cols, rows);
			var d = c2.getImageData(0, 0, cols, rows).data, out = new Array(cols * rows);
			for (var i = 0; i < out.length; i++) out[i] = [d[i * 4] / 255, d[i * 4 + 1] / 255, d[i * 4 + 2] / 255];
			return out;
		} catch (e) { return null; }
	}

	function drawIdle(w, h, t) {
		var g = cctx.createRadialGradient(w * (0.5 + 0.3 * Math.sin(t * 0.13)), h * (0.5 + 0.3 * Math.cos(t * 0.17)), 0, w / 2, h / 2, Math.max(w, h) * 0.8);
		g.addColorStop(0, 'rgba(120,120,140,0.55)');
		g.addColorStop(1, 'rgba(0,0,0,1)');
		cctx.fillStyle = g;
		cctx.fillRect(0, 0, w, h);
	}

	// ---------- colour helpers ----------
	function rgbStr(c, a) {
		return 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ',' + (a == null ? 1 : a) + ')';
	}
	function mix3(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
	function luma(c) { return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; }
	function relLum(c) {
		function f(x) { return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
		return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
	}
	function contrastRatio(a, b) { var x = relLum(a), y = relLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
	function saturation(c) { var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]); return mx ? (mx - mn) / mx : 0; }
	function rgb2hsl(c) {
		var r = c[0], g = c[1], b = c[2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, s2, l = (mx + mn) / 2;
		if (mx === mn) { s2 = 0; } else {
			var d = mx - mn;
			s2 = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
			h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
			h /= 6;
		}
		return [h, s2, l];
	}
	function hsl2rgb(x) {
		var h = x[0], s2 = x[1], l = x[2];
		if (!s2) return [l, l, l];
		function f(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
		var q = l < 0.5 ? l * (1 + s2) : l + s2 - l * s2, p = 2 * l - q;
		return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
	}
	// Reach the wanted contrast by changing lightness only, so the hue stays the album's.
	function ensureContrastHue(c, bg, want) {
		if (contrastRatio(c, bg) >= want) return c;
		var hsl = rgb2hsl(c), up = relLum(bg) < 0.18;
		var sat = Math.min(1, hsl[1] * 1.1);
		for (var i = 1; i <= 20; i++) {
			var l = up ? hsl[2] + (1 - hsl[2]) * i / 20 : hsl[2] * (1 - i / 20);
			var m = hsl2rgb([hsl[0], sat, Math.min(0.92, Math.max(0.06, l))]);
			if (contrastRatio(m, bg) >= want) return m;
		}
		return hsl2rgb([hsl[0], sat, up ? 0.85 : 0.12]);
	}

	// ---------- colours taken from the album cover itself ----------
	var albumColors = null; // most characteristic colours of the current cover, best first
	function extractAlbumColors(img) {
		try {
			var cv = document.createElement('canvas'); cv.width = 48; cv.height = 48;
			var cx2 = cv.getContext('2d', { willReadFrequently: true });
			cx2.drawImage(img, 0, 0, 48, 48);
			var d = cx2.getImageData(0, 0, 48, 48).data, buckets = {};
			for (var i = 0; i < d.length; i += 4) {
				var key = (d[i] >> 4) + '_' + (d[i + 1] >> 4) + '_' + (d[i + 2] >> 4);
				var bk = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, b: 0 });
				bk.n++; bk.r += d[i]; bk.g += d[i + 1]; bk.b += d[i + 2];
			}
			var list = Object.keys(buckets).map(function (k) {
				var bk = buckets[k], c = [bk.r / bk.n / 255, bk.g / bk.n / 255, bk.b / bk.n / 255], hsl = rgb2hsl(c);
				var lumOk = hsl[2] > 0.12 && hsl[2] < 0.92 ? 1 : 0.15;
				return { c: c, hsl: hsl, score: bk.n * (0.25 + hsl[1] * 1.5) * lumOk };
			}).sort(function (a, b) { return b.score - a.score; });
			var picked = [];
			list.forEach(function (o) {
				if (picked.length >= 5) return;
				var distinct = picked.every(function (p2) {
					var dh = Math.abs(o.hsl[0] - p2.hsl[0]); dh = Math.min(dh, 1 - dh);
					return dh > 0.07 || Math.abs(o.hsl[2] - p2.hsl[2]) > 0.25;
				});
				if (distinct) picked.push(o);
			});
			return picked.length ? picked.map(function (o) { return o.c; }) : null;
		} catch (e) { return null; } // tainted image: fall back to Wallpaper Engine's colours
	}

	// Push a colour lighter or darker until it reaches the wanted contrast against bg.
	function ensureContrast(c, bg, want) {
		if (contrastRatio(c, bg) >= want) return c;
		var target = relLum(bg) > 0.18 ? [0, 0, 0] : [1, 1, 1];
		for (var k = 0.1; k <= 1.001; k += 0.1) {
			var m = mix3(c, target, k);
			if (contrastRatio(m, bg) >= want) return m;
		}
		return target;
	}

	// ---------- album palette (stretched so dark and bright ends differ clearly) ----------
	var palette = { a: [1, 1, 1], b: [0.6, 0.6, 0.7], c: [0.15, 0.15, 0.2] };
	var paletteTarget = null, paletteSrc = null;
	function buildPalette(col) {
		var list = (albumColors ? albumColors.slice(0, 4) : []).concat(col ? [col.primary, col.secondary, col.tertiary, col.text] : []).filter(Boolean);
		if (!list.length) return null;
		list.sort(function (x, y) { return luma(x) - luma(y); });
		var dark = list[0], bright = list[list.length - 1];
		var mid = list.length > 2 ? list[Math.floor(list.length / 2)] : mix3(dark, bright, 0.5);
		// Saturated middle reads better than a muddy one.
		if (saturation(mid) < 0.25) { var sat = list.slice().sort(function (x, y) { return saturation(y) - saturation(x); })[0]; if (saturation(sat) > saturation(mid)) mid = sat; }
		dark = mix3(dark, [0, 0, 0], 0.45);
		bright = mix3(bright, [1, 1, 1], 0.3);
		while (luma(bright) - luma(dark) < 0.55 && luma(bright) < 0.97) bright = mix3(bright, [1, 1, 1], 0.25);
		return { a: bright, b: mid, c: dark };
	}
	function updatePalette(dt) {
		var col = M.we.colors;
		var srcKey = col || albumColors;
		if (srcKey && srcKey !== paletteSrc) { paletteSrc = srcKey; paletteTarget = buildPalette(col); }
		if (!paletteTarget) return;
		var k = 1 - Math.exp(-dt * 2);
		['a', 'b', 'c'].forEach(function (key) { palette[key] = mix3(palette[key], paletteTarget[key], k); });
	}

	// What a colour from the composite roughly looks like on screen after the ASCII pass.
	function perceived(avg) {
		if (!S.ascii) return avg;
		var l = Math.max(0, Math.min(1, (luma(avg) - 0.5) * S.contrast + 0.5 + S.brightness));
		var col;
		if (S.colorMode === 'palette') col = l < 0.5 ? mix3(palette.c, palette.b, l * 2) : mix3(palette.b, palette.a, (l - 0.5) * 2);
		else if (S.colorMode === 'mono') col = S.monoColor.map(function (x) { return x * (0.35 + 0.65 * l); });
		else col = avg;
		var back = S.bgColor.map(function (x, i) { return Math.min(1, x + avg[i] * S.bgTint); });
		return mix3(back, col, 0.15 + 0.45 * l); // characters only cover part of each cell
	}

	// ---------- automatic bar colour: whatever stands out most from what's behind the bars ----------
	var barBg = [0, 0, 0], autoTarget = [1, 1, 1], autoColor = [1, 1, 1], lastSample = 0;
	function sampleBehindBars(w, h) {
		var maxH = h * B.barHeight, off = h * B.barOffset, y0, y1, x0 = 0, x1 = w;
		switch (B.barStyle) {
			case 'top': y0 = off; y1 = off + maxH; break;
			case 'mirror': y0 = h / 2 - maxH / 2; y1 = h / 2 + maxH / 2; break;
			case 'ring': y0 = h * 0.15; y1 = h * 0.85; x0 = w * 0.25; x1 = w * 0.75; break;
			default: y0 = h - off - maxH; y1 = h - off;
		}
		y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(h, Math.ceil(y1)); x0 = Math.floor(x0); x1 = Math.ceil(x1);
		if (y1 - y0 < 1 || x1 - x0 < 1) return;
		var d;
		try { d = cctx.getImageData(x0, y0, x1 - x0, y1 - y0).data; } catch (e) { return; }
		var step = Math.max(1, Math.floor(d.length / 4 / 4000)) * 4, r = 0, g = 0, b = 0, n = 0;
		for (var i = 0; i < d.length; i += step) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
		if (!n) return;
		var avg = [r / n / 255, g / n / 255, b / n / 255];
		barBg = perceived(avg);
		// The colour the characters around the bars are drawn in: bars should differ from it too.
		var charCol;
		if (S.ascii && S.colorMode === 'palette') charCol = mix3(palette.b, palette.a, 0.6);
		else if (S.ascii && S.colorMode === 'mono') charCol = S.monoColor;
		else { var m0 = Math.max(avg[0], avg[1], avg[2], 0.04); charCol = avg.map(function (x) { return x / m0; }); }
		function complement(c) {
			var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
			return [mx + mn - c[0], mx + mn - c[1], mx + mn - c[2]].map(function (x) { return Math.min(1, x * 1.3 + 0.2); });
		}
		function dist(a, b) { return Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2])); }
		var cands = [palette.a, palette.b, palette.c, [1, 1, 1], complement(charCol), complement(avg), complement(palette.b)].concat(albumColors || []);
		var best = cands[0], bestScore = -1;
		cands.forEach(function (c) {
			var cc = ensureContrast(c, barBg, 4.5);
			// Every candidate already has readable contrast; prefer ones that differ from the
			// characters' colour and have some colour of their own.
			var score = (0.3 + Math.min(1, dist(cc, charCol))) * (1 + saturation(cc)) * (1 + 0.04 * Math.min(contrastRatio(cc, barBg), 10));
			if (score > bestScore) { bestScore = score; best = cc; }
		});
		autoTarget = ensureContrast(best, barBg, 4.5);
	}

	// The album's vivid colours for palette bars (cached until the cover changes).
	var barColsCache = null, barColsFor = null;
	function albumBarColors() {
		var key = albumColors || M.we.colors;
		if (barColsCache && barColsFor === key) return barColsCache;
		var list = albumColors ? albumColors.slice() : [];
		var wc = M.we.colors;
		if (wc) list = list.concat([wc.secondary, wc.tertiary, wc.primary].filter(Boolean));
		// Prefer colourful ones; keep up to three for a gradient across the bars.
		list = list.filter(function (c) { return rgb2hsl(c)[1] > 0.2; }).slice(0, 3);
		if (!list.length) list = [palette.b, palette.a];
		if (list.length === 1) { var h = rgb2hsl(list[0]); list.push(hsl2rgb([h[0], h[1], Math.min(0.85, h[2] + 0.25)])); }
		barColsCache = list; barColsFor = key;
		return list;
	}

	function barColor(i, n, v, t) {
		switch (S.barColorMode) {
			case 'custom': return rgbStr(S.barColor);
			case 'white': return '#fff';
			case 'palette': {
				var cols = albumBarColors();
				var pos = n > 1 ? (i / (n - 1)) * (cols.length - 1) : 0;
				var k0 = Math.floor(pos), k1 = Math.min(cols.length - 1, k0 + 1);
				var c = mix3(cols[k0], cols[k1], pos - k0);
				var hsl = rgb2hsl(c); // louder = a touch brighter
				c = hsl2rgb([hsl[0], hsl[1], Math.min(0.9, hsl[2] + 0.12 * Math.min(1, v))]);
				return rgbStr(ensureContrastHue(c, barBg, 3));
			}
			case 'rainbow': return 'hsl(' + ((i / n) * 300 + t * 25) % 360 + ',90%,' + (55 + 15 * Math.min(1, v)) + '%)';
			default: return rgbStr(autoColor); // auto
		}
	}

	// ---------- visualizer bars ----------
	// ctx/w/h: target canvas; ax = how wide one pixel is vs. tall (character cells are narrow),
	// so shapes are laid out in square "screen units". what: 'backdrop', 'bars' or 'both'.
	function drawBars(ctx, w, h, ax, t, what) {
		var n = Math.max(4, Math.round(B.barCount));
		var vw = w * ax;
		var style = B.barStyle;
		var maxH = h * B.barHeight;
		var off = h * B.barOffset;
		ctx.save();
		ctx.scale(1 / ax, 1);

		if (what !== 'bars' && S.barBackdrop && style !== 'ring') {
			var g, k = B.barBackdropStrength;
			if (style === 'mirror') {
				g = ctx.createLinearGradient(0, h / 2 - maxH / 2 - h * 0.08, 0, h / 2 + maxH / 2 + h * 0.08);
				g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.3, 'rgba(0,0,0,' + k + ')');
				g.addColorStop(0.7, 'rgba(0,0,0,' + k + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
			} else if (style === 'top') {
				g = ctx.createLinearGradient(0, 0, 0, off + maxH + h * 0.12);
				g.addColorStop(0, 'rgba(0,0,0,' + Math.min(1, k * 1.25) + ')'); g.addColorStop(0.55, 'rgba(0,0,0,' + k + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
			} else {
				g = ctx.createLinearGradient(0, h - off - maxH - h * 0.12, 0, h);
				g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.45, 'rgba(0,0,0,' + k + ')'); g.addColorStop(1, 'rgba(0,0,0,' + Math.min(1, k * 1.25) + ')');
			}
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, vw, h);
		} else if (what !== 'bars' && S.barBackdrop && style === 'ring') {
			var cx0 = vw / 2, cy0 = h / 2, rr = Math.min(vw, h) * B.barRingRadius;
			var rg = ctx.createRadialGradient(cx0, cy0, rr * 0.9, cx0, cy0, rr + maxH * 0.7);
			rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.2, 'rgba(0,0,0,' + B.barBackdropStrength + ')'); rg.addColorStop(1, 'rgba(0,0,0,0)');
			ctx.fillStyle = rg;
			ctx.fillRect(0, 0, vw, h);
		}
		if (what === 'backdrop') { ctx.restore(); return; }

		var sens = B.barSensitivity * (0.6 + 0.4 * S.reactivity);
		var range = Math.max(0.2, Math.min(1, B.barRange));
		var vals = new Array(n);
		for (var i = 0; i < n; i++) {
			var x;
			if (style === 'split') x = Math.abs(i + 0.5 - n / 2) / (n / 2);
			else if (style === 'ring') x = 1 - Math.abs((i / n) * 2 - 1); // bass at the top, mirrored left/right
			else x = i / (n - 1);
			vals[i] = Math.min(1.2, A.sample(x * range) * sens);
		}

		if (style === 'ring') {
			var cx = vw / 2, cy = h / 2;
			var r0 = Math.min(vw, h) * B.barRingRadius;
			ctx.lineCap = 'butt';
			ctx.lineWidth = Math.max(1, (2 * Math.PI * r0 / n) * B.barWidth);
			for (var j = 0; j < n; j++) {
				var len = vals[j] * maxH * 0.6;
				if (len < 0.5) continue;
				var ang = (j / n) * Math.PI * 2 - Math.PI / 2;
				var ca = Math.cos(ang), sa = Math.sin(ang);
				ctx.strokeStyle = barColor(j, n, vals[j], t);
				ctx.beginPath();
				ctx.moveTo(cx + ca * r0, cy + sa * r0);
				ctx.lineTo(cx + ca * (r0 + len), cy + sa * (r0 + len));
				ctx.stroke();
			}
		} else {
			var gap = vw / n;
			var bw = Math.max(0.5, gap * B.barWidth);
			for (var q = 0; q < n; q++) {
				var bh = Math.min(maxH, vals[q] * maxH);
				if (bh < 0.5) continue;
				var bx = q * gap + (gap - bw) / 2;
				ctx.fillStyle = barColor(q, n, vals[q], t);
				if (style === 'mirror') ctx.fillRect(bx, h / 2 - bh / 2, bw, bh);
				else if (style === 'top') ctx.fillRect(bx, off, bw, bh);
				else ctx.fillRect(bx, h - off - bh, bw, bh);
			}
		}
		ctx.restore();
	}

	var last = performance.now(), lastDraw = 0, t0 = last;
	function frame(now) {
		requestAnimationFrame(frame);
		if (ACV.paused) { last = now; return; }
		if (S.fpsLimit > 0 && now - lastDraw < 1000 / S.fpsLimit - 1) return;
		lastDraw = now;
		var dt = Math.min(0.1, (now - last) / 1000); last = now;
		var t = (now - t0) / 1000;

		B = ACV.barSettings();
		A.update(dt);
		updatePalette(dt);

		var w = comp.width, h = comp.height;
		cctx.globalAlpha = 1;
		cctx.fillStyle = '#000';
		cctx.fillRect(0, 0, w, h);
		cctx.imageSmoothingEnabled = true;
		cctx.imageSmoothingQuality = 'high';

		coverStack.update(dt);
		videoStack.update(dt);
		var vTarget = videoStack.presence();
		videoPresence += (vTarget - videoPresence) * (1 - Math.exp(-dt * 3));
		if (Math.abs(vTarget - videoPresence) < 0.002) videoPresence = vTarget;

		var react = S.reactivity;
		var pulseZoom = 1 + A.bass * 0.025 * react;
		updateFlip(dt, now);
		if (!coverStack.layers.length && !videoStack.layers.length) { coverRect = null; drawIdle(w, h, t); }
		else drawScene(w, h, now, pulseZoom);
		placeBack();
		updateBigTitle(now);
		updateClock();
		updateLyrics();
		cctx.globalAlpha = 1;
		if (S.imageDim > 0) { cctx.fillStyle = 'rgba(0,0,0,' + S.imageDim + ')'; cctx.fillRect(0, 0, w, h); }

		// Bars: backdrop goes into the image; the bars themselves go on one of three layers.
		var ax = pixelAspect();
		var mode = !S.showBars ? 'off' : !S.ascii ? 'image' : S.barAscii ? 'ascii' : 'overlay';
		if (mode !== 'off') {
			drawBars(cctx, w, h, ax, t, 'backdrop');
			if (now - lastSample > 250) { lastSample = now; sampleBehindBars(w, h); }
			autoColor = mix3(autoColor, autoTarget, 1 - Math.exp(-dt * 3));
		}
		if (mode === 'image') drawBars(cctx, w, h, ax, t, 'bars');

		var sleeve = isBack(flipAngle) && !fastSpin() && coverRect ? coverRect : null; // bars stay off the back of the cover
		if (mode === 'ascii') {
			if (barsCanvas.width !== w || barsCanvas.height !== h) { barsCanvas.width = w; barsCanvas.height = h; }
			bctx.clearRect(0, 0, w, h);
			drawBars(bctx, w, h, ax, t, 'bars');
			if (sleeve) bctx.clearRect(sleeve.x / ax, sleeve.y, sleeve.w / ax, sleeve.h);
			ascii.setBars(barsCanvas);
		}

		if (mode === 'overlay') {
			if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
			octx.clearRect(0, 0, W, H);
			drawBars(octx, W, H, 1, t, 'bars');
			if (sleeve) { var sk = W / sleeve.vw, sky = H / sleeve.sh; octx.clearRect(sleeve.x * sk, sleeve.y * sky, sleeve.w * sk, sleeve.h * sky); }
			overlay.style.display = '';
			overlayUsed = true;
		} else if (overlayUsed) {
			octx.clearRect(0, 0, overlay.width, overlay.height);
			overlay.style.display = 'none';
			overlayUsed = false;
		}

		var textOn = false;

		ascii.setSource(comp, !S.ascii);
		var modes = { source: 0, palette: 1, mono: 2 };
		ascii.render({
			ascii: S.ascii,
			cellW: cellW, cellH: cellH, cols: cols, rows: rows,
			contrast: S.contrast,
			brightness: S.brightness,
			pulse: A.bass * 0.12 * react,
			flash: S.beatFlash ? A.beat * 0.28 * Math.min(1, react) : 0,
			mode: modes[S.colorMode] || 0,
			scanlines: S.scanlines,
			tint: S.ascii ? S.bgTint : 0,
			barMode: mode === 'ascii' ? (B.barGlyph === 'blocks' ? 2 : 1) : 0,
			textOn: textOn,
			textShade: tlColors.deep,
			mono: S.monoColor, bg: S.bgColor,
			palA: palette.a, palB: palette.b, palC: palette.c
		});

		// Card: progress + glow follow the music.
		if (S.showCard) {
			var p = M.progress();
			cardBar.style.transform = 'scaleX(' + (p < 0 ? 0 : p) + ')';
			cardBar.parentNode.hidden = p < 0;
			card.style.setProperty('--glow', (A.bass * react).toFixed(3));
		}
	}

	applyFonts();
	applyCardSettings();
	layout();
	refresh();
	requestAnimationFrame(frame);

	ACV.debug = function () {
		return { cols: cols, rows: rows, cellW: cellW, cellH: cellH, chars: ascii.chars, layers: coverStack.layers.length + videoStack.layers.length, video: videoPresence, flip: flipAngle, barCols: albumBarColors().map(function (c) { return c.map(function (v) { return Math.round(v * 255); }); }), current: M.current(), audio: { bass: A.bass, beat: A.beat, demo: A.demo }, backMs: backMs, backRenders: backRenders, backHidden: bgEl.hidden };
	};
})();

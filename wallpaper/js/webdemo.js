/* Web demo: runs only in a normal browser (not inside Wallpaper Engine).
   Shows a built-in demo song, and lets the visitor play their own audio file or use the
   microphone so the bars react to real sound through the Web Audio API.
   Nothing is uploaded: files are played locally in the browser. */
(function () {
	if (typeof window.wallpaperRegisterMediaPropertiesListener === 'function') return; // inside Wallpaper Engine
	var M = ACV.media, A = ACV.audio;
	if (!M || !A) return;

	// The local helper can't be reached from a hosted page, and online tracklist lookups
	// would search for the demo song, so both stay off here.
	ACV.settings.directAlbums = false;

	// ---- Demo cover, drawn in code (no third-party artwork) ----
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
	function setSong(s) {
		M.we.title = s.title; M.we.artist = s.artist; M.we.album = s.album || '';
		M.we.thumbnail = s.thumbnail || DEMO.thumbnail;
		M.we.colors = s.colors || DEMO.colors;
		M.we.playing = true; M.we.position = 0; M.we.duration = 0; M.we.timelineAt = performance.now();
		emit();
	}

	// ---- Web Audio ----
	var ctx = null, analyser = null, freq = null, srcNode = null, micStream = null, audioEl = null;
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
	function stopSources() {
		if (srcNode) { try { srcNode.disconnect(); } catch (e) { /* ignore */ } srcNode = null; }
		if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
		if (audioEl) { audioEl.pause(); URL.revokeObjectURL(audioEl.src); audioEl = null; }
		A.external = null;
	}

	function playFile(file) {
		if (!file || !ensureCtx()) return;
		stopSources();
		audioEl = new Audio();
		audioEl.src = URL.createObjectURL(file);
		audioEl.loop = true;
		srcNode = ctx.createMediaElementSource(audioEl);
		srcNode.connect(analyser);
		analyser.connect(ctx.destination);
		A.external = feed;
		var name = file.name.replace(/\.[^.]+$/, '');
		var parts = name.split(' - ');
		setSong({ title: parts.length > 1 ? parts.slice(1).join(' - ') : name, artist: parts.length > 1 ? parts[0] : 'Your file', album: '' });
		audioEl.addEventListener('timeupdate', function () {
			M.we.position = audioEl.currentTime; M.we.duration = audioEl.duration || 0; M.we.timelineAt = performance.now();
		});
		audioEl.addEventListener('play', function () { M.we.playing = true; emit(); syncButtons(); });
		audioEl.addEventListener('pause', function () { M.we.playing = false; emit(); syncButtons(); });
		audioEl.play().catch(function () { /* needs a click; the button is one */ });
		mode = 'file'; syncButtons();
	}

	function useMic() {
		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !ensureCtx()) { note('This browser cannot use the microphone.'); return; }
		navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(function (stream) {
			stopSources();
			try { analyser.disconnect(); } catch (e) { /* not connected */ }
			micStream = stream;
			srcNode = ctx.createMediaStreamSource(stream);
			srcNode.connect(analyser); // not to the speakers, to avoid feedback
			A.external = feed;
			setSong({ title: 'Listening', artist: 'Microphone', album: '' });
			mode = 'mic'; syncButtons();
		}).catch(function () { note('Microphone access was blocked. Allow it in the address bar and try again.'); });
	}

	function backToDemo() {
		stopSources();
		setSong(DEMO);
		mode = 'demo'; syncButtons();
	}

	// ---- Small control panel ----
	var css = document.createElement('style');
	css.textContent =
		'#webdemo{position:fixed;left:16px;top:16px;z-index:50;display:flex;flex-direction:column;gap:8px;align-items:flex-start;font:500 13px/1.3 ui-monospace,Consolas,monospace;color:#e8eefc;transition:opacity .4s}' +
		'#webdemo.hide{opacity:0;pointer-events:none}' +
		'#webdemo .row{display:flex;gap:6px;flex-wrap:wrap}' +
		'#webdemo [hidden]{display:none!important}' +
		'#webdemo button,#webdemo a,#webdemo label{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border-radius:8px;border:1px solid rgba(232,238,252,.25);background:rgba(10,15,30,.72);color:inherit;font:inherit;cursor:pointer;text-decoration:none;backdrop-filter:blur(6px)}' +
		'#webdemo button:hover,#webdemo a:hover,#webdemo label:hover{border-color:rgba(232,238,252,.6)}' +
		'#webdemo button[aria-pressed=true]{background:#e8eefc;color:#0a0f1e}' +
		'#webdemo button:focus-visible,#webdemo a:focus-visible,#webdemo label:focus-within{outline:2px solid #fdba74;outline-offset:2px}' +
		'#webdemo .note{max-width:320px;padding:6px 10px;border-radius:8px;background:rgba(10,15,30,.72)}' +
		'#webdemo input{position:absolute;width:1px;height:1px;opacity:0}';
	document.head.appendChild(css);

	var panel = document.createElement('div');
	panel.id = 'webdemo';
	panel.innerHTML =
		'<div class="note" id="wd-note" hidden></div>' +
		'<div class="row">' +
		'<button type="button" id="wd-demo">Demo song</button>' +
		'<label id="wd-file-l">Play your own music<input type="file" id="wd-file" accept="audio/*"></label>' +
		'<button type="button" id="wd-mic">Use microphone</button>' +
		'<button type="button" id="wd-pause" hidden>Pause</button>' +
		'</div>' +
		'<div class="row">' +
		'<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3840312660" target="_blank" rel="noopener">Get it on Steam Workshop</a>' +
		'<a href="https://github.com/slazhz/ascii-music-visualizer" target="_blank" rel="noopener">Source on GitHub</a>' +
		'</div>';
	document.body.appendChild(panel);

	var mode = 'demo', noteTimer = 0;
	function $(id) { return document.getElementById(id); }
	function note(text) {
		var el = $('wd-note'); el.textContent = text; el.hidden = false;
		clearTimeout(noteTimer); noteTimer = setTimeout(function () { el.hidden = true; }, 6000);
	}
	function syncButtons() {
		$('wd-demo').setAttribute('aria-pressed', String(mode === 'demo'));
		$('wd-mic').setAttribute('aria-pressed', String(mode === 'mic'));
		$('wd-pause').hidden = mode !== 'file';
		if (audioEl) $('wd-pause').textContent = audioEl.paused ? 'Play' : 'Pause';
	}
	$('wd-demo').addEventListener('click', backToDemo);
	$('wd-mic').addEventListener('click', useMic);
	$('wd-file').addEventListener('change', function (e) { playFile(e.target.files[0]); e.target.value = ''; });
	$('wd-pause').addEventListener('click', function () { if (!audioEl) return; if (audioEl.paused) audioEl.play(); else audioEl.pause(); });

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
		hideTimer = setTimeout(function () { if (!panel.matches(':hover') && !panel.contains(document.activeElement)) panel.classList.add('hide'); }, 3500);
	}
	if (uiOff) panel.classList.add('hide');
	['mousemove', 'touchstart', 'keydown'].forEach(function (ev) { window.addEventListener(ev, wake, { passive: true }); });
	wake();

	// Start on the demo song once main.js has set everything up.
	setTimeout(backToDemo, 50);
})();

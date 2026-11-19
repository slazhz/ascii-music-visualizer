/* Audio: Wallpaper Engine audio listener, smoothing, band levels and beat detection.
   Outside Wallpaper Engine (plain browser) it generates fake audio so you can test the visuals. */
window.ACV = window.ACV || {};

(function () {
	var N = 64;
	var raw = new Float32Array(N);
	var A = ACV.audio = {
		bins: new Float32Array(N),   // smoothed 0..~1, low frequencies first
		bass: 0, mid: 0, high: 0, level: 0,
		beat: 0,                     // 1 on a beat, decays to 0
		live: false,                 // true once Wallpaper Engine sends audio
		demo: false,
		external: null               // browser demo: fn(raw) fills the 64 bins from Web Audio
	};
	var lastAudioAt = 0;
	var bassAvg = 0.1;
	var lastBeatAt = 0;
	var t = 0;

	var lastSoundAt = 0, idle = 0;
	function onAudio(arr) {
		// 128 values: 0..63 left channel, 64..127 right channel.
		// Switching output (e.g. to Bluetooth) can send broken values (NaN/Infinity) for a moment;
		// one of those used to poison the smoothing so the bars stayed flat for good.
		var sum = 0;
		for (var i = 0; i < N; i++) {
			var v = (arr[i] + arr[i + N]) * 0.5;
			v = isFinite(v) ? Math.max(0, Math.min(2, v)) : 0;
			raw[i] = v; sum += v;
		}
		A.live = true;
		lastAudioAt = performance.now();
		if (sum > 0.002) lastSoundAt = lastAudioAt;
	}
	function mediaPlaying() {
		var M = ACV.media; if (!M) return false;
		if (M.we.title) return M.we.playing;
		var h = M.helper.connected && M.helper.state;
		return !!(h && h.title && h.playing !== false);
	}

	if (typeof window.wallpaperRegisterAudioListener === 'function') {
		window.wallpaperRegisterAudioListener(onAudio);
	} else {
		A.demo = true;
	}

	function fakeAudio(dt) {
		t += dt;
		var bpm = 118, beatPhase = (t * bpm / 60) % 1;
		var kick = Math.pow(1 - beatPhase, 4);
		for (var i = 0; i < N; i++) {
			var f = i / N;
			var v = kick * Math.max(0, 1 - f * 4) * 0.95;
			v += (0.25 + 0.2 * Math.sin(t * 1.3 + i * 0.35)) * (1 - f) * 0.8;
			v += Math.random() * 0.08 * (1 - f * 0.5);
			raw[i] = Math.max(0, v);
		}
	}

	function avg(a, b) {
		var s = 0;
		for (var i = a; i < b; i++) s += A.bins[i];
		return s / (b - a);
	}

	A.update = function (dt) {
		dt = Math.min(dt, 0.1);
		if (A.external) A.external(raw);
		else if (A.demo) fakeAudio(dt);
		else if (performance.now() - lastAudioAt > 1500) { for (var k = 0; k < N; k++) raw[k] *= 0.9; }

		// Music is playing but Wallpaper Engine hears nothing (its capture can get stuck after the
		// output device changes): keep the bars gently moving instead of letting them vanish.
		var now0 = performance.now(), stuck = !A.demo && !A.external && mediaPlaying() && now0 - lastSoundAt > 2500;
		idle += ((stuck ? 1 : 0) - idle) * (1 - Math.exp(-dt * (stuck ? 1.2 : 6)));
		if (idle > 0.01) {
			t += dt;
			for (var j = 0; j < N; j++) {
				var f = j / N, w = (0.16 + 0.1 * Math.sin(t * 1.7 - j * 0.32) + 0.06 * Math.sin(t * 3.1 + j * 0.9)) * (1 - f * 0.6);
				raw[j] = Math.max(raw[j], w * idle);
			}
		}
		A.idle = idle;

		var smooth = ACV.barSettings ? ACV.barSettings().barSmoothing : 0.5;
		var up = 1 - Math.exp(-dt * 30), down = 1 - Math.exp(-dt * (2 + (1 - smooth) * 22));
		for (var i = 0; i < N; i++) {
			// Gentle boost for highs, which are naturally quieter.
			var target = Math.min(1.4, raw[i] * (1 + i / N * 1.2));
			var s = A.bins[i];
			A.bins[i] = s + (target - s) * (target > s ? up : down);
			if (!isFinite(A.bins[i])) A.bins[i] = 0; // never stay stuck on a bad value
		}
		A.bass = avg(0, 6);
		A.mid = avg(6, 24);
		A.high = avg(24, N);
		A.level = A.bass * 0.5 + A.mid * 0.35 + A.high * 0.15;

		// Beat detection on bass energy vs. a slow running average.
		var now = performance.now();
		bassAvg += (A.bass - bassAvg) * (1 - Math.exp(-dt * 1.5));
		if (!isFinite(bassAvg)) bassAvg = 0.1;
		if (A.bass > bassAvg * 1.35 && A.bass > 0.18 && now - lastBeatAt > 200) {
			A.beat = 1;
			lastBeatAt = now;
		}
		A.beat *= Math.exp(-dt * 7);
	};

	// Sample the spectrum at a 0..1 position with a log-ish frequency curve.
	A.sample = function (x) {
		var f = Math.pow(Math.max(0, Math.min(1, x)), 1.6) * (N - 1);
		var i = Math.floor(f), fr = f - i;
		var a = A.bins[i], b = A.bins[Math.min(N - 1, i + 1)];
		return a + (b - a) * fr;
	};
})();

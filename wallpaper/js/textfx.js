/* ASCII-art text, figlet-banner style: the text is drawn in a real font (so Thai works too),
   cut into small cells, and every cell gets the character whose *shape* matches best
   (corners become d b Y P, solid parts 8, edges / \ _ ' . and so on). */
window.ACV = window.ACV || {};

(function () {
	var TW = 10, TH = 20;          // raster pixels per character cell
	var GX = 3, GY = 6;            // shape features per cell (3 x 6 coverage grid)
	var CHARS = " _.,'`\"-/\\|8dbYPo";
	var MONO = 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace';
	var templates = null;

	function features(data, w, x0, y0) {
		var f = new Float32Array(GX * GY), sx = TW / GX, sy = TH / GY;
		for (var gy = 0; gy < GY; gy++) {
			for (var gx = 0; gx < GX; gx++) {
				var sum = 0, n = 0;
				for (var y = Math.floor(gy * sy); y < Math.floor((gy + 1) * sy); y++) {
					for (var x = Math.floor(gx * sx); x < Math.floor((gx + 1) * sx); x++) {
						sum += data[((y0 + y) * w + x0 + x) * 4 + 3] > 110 ? 255 : 0; n++;
					}
				}
				f[gy * GX + gx] = n ? sum / n / 255 : 0;
			}
		}
		return f;
	}

	function buildTemplates() {
		var cv = document.createElement('canvas'); cv.width = TW; cv.height = TH;
		var cx = cv.getContext('2d', { willReadFrequently: true });
		templates = Array.from(CHARS).map(function (ch) {
			cx.clearRect(0, 0, TW, TH);
			cx.fillStyle = '#000';
			cx.font = (TH * 0.9) + 'px ' + MONO;
			cx.textAlign = 'center'; cx.textBaseline = 'middle';
			cx.fillText(ch, TW / 2, TH / 2 + 1);
			var f = features(cx.getImageData(0, 0, TW, TH).data, TW, 0, 0);
			// Stretch each glyph's coverage so thin characters still compete with solid ones.
			var mx = 0; for (var i = 0; i < f.length; i++) mx = Math.max(mx, f[i]);
			if (mx > 0) for (var j = 0; j < f.length; j++) f[j] = Math.min(1, f[j] / Math.max(0.35, mx) * 0.95);
			return { ch: ch, f: f };
		});
	}

	function bestChar(f) {
		var total = 0; for (var i = 0; i < f.length; i++) total += f[i];
		if (total < 1.1) return ' '; // ignore specks: only real strokes become characters
		var best = ' ', bestD = 1e9;
		for (var t = 0; t < templates.length; t++) {
			var tf = templates[t].f, d = 0;
			for (var k = 0; k < tf.length; k++) { var e = tf[k] - f[k]; d += e * e; }
			if (d < bestD) { bestD = d; best = templates[t].ch; }
		}
		return best;
	}

	/**
	 * Turn text into ASCII-art lines.
	 * opts: maxCols (characters per line), rows (character rows per text line, 5..14),
	 *       maxLines (text lines), font (CSS font family for the letters).
	 */
	ACV.asciiArt = function (text, opts) {
		if (!templates) buildTemplates();
		text = String(text || '').trim();
		if (!text) return [];
		var rows = Math.max(4, Math.min(30, opts.rows || 8));
		var fontPx = rows * TH * 0.82;
		var cv = document.createElement('canvas');
		var cx = cv.getContext('2d', { willReadFrequently: true });
		var font = '800 ' + fontPx + 'px ' + (opts.font || '"Segoe UI", sans-serif');
		cx.font = font;
		var maxW = opts.maxCols * TW - TW * 2; // room for the padding around each line
		// Wrap to the width (words when there are spaces, characters otherwise, e.g. Thai).
		var spaced = text.indexOf(' ') >= 0, parts = spaced ? text.split(' ') : Array.from(text), lines = [], cur = '';
		parts.forEach(function (p) {
			var test = cur ? cur + (spaced ? ' ' : '') + p : p;
			if (cx.measureText(test).width <= maxW || !cur) cur = test; else { lines.push(cur); cur = p; }
		});
		if (cur) lines.push(cur);
		var maxLines = opts.maxLines || 2;
		if (lines.length > maxLines) {
			lines = lines.slice(0, maxLines);
			var last = lines[maxLines - 1];
			while (last.length > 1 && cx.measureText(last + '...').width > maxW) last = last.slice(0, -1);
			lines[maxLines - 1] = last.replace(/\s+$/, '') + '...';
		}
		var out = [];
		lines.forEach(function (ln, li) {
			var w = Math.ceil(cx.measureText(ln).width) + TW * 3;
			// Tall line so Thai vowels and tone marks above/below aren't cut off; empty rows are trimmed after.
			var cols = Math.ceil(w / TW), lh = Math.ceil(rows * 2.2);
			cv.width = cols * TW; cv.height = lh * TH;
			cx.font = font;
			cx.textBaseline = 'alphabetic';
			cx.fillStyle = '#000';
			cx.fillText(ln, TW, Math.round(lh * TH * 0.64));
			var data = cx.getImageData(0, 0, cv.width, cv.height).data, block = [];
			for (var r = 0; r < lh; r++) {
				var s = '';
				for (var c = 0; c < cols; c++) s += bestChar(features(data, cv.width, c * TW, r * TH));
				block.push(s.replace(/\s+$/, ''));
			}
			// Trim empty rows above and below the letters.
			while (block.length && !block[0].trim()) block.shift();
			while (block.length && !block[block.length - 1].trim()) block.pop();
			if (li) out.push('');
			out = out.concat(block);
		});
		return out;
	};

	// Width of one monospace character relative to the font size, measured with the real font.
	ACV.MONO_RATIO = 0.6;
	ACV.measureMono = function () {
		var c = document.createElement('canvas').getContext('2d');
		c.font = '700 100px ' + MONO;
		ACV.MONO_RATIO = c.measureText('8888888888').width / 1000 || 0.6;
		return ACV.MONO_RATIO;
	};
})();

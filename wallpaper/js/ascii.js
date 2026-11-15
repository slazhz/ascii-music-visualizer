/* WebGL ASCII renderer.
   Input: a small "composite" canvas where each pixel is one character cell.
   Output: full-screen characters picked from a glyph atlas by brightness. */
window.ACV = window.ACV || {};

(function () {
	var VERT = [
		'attribute vec2 aPos;',
		'void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }'
	].join('\n');

	var FRAG = [
		'precision mediump float;',
		'uniform sampler2D uSrc;',
		'uniform sampler2D uAtlas;',
		'uniform sampler2D uBars;',
		'uniform sampler2D uText;',
		'uniform float uTextOn;',
		'uniform vec3 uTextShade;',
		'uniform float uBarMode;',
		'uniform vec2 uRes;',
		'uniform vec2 uCell;',
		'uniform vec2 uGrid;',
		'uniform float uCount;',
		'uniform float uAscii;',
		'uniform float uContrast;',
		'uniform float uBright;',
		'uniform float uPulse;',
		'uniform float uFlash;',
		'uniform float uMode;',
		'uniform float uScan;',
		'uniform float uTint;',
		'uniform vec3 uMono;',
		'uniform vec3 uBg;',
		'uniform vec3 uPalA;',
		'uniform vec3 uPalB;',
		'uniform vec3 uPalC;',
		'',
		'float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }',
		'',
		'void main(){',
		'  vec2 frag = gl_FragCoord.xy;',
		'  vec3 outc;',
		'  if (uAscii < 0.5) {',
		'    outc = texture2D(uSrc, frag / uRes).rgb;',
		'  } else {',
		'    vec2 cell = floor(frag / uCell);',
		'    vec3 c = texture2D(uSrc, (cell + 0.5) / uGrid).rgb;',
		'    float l = luma(c);',
		'    l = clamp((l - 0.5) * uContrast + 0.5 + uBright + uPulse, 0.0, 1.0);',
		'    float idx = floor(l * (uCount - 1.0) + 0.5);',
		'    vec2 local = fract(frag / uCell);',
		'    float g = texture2D(uAtlas, vec2((idx + local.x) / uCount, local.y)).r;',
		'    vec3 col;',
		'    if (uMode < 0.5) {',
		'      float m = max(c.r, max(c.g, c.b));',
		'      vec3 vivid = c / max(m, 0.04);',
		'      col = mix(c, vivid * (0.35 + 0.65 * l), 0.65);',
		'    } else if (uMode < 1.5) {',
		'      col = l < 0.5 ? mix(uPalC, uPalB, l * 2.0) : mix(uPalB, uPalA, (l - 0.5) * 2.0);',
		'    } else {',
		'      col = uMono * (0.35 + 0.65 * l);',
		'    }',
		'    vec3 back = min(uBg + c * uTint, vec3(1.0));',
		'    outc = mix(back, col, g);',
		'    outc = mix(outc, c, uFlash);',
		'    // Bars live on their own layer so they keep their own colour and stand out.',
		'    vec4 bm = texture2D(uBars, (cell + 0.5) / uGrid);',
		'    if (uBarMode > 0.5 && bm.a > 0.5) {',
		'      float bg2;',
		'      if (uBarMode > 1.5) { vec2 q = abs(local - 0.5); bg2 = step(q.x, 0.42) * step(q.y, 0.45); }',
		'      else bg2 = texture2D(uAtlas, vec2((uCount - 1.0 + local.x) / uCount, local.y)).r;',
		'      outc = mix(uBg * 0.4 + bm.rgb * (uBarMode > 1.5 ? 0.0 : 0.28), bm.rgb, bg2);',
		'    }',
		'    // Text drawn as characters: solid alpha = letter cells, faint alpha = dark outline.',
		'    if (uTextOn > 0.5) {',
		'      vec4 tm = texture2D(uText, (cell + 0.5) / uGrid);',
		'      if (tm.a > 0.55) {',
		'        float gt = texture2D(uAtlas, vec2((uCount - 1.0 + local.x) / uCount, local.y)).r;',
		'        outc = mix(uTextShade + tm.rgb * 0.22, tm.rgb, gt);',
		'      } else if (tm.a > 0.12) {',
		'        outc = mix(outc, uTextShade, 0.75);',
		'      }',
		'    }',
		'  }',
		'  if (uScan > 0.5) outc *= 0.82 + 0.18 * step(0.5, fract(frag.y * 0.5));',
		'  gl_FragColor = vec4(outc, 1.0);',
		'}'
	].join('\n');

	function Ascii(canvas) {
		var gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false })
			|| canvas.getContext('experimental-webgl');
		if (!gl) throw new Error('WebGL not available');
		this.gl = gl;
		this.canvas = canvas;

		var vs = compile(gl, gl.VERTEX_SHADER, VERT);
		var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
		var prog = gl.createProgram();
		gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
		gl.useProgram(prog);
		this.prog = prog;

		var buf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
		var loc = gl.getAttribLocation(prog, 'aPos');
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

		this.u = {};
		var names = ['uSrc', 'uAtlas', 'uRes', 'uCell', 'uGrid', 'uCount', 'uAscii', 'uContrast', 'uBright', 'uPulse',
			'uFlash', 'uMode', 'uScan', 'uTint', 'uBars', 'uBarMode', 'uText', 'uTextOn', 'uTextShade', 'uMono', 'uBg', 'uPalA', 'uPalB', 'uPalC'];
		for (var i = 0; i < names.length; i++) this.u[names[i]] = gl.getUniformLocation(prog, names[i]);

		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		this.srcTex = makeTex(gl);
		this.atlasTex = makeTex(gl);
		this.barsTex = makeTex(gl);
		this.textTex = makeTex(gl);
		gl.uniform1i(this.u.uSrc, 0);
		gl.uniform1i(this.u.uAtlas, 1);
		gl.uniform1i(this.u.uBars, 2);
		gl.uniform1i(this.u.uText, 3);
		this.count = 1;
		this.chars = ' ';
	}

	function compile(gl, type, src) {
		var s = gl.createShader(type);
		gl.shaderSource(s, src); gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
		return s;
	}

	function makeTex(gl) {
		var t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
		return t;
	}

	// Draw every glyph into one row, measure how much "ink" each one has,
	// and sort them from emptiest to fullest so brightness maps cleanly.
	Ascii.prototype.buildAtlas = function (chars, cellW, cellH) {
		var list = Array.from(chars || ' .');
		var seen = {};
		list = list.filter(function (c) { if (seen[c]) return false; seen[c] = 1; return true; });
		if (list.length < 2) list = [' ', '#'];

		var fontSize = Math.max(4, Math.round(cellH * 0.92));
		var font = fontSize + 'px "Cascadia Mono", Consolas, "MS Gothic", "DejaVu Sans Mono", monospace';
		var one = document.createElement('canvas');
		one.width = cellW; one.height = cellH;
		var octx = one.getContext('2d', { willReadFrequently: true });
		var ink = list.map(function (ch) {
			octx.fillStyle = '#000'; octx.fillRect(0, 0, cellW, cellH);
			drawGlyph(octx, ch, cellW, cellH, font);
			var d = octx.getImageData(0, 0, cellW, cellH).data, sum = 0;
			for (var i = 0; i < d.length; i += 4) sum += d[i];
			return { ch: ch, ink: sum };
		});
		ink.sort(function (a, b) { return a.ink - b.ink; });
		list = ink.map(function (o) { return o.ch; });

		var atlas = document.createElement('canvas');
		atlas.width = cellW * list.length; atlas.height = cellH;
		var ctx = atlas.getContext('2d');
		ctx.fillStyle = '#000'; ctx.fillRect(0, 0, atlas.width, atlas.height);
		for (var i = 0; i < list.length; i++) {
			ctx.save(); ctx.translate(i * cellW, 0);
			ctx.beginPath(); ctx.rect(0, 0, cellW, cellH); ctx.clip();
			drawGlyph(ctx, list[i], cellW, cellH, font);
			ctx.restore();
		}
		var gl = this.gl;
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
		this.count = list.length;
		this.chars = list.join('');
	};

	function drawGlyph(ctx, ch, w, h, font) {
		ctx.fillStyle = '#fff';
		ctx.font = font;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		var m = ctx.measureText(ch);
		// Squeeze wide glyphs (e.g. full-width katakana) into the cell.
		var sx = m.width > w ? w / m.width : 1;
		ctx.save();
		ctx.translate(w / 2, h / 2 + h * 0.04);
		ctx.scale(sx, 1);
		ctx.fillText(ch, 0, 0);
		ctx.restore();
	}

	Ascii.prototype.setSource = function (srcCanvas, smooth) {
		var gl = this.gl;
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
		var f = smooth ? gl.LINEAR : gl.NEAREST;
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
	};

	Ascii.prototype.setBars = function (barsCanvas) {
		var gl = this.gl;
		gl.activeTexture(gl.TEXTURE2);
		gl.bindTexture(gl.TEXTURE_2D, this.barsTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, barsCanvas);
	};

	Ascii.prototype.setText = function (textCanvas) {
		var gl = this.gl;
		gl.activeTexture(gl.TEXTURE3);
		gl.bindTexture(gl.TEXTURE_2D, this.textTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
	};

	Ascii.prototype.render = function (p) {
		var gl = this.gl, u = this.u;
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
		gl.uniform2f(u.uCell, p.cellW, p.cellH);
		gl.uniform2f(u.uGrid, p.cols, p.rows);
		gl.uniform1f(u.uCount, this.count);
		gl.uniform1f(u.uAscii, p.ascii ? 1 : 0);
		gl.uniform1f(u.uContrast, p.contrast);
		gl.uniform1f(u.uBright, p.brightness);
		gl.uniform1f(u.uPulse, p.pulse);
		gl.uniform1f(u.uFlash, p.flash);
		gl.uniform1f(u.uMode, p.mode);
		gl.uniform1f(u.uScan, p.scanlines ? 1 : 0);
		gl.uniform1f(u.uTint, p.tint || 0);
		gl.uniform1f(u.uBarMode, p.barMode || 0);
		gl.uniform1f(u.uTextOn, p.textOn ? 1 : 0);
		gl.uniform3fv(u.uTextShade, p.textShade || [0, 0, 0]);
		gl.uniform3fv(u.uMono, p.mono);
		gl.uniform3fv(u.uBg, p.bg);
		gl.uniform3fv(u.uPalA, p.palA);
		gl.uniform3fv(u.uPalB, p.palB);
		gl.uniform3fv(u.uPalC, p.palC);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
	};

	ACV.Ascii = Ascii;
})();

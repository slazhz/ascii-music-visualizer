/* Settings: defaults, Wallpaper Engine property listener, and URL overrides for browser testing. */
window.ACV = window.ACV || {};
ACV.VERSION = 15;

ACV.CHARSETS = {
	standard: ' .:-=+*#%@',
	detailed: ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
	blocks: ' ░▒▓█',
	binary: ' .01',
	katakana: ' .ｰｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ'
};

ACV.settings = {
	ascii: true,
	cellSize: 12,
	charset: 'standard',
	customChars: ' .oO0@',
	directAlbums: true,
	showLyrics: false,
	lyricsOffset: 0,
	lyricsPosition: 'bottom',
	lyricsStyle: 'art',
	lyricsSize: 1,
	showClock: true,
	clockPosition: 'top-right',
	clockStyle: 'art',
	clock24: true,
	clockSeconds: false,
	clockDate: true,
	clockSize: 1,
	textHeader: false,
	textTitle: '{title}',
	textArtist: '{artist}',
	textCardTitle: '{title}',
	textCardArtist: '{artist}',
	textBackName: '{album}',
	textBackMeta: '{albumartist} · {kind} {year}',
	textBackLeft: 'TRACK {track} / {tracks}',
	textBackRight: '{albummin} MIN · {tracks} SONGS',
	colorMode: 'source',
	monoColor: [0.55, 1, 0.7],
	bgColor: [0, 0, 0],
	contrast: 1.25,
	brightness: 0.05,
	scanlines: false,
	bgTint: 0.18,
	reactivity: 1,
	beatFlash: true,
	showBars: true,
	barStyle: 'bottom',
	barCount: 64,
	barHeight: 0.4,
	barWidth: 0.7,
	barOffset: 0.06,
	barSensitivity: 1,
	barSmoothing: 0.5,
	barRange: 0.85,
	barPreset: 'classic',
	barColorMode: 'auto',
	barColor: [1, 1, 1],
	barAscii: true,
	barBackdrop: false,
	barBackdropStrength: 0.6,
	barGlyph: 'chars',
	imageDim: 0.1,
	barRingRadius: 0.32,
	canvasLayout: 'side',
	helperPort: 7777,
	kenBurns: true,
	coverLayout: 'fit',
	imageZoom: 0.9,
	coverFlip: 'auto',
	flipEvery: 45,
	flipShow: 10,
	idleMinutes: 2,
	coverTransition: 'slide',
	idleSeconds: 60,
	showTitle: true,
	titleSeconds: 6,
	showCard: true,
	cardPosition: 'bottom-left',
	cardScale: 1,
	cardAscii: true,
	thaiFont: 'anuphan',
	titleStyle: 'art',
	headingStyle: 'art',
	artSize: 8,
	artColor: 'album',
	artCustom: [1, 0.55, 0.8],
	clockColor: 'title',
	clockCustom: [0.55, 0.85, 1],
	fpsLimit: 0
};

ACV.paused = false;
ACV._settingsHandlers = [];
ACV._pauseHandlers = [];
ACV.onSettings = function (fn) { ACV._settingsHandlers.push(fn); };
ACV.onPause = function (fn) { ACV._pauseHandlers.push(fn); };

ACV.parseColor = function (v) {
	// Accepts "r g b" (0..1 or 0..255), "#rrggbb", "rgb(r, g, b)" or an array.
	if (Array.isArray(v)) return v.slice(0, 3);
	if (typeof v !== 'string') return null;
	var s = v.trim();
	if (s[0] === '#') {
		var hex = s.slice(1);
		if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
		var n = parseInt(hex.slice(0, 6), 16);
		if (isNaN(n)) return null;
		return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
	}
	var nums = s.replace(/rgba?\(|\)/g, '').split(/[\s,]+/).filter(Boolean).map(Number);
	if (nums.length < 3 || nums.some(isNaN)) return null;
	nums = nums.slice(0, 3);
	if (nums.some(function (x) { return x > 1; })) nums = nums.map(function (x) { return x / 255; });
	return nums;
};

(function () {
	var S = ACV.settings;
	var map = {
		ascii: ['ascii', 'bool'],
		cellsize: ['cellSize', 'num'],
		charset: ['charset', 'str'],
		customchars: ['customChars', 'str'],
		onlinealbums: ['directAlbums', 'bool'],
		showlyrics: ['showLyrics', 'bool'],
		lyricsposition: ['lyricsPosition', 'str'],
		lyricsstyle: ['lyricsStyle', 'str'],
		lyricssizepct: ['lyricsSize', 'pct'],
		lyricsoffset: ['lyricsOffset', 'num'],
		showclock: ['showClock', 'bool'],
		clockposition: ['clockPosition', 'str'],
		clockstyle: ['clockStyle', 'str'],
		clock24: ['clock24', 'bool'],
		clockseconds: ['clockSeconds', 'bool'],
		clockdate: ['clockDate', 'bool'],
		clocksizepct: ['clockSize', 'pct'],
		textheader: ['textHeader', 'bool'],
		texttitle: ['textTitle', 'str'],
		textartist: ['textArtist', 'str'],
		textcardtitle: ['textCardTitle', 'str'],
		textcardartist: ['textCardArtist', 'str'],
		textbackname: ['textBackName', 'str'],
		textbackmeta: ['textBackMeta', 'str'],
		textbackleft: ['textBackLeft', 'str'],
		textbackright: ['textBackRight', 'str'],
		colormode: ['colorMode', 'str'],
		monocolor: ['monoColor', 'color'],
		bgcolor: ['bgColor', 'color'],
		contrastpct: ['contrast', 'pct'],
		brightnesspct: ['brightness', 'pct'],
		scanlines: ['scanlines', 'bool'],
		bgtintpct: ['bgTint', 'pct'],
		reactivitypct: ['reactivity', 'pct'],
		beatflash: ['beatFlash', 'bool'],
		showbars: ['showBars', 'bool'],
		barstyle: ['barStyle', 'str'],
		barcount: ['barCount', 'num'],
		barheightpct: ['barHeight', 'pct'],
		barwidthpct: ['barWidth', 'pct'],
		baroffsetpct: ['barOffset', 'pct'],
		barsensitivitypct: ['barSensitivity', 'pct'],
		barsmoothingpct: ['barSmoothing', 'pct'],
		barrangepct: ['barRange', 'pct'],
		barpreset: ['barPreset', 'str'],
		barcolormode: ['barColorMode', 'str'],
		barcolor: ['barColor', 'color'],
		barascii: ['barAscii', 'bool'],
		barbackdrop: ['barBackdrop', 'bool'],
		barbackdropstrengthpct: ['barBackdropStrength', 'pct'],
		barglyph: ['barGlyph', 'str'],
		imagedimpct: ['imageDim', 'pct'],
		barringradiuspct: ['barRingRadius', 'pct'],
		canvaslayout: ['canvasLayout', 'str'],
		helperport: ['helperPort', 'num'],
		kenburns: ['kenBurns', 'bool'],
		coverlayout: ['coverLayout', 'str'],
		imagezoompct: ['imageZoom', 'pct'],
		coverflip: ['coverFlip', 'str'],
		flipevery: ['flipEvery', 'num'],
		flipshow: ['flipShow', 'num'],
		idleminutes: ['idleMinutes', 'num'],
		covertransition: ['coverTransition', 'str'],
		idleseconds: ['idleSeconds', 'num'],
		showtitle: ['showTitle', 'bool'],
		titleseconds: ['titleSeconds', 'num'],
		showcard: ['showCard', 'bool'],
		cardposition: ['cardPosition', 'str'],
		cardscalepct: ['cardScale', 'pct'],
		cardascii: ['cardAscii', 'bool'],
		thaifont: ['thaiFont', 'str'],
		titlestyle: ['titleStyle', 'str'],
		headingstyle: ['headingStyle', 'str'],
		artsizepct: ['artSize', 'pct', 8],
		artcolor: ['artColor', 'str'],
		artcustom: ['artCustom', 'color'],
		clockcolor: ['clockColor', 'str'],
		clockcustom: ['clockCustom', 'color']
	};

	function convert(type, raw, mult) {
		if (type === 'bool') return raw === true || raw === 'true' || raw === '1' || raw === 1;
		if (type === 'pct') { var pn = Number(raw); return isNaN(pn) ? undefined : pn / 100 * (mult || 1); } // percent sliders
		if (type === 'num') { var n = Number(raw); return isNaN(n) ? undefined : n; }
		if (type === 'color') return ACV.parseColor(raw) || undefined;
		return raw == null ? undefined : String(raw);
	}

	function apply(values) {
		var changed = [];
		Object.keys(values).forEach(function (key) {
			var m = map[key.toLowerCase()];
			if (!m) return;
			var v = convert(m[1], values[key], m[2]);
			if (v === undefined) return;
			S[m[0]] = v;
			changed.push(m[0]);
		});
		if (changed.length) ACV._settingsHandlers.forEach(function (fn) { fn(changed); });
	}
	ACV.applySettings = apply;

	window.wallpaperPropertyListener = {
		applyUserProperties: function (props) {
			var flat = {};
			Object.keys(props).forEach(function (k) { flat[k] = props[k].value; });
			apply(flat);
		},
		applyGeneralProperties: function (props) {
			if (props.fps) { S.fpsLimit = Number(props.fps) || 0; }
		},
		setPaused: function (isPaused) {
			ACV.paused = !!isPaused;
			ACV._pauseHandlers.forEach(function (fn) { fn(ACV.paused); });
		}
	};

	// Browser testing: index.html?cellsize=8&colormode=palette ...
	try {
		var q = new URLSearchParams(location.search);
		var flat = {};
		q.forEach(function (v, k) { flat[k] = v; });
		if (Object.keys(flat).length) apply(flat);
	} catch (e) { /* ignore */ }
})();

// Bar modes: ready-made shapes/motion. "custom" uses the individual sliders.
// Colour is not part of a mode; it always follows the "Bar color" setting.
ACV.BAR_PRESETS = {
	classic:  { barStyle: 'bottom', barCount: 64,  barHeight: 0.35, barWidth: 0.7,  barOffset: 0.06, barSensitivity: 1,   barSmoothing: 0.5,  barRange: 0.85, barGlyph: 'chars',  barBackdropStrength: 0.6 },
	minimal:  { barStyle: 'bottom', barCount: 110, barHeight: 0.16, barWidth: 0.45, barOffset: 0.06, barSensitivity: 0.9, barSmoothing: 0.7,  barRange: 0.8,  barGlyph: 'chars',  barBackdropStrength: 0.35 },
	chunky:   { barStyle: 'bottom', barCount: 24,  barHeight: 0.45, barWidth: 0.82, barOffset: 0.06, barSensitivity: 1.1, barSmoothing: 0.45, barRange: 0.7,  barGlyph: 'blocks', barBackdropStrength: 0.7 },
	wave:     { barStyle: 'mirror', barCount: 90,  barHeight: 0.34, barWidth: 0.55, barOffset: 0.06, barSensitivity: 1,   barSmoothing: 0.62, barRange: 0.85, barGlyph: 'chars',  barBackdropStrength: 0.5 },
	bass:     { barStyle: 'split',  barCount: 32,  barHeight: 0.5,  barWidth: 0.8,  barOffset: 0.06, barSensitivity: 1.3, barSmoothing: 0.3,  barRange: 0.45, barGlyph: 'blocks', barBackdropStrength: 0.65 },
	halo:     { barStyle: 'ring',   barCount: 96,  barHeight: 0.3,  barWidth: 0.6,  barOffset: 0.06, barSensitivity: 1,   barSmoothing: 0.55, barRange: 0.8,  barGlyph: 'chars',  barBackdropStrength: 0.5, barRingRadius: 0.3 },
	topline:  { barStyle: 'top',    barCount: 128, barHeight: 0.12, barWidth: 0.6,  barOffset: 0.02, barSensitivity: 1,   barSmoothing: 0.6,  barRange: 0.85, barGlyph: 'chars',  barBackdropStrength: 0.45 }
};
ACV.barSettings = function () {
	var S = ACV.settings, preset = ACV.BAR_PRESETS[S.barPreset];
	if (!preset) return S;
	var out = Object.create(S);
	for (var k in preset) out[k] = preset[k];
	return out;
};


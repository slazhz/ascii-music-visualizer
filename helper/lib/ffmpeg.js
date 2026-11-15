'use strict';
/*
 * Wallpaper Engine's browser (CEF) can't decode H.264, and Spotify canvases are
 * H.264 MP4s, so the helper re-encodes them to WebM (VP9) with ffmpeg.
 *
 * ffmpeg is looked up in: config "ffmpegPath", helper/tools/ffmpeg.exe, the
 * winget links folder, then PATH. If none is found on Windows, a build is
 * downloaded once into helper/tools (set "autoDownloadFfmpeg": false to stop that).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const crypto = require('crypto');
// Official LGPL build from BtbN/FFmpeg-Builds (GitHub). Verified against the release's published SHA-256 list.
const RELEASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';
const ZIP_NAME = 'ffmpeg-master-latest-win64-lgpl.zip';
const FFMPEG_ZIP = RELEASE + ZIP_NAME;
const CHECKSUMS = RELEASE + 'checksums.sha256';

function run(cmd, args, opts) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, Object.assign({ windowsHide: true, maxBuffer: 1 << 24 }, opts), (err, stdout, stderr) => {
			if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve(String(stdout || ''));
		});
	});
}

async function works(bin) {
	try { await run(bin, ['-hide_banner', '-version']); return true; } catch (e) { return false; }
}

class Ffmpeg {
	constructor({ root, configPath, autoDownload, log }) {
		this.toolsDir = path.join(root, 'tools');
		this.configPath = configPath;
		this.autoDownload = autoDownload !== false;
		this.log = log || console.log;
		this.bin = null;
		this.status = 'unknown'; // unknown | ready | downloading | missing | error
		this.finding = null;
	}

	async find() {
		if (this.bin) return this.bin;
		if (this.finding) return this.finding;
		this.finding = (async () => {
			const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
			const candidates = [];
			if (this.configPath) candidates.push(this.configPath);
			candidates.push(path.join(this.toolsDir, exe));
			if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
			candidates.push('ffmpeg');
			for (const c of candidates) {
				if (await works(c)) { this.bin = c; this.status = 'ready'; return c; }
			}
			if (process.platform === 'win32' && this.autoDownload) {
				try { return await this.download(); } catch (e) {
					this.status = 'error';
					this.log('ffmpeg download failed: ' + e.message + ' — install it yourself (e.g. "winget install Gyan.FFmpeg") and restart the helper.');
					return null;
				}
			}
			this.status = 'missing';
			this.log('ffmpeg not found — canvases can\'t play in Wallpaper Engine without it. Install it (e.g. "winget install Gyan.FFmpeg") and restart the helper.');
			return null;
		})();
		try { return await this.finding; } finally { this.finding = null; }
	}

	async download() {
		this.status = 'downloading';
		await fsp.mkdir(this.toolsDir, { recursive: true });
		const zip = path.join(this.toolsDir, 'ffmpeg.zip');
		this.log('Downloading ffmpeg (one time, ~100 MB) so canvases can play in Wallpaper Engine…');
		const res = await fetch(FFMPEG_ZIP);
		if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
		await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zip));
		// Integrity check: the zip must match the SHA-256 published with the same release.
		const sums = await fetch(CHECKSUMS).then(r => { if (!r.ok) throw new Error('checksum list HTTP ' + r.status); return r.text(); });
		const line = sums.split(/\r?\n/).find(l => l.trim().endsWith(ZIP_NAME));
		const expected = line && line.trim().split(/\s+/)[0].toLowerCase();
		const actual = await new Promise((resolve, reject) => {
			const h = crypto.createHash('sha256');
			fs.createReadStream(zip).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
		});
		if (!expected || expected !== actual) {
			await fsp.rm(zip, { force: true });
			throw new Error('ffmpeg download failed its checksum check, so it was deleted');
		}
		this.log('Checksum OK. Extracting ffmpeg…');
		const out = path.join(this.toolsDir, 'extract');
		await fsp.mkdir(out, { recursive: true });
		await run('tar', ['-xf', zip, '-C', out]); // Windows 10+ ships bsdtar, which reads .zip
		const found = await findFile(out, 'ffmpeg.exe');
		if (!found) throw new Error('ffmpeg.exe not found in the download');
		const dest = path.join(this.toolsDir, 'ffmpeg.exe');
		await fsp.copyFile(found, dest);
		await fsp.rm(zip, { force: true });
		await fsp.rm(out, { recursive: true, force: true }).catch(() => {});
		if (!(await works(dest))) throw new Error('downloaded ffmpeg does not run');
		this.bin = dest;
		this.status = 'ready';
		this.log('ffmpeg ready.');
		return dest;
	}

	/** Re-encode an MP4 to a small, quick-to-make VP9 WebM (no audio; canvases are silent). */
	async toWebm(input, output) {
		const bin = await this.find();
		if (!bin) throw new Error('ffmpeg not available');
		const tmp = output + '.part.webm';
		await new Promise((resolve, reject) => {
			const p = spawn(bin, [
				'-hide_banner', '-loglevel', 'error', '-y',
				'-i', input,
				'-an',
				'-vf', "scale='min(720,iw)':-2",
				'-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34',
				'-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1',
				tmp
			], { windowsHide: true });
			let err = '';
			p.stderr.on('data', d => { err += d; });
			p.on('error', reject);
			p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exited ' + code + ': ' + err.trim().slice(-300))));
		});
		await fsp.rename(tmp, output);
		return output;
	}
}

async function findFile(dir, name) {
	for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) { const r = await findFile(p, name); if (r) return r; }
		else if (ent.name.toLowerCase() === name) return p;
	}
	return null;
}

module.exports = { Ffmpeg };

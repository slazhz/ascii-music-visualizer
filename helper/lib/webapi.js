'use strict';
/*
 * Optional: official Spotify Web API login (PKCE, no client secret needed),
 * used to find the current track when the Spicetify bridge isn't installed.
 */
const crypto = require('crypto');
const fs = require('fs');

const SCOPES = 'user-read-currently-playing user-read-playback-state';

function b64url(buf) {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class WebApi {
	constructor({ clientId, redirectUri, tokenFile, log }) {
		this.clientId = clientId;
		this.redirectUri = redirectUri;
		this.tokenFile = tokenFile;
		this.log = log || console.log;
		this.pending = new Map(); // state -> verifier
		this.tokens = null;       // { access_token, refresh_token, expiresAt }
		this.backoffUntil = 0;
		try { this.tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch (e) { /* not logged in yet */ }
	}

	get enabled() { return !!this.clientId; }
	get loggedIn() { return !!(this.tokens && this.tokens.refresh_token); }

	loginUrl() {
		const verifier = b64url(crypto.randomBytes(48));
		const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
		const state = b64url(crypto.randomBytes(12));
		this.pending.set(state, verifier);
		const q = new URLSearchParams({
			client_id: this.clientId,
			response_type: 'code',
			redirect_uri: this.redirectUri,
			code_challenge_method: 'S256',
			code_challenge: challenge,
			scope: SCOPES,
			state
		});
		return 'https://accounts.spotify.com/authorize?' + q.toString();
	}

	async handleCallback(code, state) {
		const verifier = this.pending.get(state);
		if (!verifier) throw new Error('Login expired or invalid state. Open /login again.');
		this.pending.delete(state);
		await this._token({
			grant_type: 'authorization_code',
			code,
			redirect_uri: this.redirectUri,
			client_id: this.clientId,
			code_verifier: verifier
		});
	}

	async _token(params) {
		const res = await fetch('https://accounts.spotify.com/api/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(params).toString()
		});
		const j = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error('token request failed: ' + (j.error_description || j.error || res.status));
		this.tokens = {
			access_token: j.access_token,
			refresh_token: j.refresh_token || (this.tokens && this.tokens.refresh_token),
			expiresAt: Date.now() + (j.expires_in - 60) * 1000
		};
		fs.writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 2));
	}

	async accessToken() {
		if (!this.loggedIn) return null;
		if (this.tokens.expiresAt > Date.now()) return this.tokens.access_token;
		await this._token({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token, client_id: this.clientId });
		return this.tokens.access_token;
	}

	/** Returns null when nothing is playing, else { trackId, title, artist, album, coverUrl, playing }. */
	async currentlyPlaying() {
		if (Date.now() < this.backoffUntil) return undefined;
		const token = await this.accessToken();
		if (!token) return undefined;
		const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
			headers: { Authorization: 'Bearer ' + token }
		});
		if (res.status === 204) return null;
		if (res.status === 429) {
			const wait = Number(res.headers.get('retry-after')) || 30;
			this.backoffUntil = Date.now() + wait * 1000;
			this.log('Web API rate limited, waiting ' + wait + 's');
			return undefined;
		}
		if (res.status === 401) { this.tokens.expiresAt = 0; return undefined; }
		if (!res.ok) return undefined;
		const j = await res.json();
		const it = j.item;
		if (!it || j.currently_playing_type !== 'track' || !it.id) return null;
		const imgs = (it.album && it.album.images) || [];
		return {
			trackId: it.id,
			title: it.name,
			artist: (it.artists || []).map(a => a.name).join(', '),
			album: it.album ? it.album.name : '',
			coverUrl: imgs.length ? imgs[0].url : null,
			albumUri: it.album && it.album.uri ? it.album.uri : null,
			playing: !!j.is_playing
		};
	}
}

WebApi.prototype.album = async function (albumUri) {
	if (!albumUri || !/^spotify:album:[A-Za-z0-9]{22}$/.test(albumUri)) return null;
	this.albumCache = this.albumCache || {};
	if (this.albumCache[albumUri]) return this.albumCache[albumUri];
	const token = await this.accessToken();
	if (!token) return null;
	const get = async url => {
		const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
		return r.ok ? r.json() : null;
	};
	const j = await get('https://api.spotify.com/v1/albums/' + albumUri.split(':')[2]);
	if (!j || !j.tracks) return null;
	let items = j.tracks.items || [], next = j.tracks.next, pages = 0;
	while (next && pages < 4) {
		pages++;
		const k = await get(next);
		if (!k || !k.items) break;
		items = items.concat(k.items); next = k.next;
	}
	const info = {
		uri: albumUri, name: j.name || '', year: (j.release_date || '').slice(0, 4),
		tracks: items.map(t => ({ n: t.track_number, d: t.disc_number, title: t.name, ms: t.duration_ms, uri: t.uri }))
	};
	this.albumCache[albumUri] = info;
	return info;
};

module.exports = { WebApi };

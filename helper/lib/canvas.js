'use strict';
/*
 * Spotify Canvas lookup through Spotify's internal "pathfinder" GraphQL API
 * (the same call the web player makes). This is NOT an official API: it can
 * break when Spotify changes things, and using it is probably against
 * Spotify's terms. Everything Spotify-internal lives in this one file so a
 * fix only ever touches here.
 *
 * If it breaks, the usual fix is a new persisted-query hash: put it in
 * config.json as "canvasHash".
 */
const crypto = require('crypto');

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
const CLIENT_TOKEN_URL = 'https://clienttoken.spotify.com/v1/clienttoken';
const DEFAULT_HASH = '575138ab27cd5c1b3e54da54d0a7cc8d85485402de26340c2145f0f6bb5e7a9f';
const WEB_PLAYER_CLIENT_ID = 'd8a5ed958d274c2e8ee717e6a4b0971d';

let clientToken = null; // { token, expiresAt }

class CanvasAuthError extends Error {}

async function getClientToken() {
	if (clientToken && clientToken.expiresAt > Date.now()) return clientToken.token;
	const res = await fetch(CLIENT_TOKEN_URL, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_data: {
				client_version: '1.2.42.432.g3121',
				client_id: WEB_PLAYER_CLIENT_ID,
				js_sdk_data: {
					device_brand: 'unknown',
					device_model: 'unknown',
					os: 'windows',
					os_version: 'NT 10.0',
					device_id: crypto.randomBytes(16).toString('hex'),
					device_type: 'computer'
				}
			}
		})
	});
	if (!res.ok) throw new Error('client-token request failed: HTTP ' + res.status);
	const j = await res.json();
	const tok = j && j.granted_token && j.granted_token.token;
	if (!tok) throw new Error('client-token response had no token');
	const ttl = (j.granted_token.expires_after_seconds || 1200) - 60;
	clientToken = { token: tok, expiresAt: Date.now() + ttl * 1000 };
	return tok;
}

/**
 * Returns the canvas MP4 URL, or null when the track has no canvas.
 * Throws CanvasAuthError when Spotify rejects the access token.
 */
async function lookupCanvas(trackId, accessToken, hash) {
	if (!accessToken) throw new CanvasAuthError('no access token');
	const ct = await getClientToken();
	const res = await fetch(PATHFINDER_URL, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer ' + accessToken,
			'client-token': ct,
			'Content-Type': 'application/json;charset=UTF-8',
			Accept: 'application/json',
			'app-platform': 'WebPlayer'
		},
		body: JSON.stringify({
			variables: { trackUri: 'spotify:track:' + trackId },
			operationName: 'canvas',
			extensions: { persistedQuery: { version: 1, sha256Hash: hash || DEFAULT_HASH } }
		})
	});
	if (res.status === 401 || res.status === 403) {
		if (res.status === 401) clientToken = null;
		throw new CanvasAuthError('pathfinder rejected the token: HTTP ' + res.status);
	}
	if (!res.ok) throw new Error('pathfinder HTTP ' + res.status);
	const j = await res.json();
	if (j.errors && j.errors.length) throw new Error('pathfinder error: ' + (j.errors[0].message || JSON.stringify(j.errors[0])));
	const c = j.data && j.data.trackUnion && j.data.trackUnion.canvas;
	return (c && c.url) || null;
}

module.exports = { lookupCanvas, CanvasAuthError, DEFAULT_HASH };

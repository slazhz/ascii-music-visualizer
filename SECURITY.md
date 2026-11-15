# Security

## Design

- **Localhost only:** the helper binds to `127.0.0.1` and is never reachable from other computers.
- **Host and Origin checks:** requests must use the `Host` `127.0.0.1`, `localhost` or `[::1]`, and come either with no `Origin` or from an allowed one. The allowed origins are the wallpaper (`file://` or `null`), the Spotify app (`https://xpui.app.spotify.com`) and the helper itself. This blocks other websites and DNS-rebinding attacks. You can add more origins in `extraOrigins` in `config.json`.
- **Validated input:** request bodies are size-limited, track IDs are validated, and only known image and video hosts are ever downloaded.
- **Canvases off by default:** Spotify tokens sent by the bridge are ignored unless you turn canvases on.
- **No secrets in the repo:** `config.json`, tokens, caches and logs live in `helper/` and `helper/data/` on your computer and are git-ignored.
- **Verified ffmpeg:** if ffmpeg is downloaded, its SHA-256 is checked against the release's published checksums.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) instead of a public issue. Include steps to reproduce if you can.

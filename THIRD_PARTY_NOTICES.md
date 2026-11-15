# Third-party software and services

This repository contains only original code. Nothing below is bundled. Each item is downloaded or used at run time, only when the feature that needs it is in use.

| What | Used for | License / terms |
|---|---|---|
| [Deezer API](https://developers.deezer.com/api) | Album tracklists (song title, artist and album are sent) | [Deezer for Developers terms](https://developers.deezer.com/termsofuse): **non-commercial use only**. If you fork this project for anything commercial, remove or replace the Deezer lookup |
| [iTunes Search API](https://performance-partners.apple.com/resources/documentation/itunes-store-web-service-search-api/) | Tracklists when Deezer has no match | Apple's terms for the iTunes Search API |
| [Google Fonts](https://github.com/google/fonts): Anuphan, Noto Sans Thai, IBM Plex Sans Thai, Kanit, Prompt | Thai fonts, downloaded once by the helper | [SIL Open Font License 1.1](https://openfontlicense.org) |
| [FFmpeg](https://ffmpeg.org), LGPL build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | Converting Spotify Canvas videos to WebM (only when canvases are on and ffmpeg isn't installed) | [LGPL 2.1+](https://ffmpeg.org/legal.html). Downloaded from its official source and SHA-256 verified; not redistributed here |
| [Spicetify](https://spicetify.app) | Optional: the Spotify bridge | Its own license. Installed by you, from its official installer |
| Spotify Web API | Optional: now playing via your own Spotify developer app (OAuth PKCE) | [Spotify Developer Terms](https://developer.spotify.com/terms) |
| Spotify's private Canvas API | Unofficial: Canvas videos (on by default when the helper and Spicetify bridge are installed; can be turned off) | Not a public API and not endorsed by Spotify; may go against Spotify's terms. Use at your own risk |

Album artwork, song titles and other metadata shown by the wallpaper belong to their respective owners. They are displayed live from your own player or the services above and are never stored in or distributed with this project.

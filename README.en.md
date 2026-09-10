<p align="center"><img src="app/web/static/logo.png" width="100" alt="BiliMusic logo"></p>
<h1 align="center">BiliMusic</h1>
<p align="center">Your personal player for music on Bilibili.</p>
<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>

BiliMusic is a personal web music player powered by Bilibili. Search, discovery, favorites, and playlists all live in a lightweight, server-rendered interface built on FastAPI — no frontend build step. The interface itself is in Chinese.

**v2.0.0 is about cross-device streaming.** Your phone and computer on the same LAN share one playback session: when the phone is playing, the computer's player bar shows that track, and one tap on the middle button brings the sound over; drag the phone's bar upward and it goes back to the computer. The player bar always tells you who is playing and who is in control.

![Desktop mirroring playback from the phone](docs/shots/27-desktop-mirror.png)

## Cross-device streaming

| Capability | Description |
| --- | --- |
| Zero-tap auto-connect | On launch the phone scans the LAN (agreed port 8000), recognizes a computer signed in to the same account via an account fingerprint, and joins it; the device that is currently playing wins. If it finds nothing it quietly stays local — no errors, no interruptions. |
| The player bar is the remote | Every device mirrors the track and progress of the one that is playing. Previous, next, pause, scrubbing, and volume all apply to the active device. |
| Gesture streaming (phone) | Drag the bar up and it shrinks into a puck that follows your finger, the page blurs, and devices become an orb field in the middle of the screen; release on an orb to stream there. Drag down to bring playback home. A long-press on the middle button opens the same picker. |
| Desktop device list | Desktops keep an explicit list: tap the device icon on the player bar and pick a row. |
| Tapping a song hands it over | While mirroring, tapping a song — including un-favorited previews, home recommendations, and recently played — sends the queue to the active device. The phone stays silent, and two devices never play at once. |
| Detail and lyrics follow the remote | In mirror mode, the song detail and lyrics pages show the remote track: lyrics, progress, play/pause, and previous/next all control the other device. |
| Pink rim light | A pink light travels around the edge of the mirrored bar; the artist slot still shows the artist (the device name lives in the tooltip), and tapping it opens the remote track's creator page. |
| Silent by design | Successful transfers and progress never show a toast — the mirrored bar and its pink rim say it all. Only failures speak up. |

### How to use

| Goal | Action |
| --- | --- |
| Phone → computer | With the computer's page open, tap the middle button "⇢ Stream to this device"; or on desktop, open the device list and choose "play on this device". |
| Computer → phone | On the phone, long-press the middle button, or drag the bar up and release on the computer's orb. |
| Bring it back | Drag the phone's bar down. |
| Control the other device | Use the bar's middle button, previous/next, scrubber, or volume on any device — they act on whichever device is sounding. |

### Requirements and limits

- Both devices must be on the **same LAN** (/24, no AP isolation) and signed in to the **same Bilibili account**; the computer's backend must be running.
- The desktop app listens on port 8000 in LAN mode by default; when running from source, start with `--host 0.0.0.0 --port 8000`.
- A backend with `BM_API_TOKEN` set is invisible to unknown devices, so auto-connect needs matching token settings on both sides.
- Streaming across networks (phone on 4G, computer at home) is out of scope; a mesh VPN such as Tailscale makes both devices look local.
- Sessions live in memory and rebuild themselves after a backend restart.
- Closing a browser tab stops playback (a web platform limit); background playback is a future Android item.
- Known issue: the frosted masks on the PC player bar still clip titles of 15 characters or fewer (ledger #28).

## Features

| Feature | Description |
| --- | --- |
| Online playback | Proxies Bilibili audio with seek support; normal playback does not store full audio files |
| Discovery | Search videos and creators, daily picks, genres, and creator uploads |
| Continuous listening | Search and recommendation queues support previous, next, and automatic advancement |
| Favorites and playlists | Import video or favorites-folder links and sync with Bilibili's `bilimusic` folders |
| Lyrics | Synchronized scrolling lyrics that follow the remote track in mirror mode |
| Cross-device streaming | One shared session per account: auto-connect, mirrored bar, gesture switching, full remote control |
| Responsive interface | Desktop sidebar, mobile navigation (3 tabs + search button), light and dark themes, pink glass selection animation |
| Account isolation | QR-code sign-in, separate account libraries, locally stored credentials |

## Mobile experience

<p align="center">
<img src="docs/shots/29-phone-balls.png" width="270" alt="Drag-up streaming: the orb field and the active device's volume">
<img src="docs/shots/29-phone-longpress.png" width="270" alt="Long-press picker on the player bar">
</p>

The mobile navigation keeps three tabs plus a search button: every cross-device entry point now lives on the player bar — drag up (or long-press the middle button) to pick a device, drag down to come home. The bar matches the floating dock exactly (measured at 360/390/412), and the artist link only responds on the text itself.

<p align="center"><img src="docs/shots/29-desktop-devlist.png" width="720" alt="Desktop device list with the active device's volume"></p>

On desktop, the device icon on the bar opens the list: the playing device comes first, its volume slider sits right under its name, and one tap switches to it.

![Pink rim light on the mirrored bar](docs/shots/29-mirror-bar.png)

In mirror mode a pink light runs around the edge of the bar — the only marker that you are remote-controlling another device. No toasts, no interruptions.

## Quick start

### Install a standalone app

Download DMG, EXE, or APK installers from [GitHub Releases](https://github.com/LQ-1123/bilibilimusic/releases). Each installer embeds Python and the backend, so no separate server is needed.

Desktop uses **Tauri 2 and the system WebView**, retaining the existing frontend and Python backend. Android keeps its native WebView and Chaquopy integration. Windows installers include offline WebView2 installation support.

| System | Installer |
| --- | --- |
| macOS 14+ Apple Silicon | `*-mac-arm64.dmg` |
| macOS 14+ Intel | `*-mac-x64.dmg` |
| Windows 64-bit | `*-win-x64.exe` |
| Android 8+, ARM64 / x86_64 | `*-android.apk` |

Desktop installers are not developer-signed or notarized and may trigger OS security prompts. Android uses a persistent project signing key; background playback and lock-screen controls are not guaranteed in this initial version. All platforms require internet access to Bilibili. See [packaging instructions](docs/packaging.md).

### Run from source

Python 3.13 is recommended. The server needs access to Bilibili APIs and audio CDNs.

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open **http://127.0.0.1:8000**. On Windows, activate with `.venv\Scripts\activate`.

1. Sign in to Bilibili using the QR-code account flow.
2. Search for music or paste a video or favorites-folder link.
3. Click a track to stream it and use Next within recommendation or search lists.
4. Organize tracks into playlists or export a Bilibili favorites-folder link to share.

**Deleting a track also attempts to remove its corresponding Bilibili favorite.**

### Access from your phone

Connect your computer and phone to the same local network, then start the server so it listens on the LAN and claims the agreed discovery port:

```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open `http://YOUR_COMPUTER_LAN_IP:8000` on the phone. Both ends then point at the same backend and cross-device streaming works. With the Android app you never type an address: on the same Wi-Fi it finds the computer's backend and joins it automatically.

Defaults are intended for localhost or a trusted LAN. Configure HTTPS and access control before deploying for remote access.

## Configuration and data

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `BM_DATA_DIR` | Project's `data/` | Database, account credentials, caches |
| `BM_API_TOKEN` | Empty | Optional Bearer authentication for `/api/*`; media also accepts `?token=` |
| `BM_ALLOW_ORIGINS` | `*` | Comma-separated CORS origins |
| `BM_HOST` / `BM_PORT` | `0.0.0.0` / `8000` | Bind settings when using `python -m app.main`; `BM_PORT` is also the agreed discovery port |

When launching Uvicorn directly, use `--host` and `--port`. The API token does not protect the entire web interface; a token-protected backend is also skipped by auto-discovery from unknown devices.

Back up `data/`, but never commit its databases or cookies. The current version streams online and does not provide an offline music library. Startup migration attempts to convert older local audio records to online playback and removes old files after successful migration.

## Development

Built with Python, FastAPI, SQLite / SQLModel, httpx, Jinja2, htmx, and vanilla JavaScript.

```text
app/
  api/          API routes, audio stream proxy, LAN discovery
  bili/         Bilibili client, signing, link parsing
  db/           SQLite data models
  services/     Accounts, imports, sync, recommendations, lyrics, sessions
  web/          Routes, templates, CSS, JavaScript
tests/          Python and JavaScript regression tests
docs/shots/     UI records, including cross-device streaming
```

Run tests (JavaScript tests require Node.js):

```bash
python -m pytest -q
node --test tests/test_*.js
```

Headless end-to-end regression for streaming: start a test backend and headless Chrome, then run `node scripts/e2e-streaming.mjs`; the one-shot `scripts/e2e-streaming.sh` leaves an already-running 8000 instance alone.

Interactive API documentation: **http://127.0.0.1:8000/docs** while the server is running.

## Troubleshooting

**The phone did not auto-connect to the computer.**

Check, in order: same Wi-Fi with no AP isolation; the computer is signed in to the same Bilibili account and its backend is running; the computer is listening on port 8000; and both sides use matching `BM_API_TOKEN` settings. If all of that holds, reopen the page to scan again.

**A video plays on Bilibili, but the player reports it may be unavailable.**

This is a generic media-error message, not proof that the video was removed. Check the backend, terminal logs, Bilibili session, and network connectivity. API or CDN connection failures can prevent playback too.

**Some tracks have no lyrics or cannot play.**

Lyrics availability, video permissions, regional restrictions, removed content, and Bilibili API changes can affect availability. Streaming requires an active internet connection.

## Usage

This project is not affiliated with Bilibili. It is intended for personal use and learning. Audio, video, and artwork belong to their respective rights holders; follow platform rules and content permissions. Screenshot content is shown to illustrate the interface.

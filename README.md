# DAP Music Sync

Cross-platform (**Windows & macOS**) desktop application built with **Electron + React + TypeScript**, powered by **`yt-dlp`** and **`ffmpeg`**.

## Features

- **Smart Search & URL Omnibar:** Search YouTube Music for **Songs, Albums, and Playlists**, or paste any YouTube / YouTube Music track, album, or playlist URL directly.
- **Instant Stream Previews:** Audition tracks before downloading in the persistent bottom audio player (`127.0.0.1` loopback HTTP media server with full `206 Partial Content` scrubbing).
- **Multi-Format Tagged Downloads:** Download single tracks or batch-selected albums/playlists in **FLAC**, **MP3** (`320k` / `V0`), **M4A**, or **Opus**, complete with embedded metadata and `1:1` square JPEG cover art.
- **Persistent Local Music Library:** Automatically organizes and indexes downloaded tracks (`Artist / Album / 01 - Title` for multi-track albums, `Artist / Title` in the artist root for singles), badges owned tracks in search results, supports custom playlists, imports existing music folders, and plays offline.
- **Incremental DAP & Directory Sync:** Target any local folder, USB-connected Digital Audio Player (DAP), or microSD card (`E:\Music`, `/Volumes/DAP/Music`). Sync your **Entire Library** or **Selected Albums / Playlists / Songs** incrementally (only copying new/changed files), check target drive free space, export relative `.m3u8` playlists, and optionally mirror removals safely.
- **Cross-Platform CLI & Self-Updating:** Detects `yt-dlp` and `ffmpeg` from system `PATH` / WinGet / Homebrew (or auto-downloads standalone binaries on Windows and macOS), and supports in-app updates from **GitHub Releases** (`Phizzard/dap-music-sync`).

## Development (Node.js 20+ / 22 LTS)

```bash
# Install dependencies
npm install

# Launch desktop app in dev mode with hot reload
npm run dev

# Typecheck & production bundle
npm run typecheck
npm run build

# Build installers locally
npm run dist:win   # Windows (.exe NSIS installer)
npm run dist:mac   # macOS (.dmg & .zip Intel & Apple Silicon)
```

## Publishing a New Release (Auto-Update)

Bump `"version"` in `package.json` (e.g. `1.1.0`), commit, and push a version tag:

```bash
git tag v1.1.0
git push origin main --tags
```

GitHub Actions (`.github/workflows/release.yml`) will automatically build Windows and macOS installers and publish them to GitHub Releases so installed copies of **DAP Music Sync** detect and install the update.

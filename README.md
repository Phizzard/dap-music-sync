# CrateSync — YouTube Music Downloader, Library & DAP Sync

Cross-platform (**Windows & macOS**) desktop application built with **Electron + React + TypeScript**, powered by **`yt-dlp`** and **`ffmpeg`**.

## Features

- **Smart Search & URL Omnibar:** Search YouTube Music for **Songs, Albums, and Playlists**, or paste any YouTube / YouTube Music track, album, or playlist URL directly.
- **Instant Stream Previews:** Audition tracks before downloading in the persistent bottom audio player (`ytm-stream://` custom protocol with HTTP `Range` scrubbing).
- **Multi-Format Tagged Downloads:** Download single tracks or batch-selected albums/playlists in **FLAC**, **MP3** (`320k` / `V0`), **M4A**, or **Opus**, complete with embedded metadata and `1:1` square JPEG cover art.
- **Persistent Local Music Library:** Automatically organizes and indexes downloaded tracks (`Artist / Album / 01 - Title`), badges owned tracks in search results, supports custom playlists, imports existing music folders, and plays offline (`ytm-local://`).
- **Incremental DAP & Directory Sync:** Target any local folder, USB-connected Digital Audio Player (DAP), or microSD card (`E:\Music`, `/Volumes/DAP/Music`). Sync your **Entire Library** or **Selected Albums / Playlists / Songs** incrementally (only copying new/changed files), check target drive free space, export relative `.m3u8` playlists, and optionally mirror removals safely.
- **Cross-Platform CLI Management:** Detects `yt-dlp` and `ffmpeg` from system `PATH` / WinGet / Homebrew, or auto-downloads standalone binaries on Windows and macOS with one click.

## Development (Node.js 20+ / 22 LTS)

```bash
# Install dependencies
npm install

# Launch desktop app in dev mode with hot reload
npm run dev

# Typecheck & production bundle
npm run typecheck
npm run build

# Build installers
npm run dist:win   # Windows (.exe NSIS installer)
npm run dist:mac   # macOS (.dmg Intel & Apple Silicon)
```

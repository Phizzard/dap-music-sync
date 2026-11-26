import { execFile } from 'child_process'
import { promisify } from 'util'
import YTMusic from 'ytmusic-api'
import type { RemoteCollection, RemoteTrack, SearchResults } from '@shared/types'
import type { BinaryManager } from './binaryManager'
import type { LibraryService } from './libraryService'

const execFileAsync = promisify(execFile)

export function upgradeThumbnailUrl(url?: string): string | undefined {
  if (!url) return undefined
  // Upgrade small YouTube Music square artwork URLs to 544x544
  return url.replace(/=w\d+-h\d+([^&\s]*)/, '=w544-h544$1')
}

export function formatDuration(seconds?: number): string | undefined {
  if (seconds === undefined || seconds === null || isNaN(seconds) || seconds <= 0) return undefined
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export class SearchService {
  private ytmusic: YTMusic | null = null
  private initPromise: Promise<void> | null = null
  private albumMetaCache = new Map<
    string,
    { isSingle: boolean; songs: Array<{ videoId: string; name: string }>; albumName: string }
  >()

  constructor(
    private binaryManager: BinaryManager,
    private libraryService: LibraryService
  ) {}

  private async ensureYtMusic(): Promise<YTMusic> {
    if (this.ytmusic && this.initPromise) {
      await this.initPromise
      return this.ytmusic
    }
    const client = new YTMusic()
    this.initPromise = client.initialize().then(() => {
      this.ytmusic = client
    })
    await this.initPromise
    return client
  }

  private annotateTrackLibraryState(track: RemoteTrack): RemoteTrack {
    const owned = this.libraryService.findByVideoId(track.videoId)
    return {
      ...track,
      inLibrary: Boolean(owned),
      libraryTrackId: owned?.id
    }
  }

  public async search(query: string): Promise<SearchResults> {
    const trimmed = query.trim()
    if (!trimmed) {
      return { query: '', songs: [], albums: [], playlists: [], source: 'ytmusic' }
    }

    try {
      const client = await this.ensureYtMusic()
      const [rawSongs, rawAlbums, rawPlaylists] = await Promise.all([
        client.searchSongs(trimmed).catch(() => []),
        client.searchAlbums(trimmed).catch(() => []),
        client.searchPlaylists(trimmed).catch(() => [])
      ])

      if (rawSongs.length > 0 || rawAlbums.length > 0 || rawPlaylists.length > 0) {
        const songs: RemoteTrack[] = rawSongs.slice(0, 25).map((s) => {
          const bestThumb = s.thumbnails?.[s.thumbnails.length - 1]?.url
          const durationSec = typeof s.duration === 'number' ? s.duration : undefined
          return this.annotateTrackLibraryState({
            videoId: s.videoId,
            url: `https://music.youtube.com/watch?v=${s.videoId}`,
            title: s.name || 'Untitled',
            artist: s.artist?.name || 'Unknown Artist',
            album: s.album?.name,
            albumId: s.album?.albumId,
            durationSec,
            durationText: formatDuration(durationSec),
            thumbnailUrl: upgradeThumbnailUrl(bestThumb)
          })
        })

        const albums: RemoteCollection[] = rawAlbums.slice(0, 16).map((a) => {
          const bestThumb = a.thumbnails?.[a.thumbnails.length - 1]?.url
          const browseOrPlaylistUrl = a.playlistId
            ? `https://music.youtube.com/playlist?list=${a.playlistId}`
            : `https://music.youtube.com/browse/${a.albumId}`
          return {
            id: a.albumId || a.playlistId,
            url: browseOrPlaylistUrl,
            type: 'album',
            title: a.name || 'Untitled Album',
            author: a.artist?.name,
            year: a.year ? String(a.year) : undefined,
            thumbnailUrl: upgradeThumbnailUrl(bestThumb)
          }
        })

        const playlists: RemoteCollection[] = rawPlaylists.slice(0, 16).map((p) => {
          const bestThumb = p.thumbnails?.[p.thumbnails.length - 1]?.url
          return {
            id: p.playlistId,
            url: `https://music.youtube.com/playlist?list=${p.playlistId}`,
            type: 'playlist',
            title: p.name || 'Untitled Playlist',
            author: p.artist?.name,
            thumbnailUrl: upgradeThumbnailUrl(bestThumb)
          }
        })

        return {
          query: trimmed,
          songs,
          albums,
          playlists,
          source: 'ytmusic'
        }
      }
    } catch (err) {
      console.warn('ytmusic-api search error, falling back to yt-dlp:', err)
      this.ytmusic = null
      this.initPromise = null
    }

    return this.fallbackYtDlpSearch(trimmed)
  }

  private async fallbackYtDlpSearch(query: string): Promise<SearchResults> {
    const { ytdlpPath, jsRuntimeArgs } = await this.binaryManager.getPaths()
    const { stdout } = await execFileAsync(
      ytdlpPath,
      [...jsRuntimeArgs, '--flat-playlist', '--dump-single-json', '--no-warnings', `ytsearch15:${query}`],
      { timeout: 30000, maxBuffer: 15 * 1024 * 1024, windowsHide: true }
    )

    const data = JSON.parse(stdout)
    const entries = Array.isArray(data.entries) ? data.entries : []
    const songs: RemoteTrack[] = entries
      .filter((e: Record<string, unknown>) => Boolean(e?.id))
      .map((e: Record<string, unknown>) => {
        const videoId = String(e.id)
        const durationSec = typeof e.duration === 'number' ? Math.round(e.duration) : undefined
        const thumbs = Array.isArray(e.thumbnails) ? e.thumbnails : []
        const thumbUrl =
          thumbs.length > 0
            ? String((thumbs[thumbs.length - 1] as Record<string, unknown>).url || '')
            : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        return this.annotateTrackLibraryState({
          videoId,
          url: `https://music.youtube.com/watch?v=${videoId}`,
          title: String(e.title || 'Untitled'),
          artist: String(e.channel || e.uploader || 'Unknown Artist'),
          durationSec,
          durationText: formatDuration(durationSec),
          thumbnailUrl: thumbUrl
        })
      })

    return {
      query,
      songs,
      albums: [],
      playlists: [],
      source: 'ytdlp'
    }
  }

  public async getAlbumViaYtMusic(albumId: string): Promise<RemoteCollection | null> {
    try {
      const client = await this.ensureYtMusic()
      const album = await client.getAlbum(albumId)
      const bestThumb = album.thumbnails?.[album.thumbnails.length - 1]?.url
      const thumbUpgraded = upgradeThumbnailUrl(bestThumb)
      const tracks: RemoteTrack[] = (album.songs || []).map((s, idx) => {
        const durationSec = typeof s.duration === 'number' ? s.duration : undefined
        return this.annotateTrackLibraryState({
          videoId: s.videoId,
          url: `https://music.youtube.com/watch?v=${s.videoId}`,
          title: s.name || `Track ${idx + 1}`,
          artist: s.artist?.name || album.artist?.name || 'Unknown Artist',
          album: album.name,
          trackNumber: idx + 1,
          durationSec,
          durationText: formatDuration(durationSec),
          thumbnailUrl: thumbUpgraded
        })
      })

      return {
        id: album.albumId,
        url: `https://music.youtube.com/browse/${album.albumId}`,
        type: 'album',
        title: album.name,
        author: album.artist?.name,
        year: album.year ? String(album.year) : undefined,
        trackCount: tracks.length,
        thumbnailUrl: thumbUpgraded,
        tracks
      }
    } catch {
      return null
    }
  }

  public async inspectReleaseByAlbumId(
    albumId: string,
    videoId: string
  ): Promise<{ isSingle: boolean; trackNumber?: number; albumName?: string } | null> {
    if (!albumId || !albumId.startsWith('MPREb_')) return null
    try {
      let cached = this.albumMetaCache.get(albumId)
      if (!cached) {
        const client = await this.ensureYtMusic()
        const album = await client.getAlbum(albumId)
        const songs = (album.songs || []).map((s) => ({
          videoId: s.videoId,
          name: s.name || ''
        }))
        cached = {
          isSingle: songs.length <= 1,
          songs,
          albumName: album.name || ''
        }
        this.albumMetaCache.set(albumId, cached)
      }

      if (cached.isSingle) {
        return { isSingle: true }
      }
      const idx = cached.songs.findIndex((s) => s.videoId === videoId)
      return {
        isSingle: false,
        trackNumber: idx >= 0 ? idx + 1 : undefined,
        albumName: cached.albumName || undefined
      }
    } catch {
      return null
    }
  }
}

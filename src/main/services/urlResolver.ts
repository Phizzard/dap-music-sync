import { execFile } from 'child_process'
import { promisify } from 'util'
import type { RemoteCollection, RemoteTrack, ResolvedUrlResult } from '@shared/types'
import type { BinaryManager } from './binaryManager'
import type { LibraryService } from './libraryService'
import { formatDuration, SearchService, upgradeThumbnailUrl } from './searchService'

const execFileAsync = promisify(execFile)

export class UrlResolverService {
  constructor(
    private binaryManager: BinaryManager,
    private libraryService: LibraryService,
    private searchService: SearchService
  ) {}

  private annotate(track: RemoteTrack): RemoteTrack {
    const owned = this.libraryService.findByVideoId(track.videoId)
    return {
      ...track,
      inLibrary: Boolean(owned),
      libraryTrackId: owned?.id
    }
  }

  public async resolveUrl(rawUrl: string): Promise<ResolvedUrlResult> {
    const trimmed = rawUrl.trim()
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error('Invalid URL format.')
    }

    // Handle YT Music browse/MPREb_ album URLs directly
    const browseMatch = parsed.pathname.match(/\/browse\/(MPREb_[A-Za-z0-9_-]+)/)
    if (browseMatch) {
      const album = await this.searchService.getAlbumViaYtMusic(browseMatch[1])
      if (album) {
        return { kind: 'collection', collection: album }
      }
    }

    const videoIdParam = parsed.searchParams.get('v')
    const listParam = parsed.searchParams.get('list')
    const isExplicitPlaylistPage = parsed.pathname.includes('/playlist')

    // If user pasted a watch?v=... URL (even if YT Music appended &list=RDAMVM...), resolve single track unless it's a /playlist page
    const resolveSingleTrack = Boolean(videoIdParam && !isExplicitPlaylistPage)

    const { ytdlpPath, jsRuntimeArgs } = await this.binaryManager.getPaths()
    const args = resolveSingleTrack
      ? [...jsRuntimeArgs, '--no-playlist', '--dump-single-json', '--no-warnings', trimmed]
      : [...jsRuntimeArgs, '--flat-playlist', '--dump-single-json', '--no-warnings', trimmed]

    const { stdout } = await execFileAsync(ytdlpPath, args, {
      timeout: 45000,
      maxBuffer: 25 * 1024 * 1024,
      windowsHide: true
    })

    const data = JSON.parse(stdout)

    if (data._type === 'playlist' || Array.isArray(data.entries)) {
      const collectionType: 'album' | 'playlist' =
        (listParam && listParam.startsWith('OLAK5uy_')) ||
        String(data.title || '').startsWith('Album - ')
          ? 'album'
          : 'playlist'

      const cleanTitle = String(data.title || 'Untitled Collection').replace(/^Album\s*-\s*/i, '')
      const thumbs = Array.isArray(data.thumbnails) ? data.thumbnails : []
      const colThumb =
        thumbs.length > 0
          ? upgradeThumbnailUrl(String(thumbs[thumbs.length - 1].url || ''))
          : undefined

      const entries = Array.isArray(data.entries) ? data.entries : []
      const tracks: RemoteTrack[] = entries
        .filter((e: Record<string, unknown>) => Boolean(e?.id))
        .map((e: Record<string, unknown>, idx: number) => {
          const vid = String(e.id)
          const dur = typeof e.duration === 'number' ? Math.round(e.duration) : undefined
          const entryThumbs = Array.isArray(e.thumbnails) ? e.thumbnails : []
          const tThumb =
            entryThumbs.length > 0
              ? upgradeThumbnailUrl(
                  String((entryThumbs[entryThumbs.length - 1] as Record<string, unknown>).url || '')
                )
              : colThumb || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`

          return this.annotate({
            videoId: vid,
            url: `https://music.youtube.com/watch?v=${vid}`,
            title: String(e.title || `Track ${idx + 1}`),
            artist: String(
              e.artist || e.creator || e.channel || data.uploader || data.channel || 'Unknown Artist'
            ).replace(/\s*-\s*Topic$/i, ''),
            album: collectionType === 'album' ? cleanTitle : undefined,
            trackNumber: collectionType === 'album' ? idx + 1 : undefined,
            durationSec: dur,
            durationText: formatDuration(dur),
            thumbnailUrl: tThumb
          })
        })

      return {
        kind: 'collection',
        collection: {
          id: String(data.id || listParam || trimmed),
          url: trimmed,
          type: collectionType,
          title: cleanTitle,
          author: String(data.uploader || data.channel || '').replace(/\s*-\s*Topic$/i, '') || undefined,
          trackCount: tracks.length,
          thumbnailUrl: colThumb || tracks[0]?.thumbnailUrl,
          tracks
        }
      }
    }

    // Single track
    const vid = String(data.id || videoIdParam || '')
    const dur = typeof data.duration === 'number' ? Math.round(data.duration) : undefined
    const track = this.annotate({
      videoId: vid,
      url: `https://music.youtube.com/watch?v=${vid}`,
      title: String(data.track || data.title || 'Untitled'),
      artist: String(data.artist || data.creator || data.uploader || data.channel || 'Unknown Artist').replace(
        /\s*-\s*Topic$/i,
        ''
      ),
      album: data.album ? String(data.album) : undefined,
      durationSec: dur,
      durationText: formatDuration(dur),
      thumbnailUrl: upgradeThumbnailUrl(
        String(data.thumbnail || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`)
      )
    })

    return { kind: 'track', track }
  }

  public async resolveCollection(collection: RemoteCollection): Promise<RemoteCollection> {
    if (collection.tracks && collection.tracks.length > 0) {
      return {
        ...collection,
        tracks: collection.tracks.map((t) => this.annotate(t))
      }
    }

    if (collection.id.startsWith('MPREb_')) {
      const viaApi = await this.searchService.getAlbumViaYtMusic(collection.id)
      if (viaApi && viaApi.tracks && viaApi.tracks.length > 0) {
        return viaApi
      }
    }

    const res = await this.resolveUrl(collection.url)
    if (res.kind === 'collection' && res.collection) {
      return {
        ...collection,
        ...res.collection,
        title: collection.title || res.collection.title,
        author: collection.author || res.collection.author,
        thumbnailUrl: collection.thumbnailUrl || res.collection.thumbnailUrl
      }
    }
    throw new Error('Unable to load tracks for this collection.')
  }
}

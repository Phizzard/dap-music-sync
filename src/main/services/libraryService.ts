import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { parseFile } from 'music-metadata'
import type { FolderStructure, LibraryPlaylist, LibraryTrack } from '@shared/types'
import type { StoreService } from './storeService'

const SUPPORTED_AUDIO_EXTS = new Set([
  '.flac',
  '.mp3',
  '.m4a',
  '.aac',
  '.opus',
  '.ogg',
  '.wav'
])

/**
 * Sanitizes a single path segment so it is 100% valid across Windows, macOS,
 * and FAT32/exFAT DAP microSD cards.
 */
export function sanitizePathSegment(input: string, fallback = 'Unknown'): string {
  const cleaned = (input || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!cleaned) return fallback
  // Guard Windows reserved device names
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return `_${cleaned}`
  }
  return cleaned.slice(0, 110)
}

/**
 * Determines whether a track is a standalone single (or has no multi-track album)
 * so it is placed directly in the Artist's root folder instead of creating a 1-song subfolder.
 */
export function isSingleOrStandaloneTrack(meta: {
  title: string
  fallbackTitle?: string
  album?: string
  isSingleRelease?: boolean
}): boolean {
  if (meta.isSingleRelease) return true
  const rawAlbum = (meta.album || '').trim()
  if (!rawAlbum) return true

  const lowerAlbum = rawAlbum.toLowerCase()
  if (
    lowerAlbum === 'singles' ||
    lowerAlbum === 'single' ||
    lowerAlbum === 'unknown' ||
    lowerAlbum === 'unknown album'
  ) {
    return true
  }
  if (/[-(\[]\s*single\s*[)\]]?$/i.test(rawAlbum)) {
    return true
  }

  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/\((feat\.?|ft\.?|with|prod\.?)[^)]*\)/gi, '')
      .replace(/\[(feat\.?|ft\.?|with|prod\.?)[^\]]*\]/gi, '')
      .replace(/[-(\[]\s*single\s*[)\]]?$/gi, '')
      .replace(/[^\p{L}\p{N}]+/gu, '')
      .trim()

  const nAlbum = norm(rawAlbum)
  if (!nAlbum) return true

  const candidateTitles = [meta.title, meta.fallbackTitle].filter(Boolean) as string[]
  for (const t of candidateTitles) {
    if (norm(t) === nAlbum) return true
    for (const part of t.split(/\s+[-–—/]\s+/)) {
      if (part.trim() && norm(part) === nAlbum) return true
    }
  }
  return false
}

export function buildRelativeMusicPath(
  meta: {
    artist: string
    album?: string
    title: string
    fallbackTitle?: string
    trackNumber?: number
    isSingle?: boolean
  },
  extWithDot: string,
  structure: FolderStructure
): string {
  const artist = sanitizePathSegment(meta.artist, 'Unknown Artist')
  const title = sanitizePathSegment(meta.title, 'Untitled')
  const ext = extWithDot.startsWith('.') ? extWithDot.toLowerCase() : `.${extWithDot.toLowerCase()}`

  if (structure === 'flat') {
    return `${artist} - ${title}${ext}`
  }

  const single = isSingleOrStandaloneTrack({
    title: meta.title,
    fallbackTitle: meta.fallbackTitle,
    album: meta.album,
    isSingleRelease: meta.isSingle
  })

  if (structure === 'artist' || single) {
    return path.posix.join(artist, `${title}${ext}`)
  }

  const album = sanitizePathSegment(meta.album!, 'Unknown Album')
  const trackPrefix =
    meta.trackNumber && meta.trackNumber > 0
      ? `${String(meta.trackNumber).padStart(2, '0')} - `
      : ''
  return path.posix.join(artist, album, `${trackPrefix}${title}${ext}`)
}

export class LibraryService {
  private listeners: Array<
    (payload: { tracks: LibraryTrack[]; playlists: LibraryPlaylist[] }) => void
  > = []

  constructor(private store: StoreService) {}

  public onUpdated(
    cb: (payload: { tracks: LibraryTrack[]; playlists: LibraryPlaylist[] }) => void
  ): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }

  private emitUpdated(): void {
    const payload = this.getLibrary()
    for (const cb of this.listeners) {
      cb(payload)
    }
  }

  public getLibrary(): { tracks: LibraryTrack[]; playlists: LibraryPlaylist[] } {
    return {
      tracks: this.store.getTracks(),
      playlists: this.store.getPlaylists()
    }
  }

  public getTrackById(id: string): LibraryTrack | undefined {
    return this.store.getTracks().find((t) => t.id === id)
  }

  public findByVideoId(videoId: string): LibraryTrack | undefined {
    if (!videoId) return undefined
    return this.store.getTracks().find((t) => t.sourceVideoId === videoId && !t.missingOnDisk)
  }

  /**
   * Imports a newly downloaded audio file into the managed Library directory,
   * parses embedded tags/artwork, and registers it in the catalog.
   */
  public async importDownloadedTrack(params: {
    tempFilePath: string
    sourceVideoId: string
    sourceUrl: string
    fallbackTitle: string
    fallbackArtist: string
    fallbackAlbum?: string
    fallbackTrackNumber?: number
    isSingleRelease?: boolean
    thumbnailUrl?: string
    targetPlaylistName?: string
  }): Promise<LibraryTrack> {
    const settings = this.store.getSettings()
    const ext = path.extname(params.tempFilePath).toLowerCase() || `.${settings.defaultFormat}`

    let parsedTitle = params.fallbackTitle
    let parsedArtist = params.fallbackArtist
    let parsedAlbum = params.fallbackAlbum || ''
    let parsedTrackNum = params.fallbackTrackNumber
    let parsedYear: number | undefined
    let durationSec = 0
    let bitrateKbps: number | undefined
    let sampleRate: number | undefined
    let coverArtDataUrl: string | undefined

    try {
      const metadata = await parseFile(params.tempFilePath, { duration: true })
      if (metadata.common.title) parsedTitle = metadata.common.title
      if (metadata.common.artist) parsedArtist = metadata.common.artist
      if (metadata.common.album) parsedAlbum = metadata.common.album
      if (metadata.common.track?.no) parsedTrackNum = metadata.common.track.no
      if (metadata.common.year) parsedYear = metadata.common.year
      if (metadata.format.duration) durationSec = Math.round(metadata.format.duration)
      if (metadata.format.bitrate) bitrateKbps = Math.round(metadata.format.bitrate / 1000)
      if (metadata.format.sampleRate) sampleRate = metadata.format.sampleRate

      const pic = metadata.common.picture?.[0]
      if (pic && pic.data && pic.data.length < 1_500_000) {
        const mime = pic.format || 'image/jpeg'
        coverArtDataUrl = `data:${mime};base64,${Buffer.from(pic.data).toString('base64')}`
      }
    } catch (err) {
      console.warn('music-metadata parse warning:', err)
    }

    const single = isSingleOrStandaloneTrack({
      title: parsedTitle,
      fallbackTitle: params.fallbackTitle,
      album: parsedAlbum,
      isSingleRelease: params.isSingleRelease
    })

    const effectiveAlbum = single ? 'Singles' : parsedAlbum || 'Unknown Album'

    const relPosix = buildRelativeMusicPath(
      {
        artist: parsedArtist,
        album: single ? undefined : effectiveAlbum,
        title: parsedTitle,
        fallbackTitle: params.fallbackTitle,
        trackNumber: single ? undefined : parsedTrackNum,
        isSingle: single
      },
      ext,
      settings.folderStructure
    )

    const destPath = path.join(settings.libraryRootPath, ...relPosix.split('/'))
    await fsp.mkdir(path.dirname(destPath), { recursive: true })

    if (path.resolve(params.tempFilePath) !== path.resolve(destPath)) {
      try {
        await fsp.rename(params.tempFilePath, destPath)
      } catch {
        await fsp.copyFile(params.tempFilePath, destPath)
        await fsp.unlink(params.tempFilePath).catch(() => {})
      }
    }

    const stat = await fsp.stat(destPath)
    const tracks = [...this.store.getTracks()]
    const existingIdx = tracks.findIndex(
      (t) =>
        (params.sourceVideoId && t.sourceVideoId === params.sourceVideoId) ||
        path.resolve(t.filePath) === path.resolve(destPath)
    )

    const record: LibraryTrack = {
      id: existingIdx >= 0 ? tracks[existingIdx].id : crypto.randomUUID(),
      sourceVideoId: params.sourceVideoId,
      sourceUrl: params.sourceUrl,
      title: parsedTitle,
      artist: parsedArtist,
      album: effectiveAlbum,
      isSingle: single,
      trackNumber: single ? undefined : parsedTrackNum,
      year: parsedYear,
      durationSec,
      format: ext.replace('.', '').toUpperCase(),
      bitrateKbps,
      sampleRate,
      fileSize: stat.size,
      filePath: destPath,
      relativePath: relPosix,
      coverArtDataUrl,
      thumbnailUrl: params.thumbnailUrl,
      addedAt: existingIdx >= 0 ? tracks[existingIdx].addedAt : new Date().toISOString(),
      missingOnDisk: false
    }

    if (existingIdx >= 0) {
      tracks[existingIdx] = record
    } else {
      tracks.unshift(record)
    }
    this.store.setTracks(tracks)

    if (params.targetPlaylistName && params.targetPlaylistName.trim()) {
      this.ensurePlaylistWithTrack(params.targetPlaylistName.trim(), record.id)
    }

    await this.store.flush()
    this.emitUpdated()
    return record
  }

  private ensurePlaylistWithTrack(playlistName: string, trackId: string): void {
    const playlists = [...this.store.getPlaylists()]
    let pl = playlists.find((p) => p.name.toLowerCase() === playlistName.toLowerCase())
    const now = new Date().toISOString()
    if (!pl) {
      pl = {
        id: crypto.randomUUID(),
        name: playlistName,
        trackIds: [trackId],
        createdAt: now,
        updatedAt: now
      }
      playlists.unshift(pl)
    } else if (!pl.trackIds.includes(trackId)) {
      pl.trackIds.push(trackId)
      pl.updatedAt = now
    }
    this.store.setPlaylists(playlists)
  }

  /**
   * Reorganizes existing files inside libraryRootPath to match the current folderStructure
   * (e.g., moving single tracks out of 1-song folders into the Artist's root folder) and prunes empty directories.
   */
  public async reorganizeLibrary(): Promise<{ moved: number }> {
    const settings = this.store.getSettings()
    const rootResolved = path.resolve(settings.libraryRootPath)
    if (!fs.existsSync(rootResolved)) return { moved: 0 }

    const tracks = [...this.store.getTracks()]
    let moved = 0

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      if (!t.filePath || !fs.existsSync(t.filePath)) continue
      if (!path.resolve(t.filePath).toLowerCase().startsWith(rootResolved.toLowerCase())) {
        continue
      }

      const ext = path.extname(t.filePath).toLowerCase() || `.${t.format.toLowerCase()}`
      const single = isSingleOrStandaloneTrack({
        title: t.title,
        album: t.album,
        isSingleRelease: t.isSingle
      })
      const expectedRel = buildRelativeMusicPath(
        {
          artist: t.artist,
          album: single ? undefined : t.album,
          title: t.title,
          trackNumber: single ? undefined : t.trackNumber,
          isSingle: single
        },
        ext,
        settings.folderStructure
      )

      const destPath = path.join(settings.libraryRootPath, ...expectedRel.split('/'))
      if (path.resolve(destPath).toLowerCase() !== path.resolve(t.filePath).toLowerCase()) {
        const oldDir = path.dirname(t.filePath)
        await fsp.mkdir(path.dirname(destPath), { recursive: true })
        try {
          await fsp.rename(t.filePath, destPath)
        } catch {
          await fsp.copyFile(t.filePath, destPath)
          await fsp.unlink(t.filePath).catch(() => {})
        }
        await this.pruneEmptyDirs(oldDir, rootResolved)
        tracks[i] = {
          ...t,
          album: single ? 'Singles' : t.album,
          isSingle: single,
          filePath: destPath,
          relativePath: expectedRel
        }
        moved++
      } else if (single && (!t.isSingle || t.album !== 'Singles')) {
        tracks[i] = { ...t, album: 'Singles', isSingle: true }
      }
    }

    if (moved > 0) {
      this.store.setTracks(tracks)
      await this.store.flush()
      this.emitUpdated()
    }
    return { moved }
  }

  private async pruneEmptyDirs(dir: string, stopAtRoot: string): Promise<void> {
    const stopLower = path.resolve(stopAtRoot).toLowerCase()
    let current = path.resolve(dir)
    while (current.toLowerCase() !== stopLower && current.toLowerCase().startsWith(stopLower)) {
      try {
        const entries = await fsp.readdir(current)
        if (entries.length === 0) {
          await fsp.rmdir(current)
          current = path.dirname(current)
        } else {
          break
        }
      } catch {
        break
      }
    }
  }

  /**
   * Scans the library root (and optionally imports audio files from an external folder).
   */
  public async scanLibraryFolder(
    externalFolderPath?: string
  ): Promise<{ added: number; updated: number; missing: number }> {
    const settings = this.store.getSettings()
    await fsp.mkdir(settings.libraryRootPath, { recursive: true })

    let added = 0
    let updated = 0
    let missing = 0

    // 1. Check existing tracks on disk
    const tracks = [...this.store.getTracks()]
    for (const t of tracks) {
      const exists = fs.existsSync(t.filePath)
      if (!exists && !t.missingOnDisk) {
        t.missingOnDisk = true
        missing++
      } else if (exists && t.missingOnDisk) {
        t.missingOnDisk = false
        updated++
      }
    }

    // 2. If external folder supplied, copy/import audio files into libraryRootPath
    if (externalFolderPath && fs.existsSync(externalFolderPath)) {
      const extFiles = await this.walkAudioFiles(externalFolderPath)
      for (const srcFile of extFiles) {
        // Skip if already inside libraryRootPath (handled in step 3)
        if (
          path
            .resolve(srcFile)
            .toLowerCase()
            .startsWith(path.resolve(settings.libraryRootPath).toLowerCase())
        ) {
          continue
        }
        const imported = await this.ingestExternalAudioFile(srcFile, true)
        if (imported === 'added') added++
        else if (imported === 'updated') updated++
      }
    }

    // 3. Scan libraryRootPath for any unindexed files
    const libFiles = await this.walkAudioFiles(settings.libraryRootPath)
    const knownPaths = new Set(this.store.getTracks().map((t) => path.resolve(t.filePath).toLowerCase()))
    for (const libFile of libFiles) {
      if (!knownPaths.has(path.resolve(libFile).toLowerCase())) {
        const res = await this.ingestExternalAudioFile(libFile, false)
        if (res === 'added') added++
      }
    }

    await this.store.flush()
    this.emitUpdated()
    return { added, updated, missing }
  }

  private async ingestExternalAudioFile(
    filePath: string,
    copyToLibrary: boolean
  ): Promise<'added' | 'updated' | 'skipped'> {
    const settings = this.store.getSettings()
    const ext = path.extname(filePath).toLowerCase()
    if (!SUPPORTED_AUDIO_EXTS.has(ext)) return 'skipped'

    const baseName = path.basename(filePath, ext)
    let title = baseName
    let artist = 'Unknown Artist'
    let album = 'Unknown Album'
    let trackNumber: number | undefined
    let year: number | undefined
    let durationSec = 0
    let bitrateKbps: number | undefined
    let sampleRate: number | undefined
    let coverArtDataUrl: string | undefined

    try {
      const meta = await parseFile(filePath, { duration: true })
      if (meta.common.title) title = meta.common.title
      if (meta.common.artist) artist = meta.common.artist
      if (meta.common.album) album = meta.common.album
      if (meta.common.track?.no) trackNumber = meta.common.track.no
      if (meta.common.year) year = meta.common.year
      if (meta.format.duration) durationSec = Math.round(meta.format.duration)
      if (meta.format.bitrate) bitrateKbps = Math.round(meta.format.bitrate / 1000)
      if (meta.format.sampleRate) sampleRate = meta.format.sampleRate

      const pic = meta.common.picture?.[0]
      if (pic && pic.data && pic.data.length < 1_500_000) {
        coverArtDataUrl = `data:${pic.format || 'image/jpeg'};base64,${Buffer.from(pic.data).toString('base64')}`
      }
    } catch {
      // fallback to filename
    }

    let finalPath = filePath
    let relPosix: string

    if (copyToLibrary) {
      relPosix = buildRelativeMusicPath(
        { artist, album, title, trackNumber },
        ext,
        settings.folderStructure
      )
      finalPath = path.join(settings.libraryRootPath, ...relPosix.split('/'))
      await fsp.mkdir(path.dirname(finalPath), { recursive: true })
      if (!fs.existsSync(finalPath)) {
        await fsp.copyFile(filePath, finalPath)
      }
    } else {
      relPosix = path
        .relative(settings.libraryRootPath, filePath)
        .split(path.sep)
        .join('/')
    }

    const stat = await fsp.stat(finalPath)
    const tracks = [...this.store.getTracks()]
    const existingIdx = tracks.findIndex(
      (t) => path.resolve(t.filePath).toLowerCase() === path.resolve(finalPath).toLowerCase()
    )

    const record: LibraryTrack = {
      id: existingIdx >= 0 ? tracks[existingIdx].id : crypto.randomUUID(),
      title,
      artist,
      album,
      trackNumber,
      year,
      durationSec,
      format: ext.replace('.', '').toUpperCase(),
      bitrateKbps,
      sampleRate,
      fileSize: stat.size,
      filePath: finalPath,
      relativePath: relPosix,
      coverArtDataUrl,
      addedAt: existingIdx >= 0 ? tracks[existingIdx].addedAt : new Date().toISOString(),
      missingOnDisk: false
    }

    if (existingIdx >= 0) {
      tracks[existingIdx] = record
      this.store.setTracks(tracks)
      return 'updated'
    } else {
      tracks.unshift(record)
      this.store.setTracks(tracks)
      return 'added'
    }
  }

  private async walkAudioFiles(dir: string): Promise<string[]> {
    const results: string[] = []
    const walk = async (current: string): Promise<void> => {
      let entries: fs.Dirent[] = []
      try {
        entries = await fsp.readdir(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (SUPPORTED_AUDIO_EXTS.has(ext)) {
            results.push(full)
          }
        }
      }
    }
    await walk(dir)
    return results
  }

  public async deleteTrack(trackId: string, deleteFromDisk: boolean): Promise<void> {
    const tracks = [...this.store.getTracks()]
    const idx = tracks.findIndex((t) => t.id === trackId)
    if (idx < 0) return
    const [removed] = tracks.splice(idx, 1)
    this.store.setTracks(tracks)

    if (deleteFromDisk && removed.filePath && fs.existsSync(removed.filePath)) {
      await fsp.unlink(removed.filePath).catch(() => {})
    }

    // Remove from playlists
    const playlists = this.store.getPlaylists().map((p) => ({
      ...p,
      trackIds: p.trackIds.filter((id) => id !== trackId)
    }))
    this.store.setPlaylists(playlists)

    await this.store.flush()
    this.emitUpdated()
  }

  public async updateTrackMeta(
    trackId: string,
    patch: Partial<Pick<LibraryTrack, 'title' | 'artist' | 'album' | 'trackNumber'>>
  ): Promise<LibraryTrack> {
    const tracks = [...this.store.getTracks()]
    const idx = tracks.findIndex((t) => t.id === trackId)
    if (idx < 0) throw new Error('Track not found')
    tracks[idx] = { ...tracks[idx], ...patch }
    this.store.setTracks(tracks)
    await this.store.flush()
    this.emitUpdated()
    return tracks[idx]
  }

  public async createPlaylist(name: string, description?: string): Promise<LibraryPlaylist> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Playlist name is required')
    const now = new Date().toISOString()
    const pl: LibraryPlaylist = {
      id: crypto.randomUUID(),
      name: trimmed,
      description: description?.trim(),
      trackIds: [],
      createdAt: now,
      updatedAt: now
    }
    this.store.setPlaylists([pl, ...this.store.getPlaylists()])
    await this.store.flush()
    this.emitUpdated()
    return pl
  }

  public async renamePlaylist(
    playlistId: string,
    name: string,
    description?: string
  ): Promise<LibraryPlaylist> {
    const playlists = [...this.store.getPlaylists()]
    const idx = playlists.findIndex((p) => p.id === playlistId)
    if (idx < 0) throw new Error('Playlist not found')
    playlists[idx] = {
      ...playlists[idx],
      name: name.trim() || playlists[idx].name,
      description: description?.trim(),
      updatedAt: new Date().toISOString()
    }
    this.store.setPlaylists(playlists)
    await this.store.flush()
    this.emitUpdated()
    return playlists[idx]
  }

  public async deletePlaylist(playlistId: string): Promise<void> {
    this.store.setPlaylists(this.store.getPlaylists().filter((p) => p.id !== playlistId))
    await this.store.flush()
    this.emitUpdated()
  }

  public async addTracksToPlaylist(
    playlistId: string,
    trackIds: string[]
  ): Promise<LibraryPlaylist> {
    const playlists = [...this.store.getPlaylists()]
    const idx = playlists.findIndex((p) => p.id === playlistId)
    if (idx < 0) throw new Error('Playlist not found')
    const merged = [...playlists[idx].trackIds]
    for (const id of trackIds) {
      if (!merged.includes(id)) merged.push(id)
    }
    playlists[idx] = { ...playlists[idx], trackIds: merged, updatedAt: new Date().toISOString() }
    this.store.setPlaylists(playlists)
    await this.store.flush()
    this.emitUpdated()
    return playlists[idx]
  }

  public async removeTrackFromPlaylist(
    playlistId: string,
    trackId: string
  ): Promise<LibraryPlaylist> {
    const playlists = [...this.store.getPlaylists()]
    const idx = playlists.findIndex((p) => p.id === playlistId)
    if (idx < 0) throw new Error('Playlist not found')
    playlists[idx] = {
      ...playlists[idx],
      trackIds: playlists[idx].trackIds.filter((id) => id !== trackId),
      updatedAt: new Date().toISOString()
    }
    this.store.setPlaylists(playlists)
    await this.store.flush()
    this.emitUpdated()
    return playlists[idx]
  }
}

import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import type {
  DapProfile,
  LibraryPlaylist,
  LibraryTrack,
  SyncPlan,
  SyncPlanItem,
  SyncProgress
} from '@shared/types'
import { buildRelativeMusicPath, sanitizePathSegment } from './libraryService'
import type { LibraryService } from './libraryService'
import type { StoreService } from './storeService'

const MANIFEST_FILENAME = '.ytm-dap-manifest.json'

interface DapManifest {
  version: 1
  updatedAt: string
  syncedRelativePaths: string[]
}

export class DapSyncService {
  private progress: SyncProgress = {
    active: false,
    stage: 'idle',
    completedFiles: 0,
    totalFiles: 0,
    copiedBytes: 0,
    totalBytes: 0
  }
  private cancelRequested = false
  private listeners: Array<(progress: SyncProgress) => void> = []

  constructor(
    private store: StoreService,
    private libraryService: LibraryService
  ) {}

  public onProgress(cb: (progress: SyncProgress) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }

  private emitProgress(next: SyncProgress): void {
    this.progress = next
    for (const cb of this.listeners) {
      cb({ ...this.progress })
    }
  }

  public getProgress(): SyncProgress {
    return { ...this.progress }
  }

  public getProfiles(): DapProfile[] {
    return this.store.getDapProfiles()
  }

  public async saveProfile(
    input: Omit<DapProfile, 'id'> & { id?: string }
  ): Promise<DapProfile> {
    const profiles = [...this.store.getDapProfiles()]
    const profile: DapProfile = {
      ...input,
      id: input.id || crypto.randomUUID(),
      name: input.name.trim() || 'My DAP',
      targetPath: input.targetPath.trim(),
      selectedArtists: input.selectedArtists || []
    }

    const idx = profiles.findIndex((p) => p.id === profile.id)
    if (idx >= 0) {
      profiles[idx] = profile
    } else {
      profiles.push(profile)
    }
    this.store.setDapProfiles(profiles)
    await this.store.flush()
    return profile
  }

  public async deleteProfile(profileId: string): Promise<void> {
    this.store.setDapProfiles(this.store.getDapProfiles().filter((p) => p.id !== profileId))
    await this.store.flush()
  }

  private resolveSelectedTracks(profile: DapProfile): {
    tracks: LibraryTrack[]
    playlistsToExport: LibraryPlaylist[]
  } {
    const { tracks: allTracks, playlists: allPlaylists } = this.libraryService.getLibrary()
    const validTracks = allTracks.filter((t) => !t.missingOnDisk && fs.existsSync(t.filePath))

    if (profile.syncMode === 'all') {
      return {
        tracks: validTracks,
        playlistsToExport: profile.exportM3u8 ? allPlaylists : []
      }
    }

    const trackIdSet = new Set(profile.selectedTrackIds)
    const albumKeySet = new Set(profile.selectedAlbums)
    const artistSet = new Set(profile.selectedArtists || [])
    const selectedPlaylists = allPlaylists.filter((p) =>
      profile.selectedPlaylistIds.includes(p.id)
    )
    for (const pl of selectedPlaylists) {
      for (const tid of pl.trackIds) {
        trackIdSet.add(tid)
      }
    }

    const chosen = validTracks.filter((t) => {
      if (trackIdSet.has(t.id)) return true
      if (artistSet.has(t.artist)) return true
      const albumKey = `${t.artist}|||${t.album}`
      if (albumKeySet.has(albumKey)) return true
      return false
    })

    return {
      tracks: chosen,
      playlistsToExport: profile.exportM3u8 ? selectedPlaylists : []
    }
  }

  private findExistingAncestor(targetPath: string): string | null {
    let current = path.resolve(targetPath)
    while (true) {
      if (fs.existsSync(current)) return current
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
  }

  private async readManifest(targetPath: string): Promise<DapManifest | null> {
    try {
      const manifestPath = path.join(targetPath, MANIFEST_FILENAME)
      if (!fs.existsSync(manifestPath)) return null
      const raw = await fsp.readFile(manifestPath, 'utf-8')
      return JSON.parse(raw) as DapManifest
    } catch {
      return null
    }
  }

  public async computeSyncPlan(profileId: string): Promise<SyncPlan> {
    const profile = this.getProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error('DAP Sync profile not found')

    const { tracks, playlistsToExport } = this.resolveSelectedTracks(profile)

    if (!profile.targetPath) {
      return {
        profileId,
        targetPath: '',
        targetAvailable: false,
        toCopy: [],
        skippedCount: 0,
        skippedBytes: 0,
        toCopyBytes: 0,
        totalSelectedCount: tracks.length,
        toRemoveRelativePaths: [],
        playlistsToExport: playlistsToExport.length,
        insufficientSpace: false,
        warning: 'Select a target directory or mounted DAP / SD card folder.'
      }
    }

    const ancestor = this.findExistingAncestor(profile.targetPath)
    if (!ancestor) {
      return {
        profileId,
        targetPath: profile.targetPath,
        targetAvailable: false,
        toCopy: [],
        skippedCount: 0,
        skippedBytes: 0,
        toCopyBytes: 0,
        totalSelectedCount: tracks.length,
        toRemoveRelativePaths: [],
        playlistsToExport: playlistsToExport.length,
        insufficientSpace: false,
        warning: 'Target drive is not connected or path is unreachable.'
      }
    }

    let freeBytes: number | undefined
    let totalBytes: number | undefined
    try {
      const stats = await fsp.statfs(ancestor)
      freeBytes = Number(stats.bavail) * Number(stats.bsize)
      totalBytes = Number(stats.blocks) * Number(stats.bsize)
    } catch {
      // statfs unavailable on some virtual mounts
    }

    const toCopy: SyncPlanItem[] = []
    let skippedCount = 0
    let skippedBytes = 0
    let toCopyBytes = 0
    const desiredRelPaths = new Set<string>()

    for (const track of tracks) {
      const ext = path.extname(track.filePath) || `.${track.format.toLowerCase()}`
      const relPosix = buildRelativeMusicPath(
        {
          artist: track.artist,
          album: track.album,
          title: track.title,
          trackNumber: track.trackNumber,
          isSingle: track.isSingle
        },
        ext,
        profile.folderTemplate
      )
      desiredRelPaths.add(relPosix)

      const destFullPath = path.join(profile.targetPath, ...relPosix.split('/'))
      let alreadySynced = false
      try {
        const destStat = await fsp.stat(destFullPath)
        if (destStat.isFile() && destStat.size === track.fileSize) {
          alreadySynced = true
        }
      } catch {
        alreadySynced = false
      }

      if (alreadySynced) {
        skippedCount++
        skippedBytes += track.fileSize
      } else {
        toCopy.push({
          libraryTrackId: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          sourcePath: track.filePath,
          destRelativePath: relPosix,
          destFullPath,
          fileSize: track.fileSize,
          action: 'copy'
        })
        toCopyBytes += track.fileSize
      }
    }

    const toRemoveRelativePaths: string[] = []
    if (profile.mirrorDeletions && fs.existsSync(profile.targetPath)) {
      const manifest = await this.readManifest(profile.targetPath)
      if (manifest && Array.isArray(manifest.syncedRelativePaths)) {
        for (const oldRel of manifest.syncedRelativePaths) {
          if (!desiredRelPaths.has(oldRel)) {
            const fullOld = path.join(profile.targetPath, ...oldRel.split('/'))
            if (fs.existsSync(fullOld)) {
              toRemoveRelativePaths.push(oldRel)
            }
          }
        }
      }
    }

    const insufficientSpace = freeBytes !== undefined && toCopyBytes > freeBytes
    return {
      profileId,
      targetPath: profile.targetPath,
      targetAvailable: true,
      freeBytes,
      totalBytes,
      toCopy,
      skippedCount,
      skippedBytes,
      toCopyBytes,
      totalSelectedCount: tracks.length,
      toRemoveRelativePaths,
      playlistsToExport: playlistsToExport.length,
      insufficientSpace,
      warning: insufficientSpace
        ? 'Not enough free disk space on the target drive for all selected songs.'
        : undefined
    }
  }

  public cancelSync(): void {
    if (this.progress.active) {
      this.cancelRequested = true
    }
  }

  public async startSync(profileId: string): Promise<void> {
    if (this.progress.active) {
      throw new Error('A DAP sync operation is already running.')
    }

    const profile = this.getProfiles().find((p) => p.id === profileId)
    if (!profile) throw new Error('DAP Sync profile not found')

    this.cancelRequested = false
    this.emitProgress({
      active: true,
      profileId,
      stage: 'scanning',
      completedFiles: 0,
      totalFiles: 0,
      copiedBytes: 0,
      totalBytes: 0
    })

    try {
      const plan = await this.computeSyncPlan(profileId)
      if (!plan.targetAvailable) {
        throw new Error(plan.warning || 'Target directory is not accessible.')
      }
      if (plan.insufficientSpace) {
        throw new Error('Insufficient free space on target drive.')
      }

      await fsp.mkdir(profile.targetPath, { recursive: true })

      let completedFiles = 0
      let copiedBytes = 0
      const totalFiles = plan.toCopy.length
      const totalBytes = plan.toCopyBytes

      this.emitProgress({
        active: true,
        profileId,
        stage: 'copying',
        completedFiles,
        totalFiles,
        copiedBytes,
        totalBytes
      })

      for (const item of plan.toCopy) {
        if (this.cancelRequested) {
          this.emitProgress({
            active: false,
            profileId,
            stage: 'cancelled',
            completedFiles,
            totalFiles,
            copiedBytes,
            totalBytes
          })
          return
        }

        this.emitProgress({
          active: true,
          profileId,
          stage: 'copying',
          completedFiles,
          totalFiles,
          copiedBytes,
          totalBytes,
          currentTrackTitle: `${item.artist} - ${item.title}`
        })

        await this.copyFileWithProgress(item.sourcePath, item.destFullPath, (deltaBytes) => {
          copiedBytes += deltaBytes
          this.emitProgress({
            active: true,
            profileId,
            stage: 'copying',
            completedFiles,
            totalFiles,
            copiedBytes: Math.min(totalBytes, copiedBytes),
            totalBytes,
            currentTrackTitle: `${item.artist} - ${item.title}`
          })
        })

        completedFiles++
      }

      // Build complete synced relative path list for manifest & M3U8 export
      const { tracks, playlistsToExport } = this.resolveSelectedTracks(profile)
      const relPathByTrackId = new Map<string, string>()
      for (const t of tracks) {
        const ext = path.extname(t.filePath) || `.${t.format.toLowerCase()}`
        const relPosix = buildRelativeMusicPath(
          {
            artist: t.artist,
            album: t.album,
            title: t.title,
            trackNumber: t.trackNumber,
            isSingle: t.isSingle
          },
          ext,
          profile.folderTemplate
        )
        relPathByTrackId.set(t.id, relPosix)
      }

      // Mirror cleanup (only files tracked by our manifest)
      let removedFiles = 0
      if (profile.mirrorDeletions && plan.toRemoveRelativePaths.length > 0) {
        this.emitProgress({
          active: true,
          profileId,
          stage: 'cleaning',
          completedFiles,
          totalFiles,
          copiedBytes,
          totalBytes
        })

        for (const rel of plan.toRemoveRelativePaths) {
          const targetFile = path.join(profile.targetPath, ...rel.split('/'))
          await fsp.unlink(targetFile).catch(() => {})
          removedFiles++
          await this.pruneEmptyDirsUpward(path.dirname(targetFile), profile.targetPath)
        }
      }

      // Export M3U8 playlists
      let exportedPlaylists = 0
      if (profile.exportM3u8 && playlistsToExport.length > 0) {
        this.emitProgress({
          active: true,
          profileId,
          stage: 'playlists',
          completedFiles,
          totalFiles,
          copiedBytes,
          totalBytes
        })

        const playlistsDir = path.join(profile.targetPath, 'Playlists')
        await fsp.mkdir(playlistsDir, { recursive: true })

        for (const pl of playlistsToExport) {
          const lines = ['#EXTM3U']
          for (const tid of pl.trackIds) {
            const rel = relPathByTrackId.get(tid)
            if (rel) {
              const track = this.libraryService.getTrackById(tid)
              if (track) {
                lines.push(`#EXTINF:${track.durationSec || -1},${track.artist} - ${track.title}`)
              }
              lines.push(`../${rel}`)
            }
          }
          if (lines.length > 1) {
            const m3uName = `${sanitizePathSegment(pl.name, 'Playlist')}.m3u8`
            await fsp.writeFile(path.join(playlistsDir, m3uName), lines.join('\n') + '\n', 'utf-8')
            exportedPlaylists++
          }
        }
      }

      // Save updated manifest on target directory
      const prevManifest = await this.readManifest(profile.targetPath)
      const nextManifestPaths = profile.mirrorDeletions
        ? [...relPathByTrackId.values()]
        : [...new Set([...(prevManifest?.syncedRelativePaths || []), ...relPathByTrackId.values()])]

      const manifest: DapManifest = {
        version: 1,
        updatedAt: new Date().toISOString(),
        syncedRelativePaths: nextManifestPaths
      }
      await fsp.writeFile(
        path.join(profile.targetPath, MANIFEST_FILENAME),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      )

      // Record lastSyncedAt on profile
      await this.saveProfile({ ...profile, lastSyncedAt: new Date().toISOString() })

      this.emitProgress({
        active: false,
        profileId,
        stage: 'completed',
        completedFiles,
        totalFiles,
        copiedBytes: totalBytes,
        totalBytes,
        removedFiles,
        exportedPlaylists
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitProgress({
        ...this.progress,
        active: false,
        profileId,
        stage: 'failed',
        error: msg
      })
      throw err
    }
  }

  private async copyFileWithProgress(
    src: string,
    dest: string,
    onChunkBytes: (bytes: number) => void
  ): Promise<void> {
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const partPath = `${dest}.part`

    await new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(src, { highWaterMark: 256 * 1024 })
      const writeStream = fs.createWriteStream(partPath)

      let lastEmit = 0
      let pendingBytes = 0

      readStream.on('data', (chunk: string | Buffer) => {
        if (this.cancelRequested) {
          readStream.destroy()
          writeStream.destroy()
          fs.unlink(partPath, () => {})
          resolve()
          return
        }
        pendingBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        const now = Date.now()
        if (now - lastEmit > 80) {
          onChunkBytes(pendingBytes)
          pendingBytes = 0
          lastEmit = now
        }
      })

      readStream.on('error', (err) => {
        fs.unlink(partPath, () => {})
        reject(err)
      })
      writeStream.on('error', (err) => {
        fs.unlink(partPath, () => {})
        reject(err)
      })
      writeStream.on('finish', async () => {
        if (this.cancelRequested) {
          fs.unlink(partPath, () => {})
          resolve()
          return
        }
        if (pendingBytes > 0) onChunkBytes(pendingBytes)
        try {
          if (fs.existsSync(dest)) {
            await fsp.unlink(dest)
          }
          await fsp.rename(partPath, dest)
          resolve()
        } catch (e) {
          reject(e)
        }
      })

      readStream.pipe(writeStream)
    })
  }

  private async pruneEmptyDirsUpward(dir: string, stopAtRoot: string): Promise<void> {
    const resolvedStop = path.resolve(stopAtRoot).toLowerCase()
    let current = path.resolve(dir)
    while (current.toLowerCase() !== resolvedStop && current.toLowerCase().startsWith(resolvedStop)) {
      try {
        const items = await fsp.readdir(current)
        if (items.length === 0) {
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
}

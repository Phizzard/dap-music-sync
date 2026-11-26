import { app } from 'electron'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import type {
  AppSettings,
  DapProfile,
  DownloadJob,
  LibraryPlaylist,
  LibraryTrack
} from '@shared/types'

interface PersistedState {
  settings: AppSettings
  tracks: LibraryTrack[]
  playlists: LibraryPlaylist[]
  dapProfiles: DapProfile[]
  downloadJobs: DownloadJob[]
}

export class StoreService {
  private storePath: string
  private state: PersistedState
  private writeTimer: NodeJS.Timeout | null = null
  private writingPromise: Promise<void> = Promise.resolve()

  constructor() {
    const userData = app.getPath('userData')
    this.storePath = path.join(userData, 'dap-music-sync-store.json')

    const defaultLibraryRoot = path.join(app.getPath('music'), 'DAP Music Sync Library')
    const defaultSettings: AppSettings = {
      libraryRootPath: defaultLibraryRoot,
      defaultFormat: 'flac',
      defaultQuality: 'best',
      squareCoverArt: true,
      maxConcurrentDownloads: 2,
      folderStructure: 'artist-album'
    }

    this.state = {
      settings: defaultSettings,
      tracks: [],
      playlists: [],
      dapProfiles: [],
      downloadJobs: []
    }

    this.loadSync(defaultSettings)
  }

  private loadSync(defaultSettings: AppSettings): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<PersistedState>
        this.state = {
          settings: { ...defaultSettings, ...(parsed.settings || {}) },
          tracks: Array.isArray(parsed.tracks) ? parsed.tracks : [],
          playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
          dapProfiles: Array.isArray(parsed.dapProfiles) ? parsed.dapProfiles : [],
          downloadJobs: Array.isArray(parsed.downloadJobs)
            ? parsed.downloadJobs.map((j) =>
                j.stage === 'downloading' || j.stage === 'processing' || j.stage === 'queued'
                  ? { ...j, stage: 'cancelled', error: 'Interrupted when app closed' }
                  : j
              )
            : []
        }
      }
      fs.mkdirSync(this.state.settings.libraryRootPath, { recursive: true })
    } catch (err) {
      console.error('Failed to load store, starting with defaults:', err)
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }
    this.writeTimer = setTimeout(() => {
      this.flush()
    }, 150)
  }

  public flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const snapshot = JSON.stringify(this.state, null, 2)
    this.writingPromise = this.writingPromise
      .then(async () => {
        const dir = path.dirname(this.storePath)
        await fsp.mkdir(dir, { recursive: true })
        const tmpPath = `${this.storePath}.tmp`
        await fsp.writeFile(tmpPath, snapshot, 'utf-8')
        await fsp.rename(tmpPath, this.storePath)
      })
      .catch((err) => {
        console.error('Failed to persist store:', err)
      })
    return this.writingPromise
  }

  public getSettings(): AppSettings {
    return { ...this.state.settings }
  }

  public async updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    this.state.settings = { ...this.state.settings, ...partial }
    if (partial.libraryRootPath) {
      await fsp.mkdir(this.state.settings.libraryRootPath, { recursive: true })
    }
    await this.flush()
    return this.getSettings()
  }

  public getTracks(): LibraryTrack[] {
    return this.state.tracks
  }

  public setTracks(tracks: LibraryTrack[]): void {
    this.state.tracks = tracks
    this.scheduleSave()
  }

  public getPlaylists(): LibraryPlaylist[] {
    return this.state.playlists
  }

  public setPlaylists(playlists: LibraryPlaylist[]): void {
    this.state.playlists = playlists
    this.scheduleSave()
  }

  public getDapProfiles(): DapProfile[] {
    return this.state.dapProfiles
  }

  public setDapProfiles(profiles: DapProfile[]): void {
    this.state.dapProfiles = profiles
    this.scheduleSave()
  }

  public getDownloadJobs(): DownloadJob[] {
    return this.state.downloadJobs
  }

  public setDownloadJobs(jobs: DownloadJob[]): void {
    // Keep most recent 250 jobs to bound JSON size
    this.state.downloadJobs = jobs.slice(0, 250)
    this.scheduleSave()
  }
}

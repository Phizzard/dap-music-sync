import { create } from 'zustand'
import type {
  AppSettings,
  AppUpdateStatus,
  AudioFormat,
  AudioQuality,
  BinaryInstallProgress,
  BinaryStatus,
  DapProfile,
  DownloadJob,
  DownloadRequest,
  LibraryPlaylist,
  LibraryTrack,
  PlayableItem,
  RemoteTrack,
  SyncProgress
} from '@shared/types'

export type NavTab = 'discover' | 'library' | 'dap' | 'downloads' | 'settings'

export interface ToastMessage {
  id: string
  text: string
  tone: 'info' | 'success' | 'error'
}

interface AppState {
  activeTab: NavTab
  setActiveTab: (tab: NavTab) => void

  settings: AppSettings | null
  streamBaseUrl: string
  appUpdateStatus: AppUpdateStatus | null
  binaryStatus: BinaryStatus | null
  binaryProgress: BinaryInstallProgress | null
  tracks: LibraryTrack[]
  playlists: LibraryPlaylist[]
  downloadJobs: DownloadJob[]
  dapProfiles: DapProfile[]
  syncProgress: SyncProgress

  // Quick override format in Discover
  quickFormat: AudioFormat
  quickQuality: AudioQuality
  setQuickFormat: (fmt: AudioFormat) => void
  setQuickQuality: (q: AudioQuality) => void

  // Player state
  currentTrack: PlayableItem | null
  playbackQueue: PlayableItem[]
  queueIndex: number
  isPlaying: boolean
  isBuffering: boolean
  playerError: string | null

  // Toasts
  toasts: ToastMessage[]
  pushToast: (text: string, tone?: 'info' | 'success' | 'error') => void
  dismissToast: (id: string) => void

  // Bootstrap & actions
  initialize: () => Promise<void>
  refreshBinaries: () => Promise<void>
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>
  playItem: (item: PlayableItem, queue?: PlayableItem[]) => void
  setIsPlaying: (playing: boolean) => void
  setIsBuffering: (buffering: boolean) => void
  setPlayerError: (err: string | null) => void
  playNext: () => void
  playPrev: () => void

  enqueueRemoteTracks: (
    tracks: RemoteTrack[],
    opts?: { targetPlaylistName?: string; format?: AudioFormat; quality?: AudioQuality }
  ) => Promise<void>
  refreshDapProfiles: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  activeTab: 'discover',
  setActiveTab: (tab) => set({ activeTab: tab }),

  settings: null,
  streamBaseUrl: '',
  appUpdateStatus: null,
  binaryStatus: null,
  binaryProgress: null,
  tracks: [],
  playlists: [],
  downloadJobs: [],
  dapProfiles: [],
  syncProgress: {
    active: false,
    stage: 'idle',
    completedFiles: 0,
    totalFiles: 0,
    copiedBytes: 0,
    totalBytes: 0
  },

  quickFormat: 'flac',
  quickQuality: 'best',
  setQuickFormat: (fmt) => set({ quickFormat: fmt }),
  setQuickQuality: (q) => set({ quickQuality: q }),

  currentTrack: null,
  playbackQueue: [],
  queueIndex: -1,
  isPlaying: false,
  isBuffering: false,
  playerError: null,

  toasts: [],
  pushToast: (text, tone = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 4000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  initialize: async () => {
    const [
      settings,
      streamBaseUrl,
      appUpdateStatus,
      binaryStatus,
      lib,
      jobs,
      profiles,
      syncProg
    ] = await Promise.all([
      window.api.getSettings(),
      window.api.getStreamBaseUrl(),
      window.api.getAppUpdateStatus(),
      window.api.getBinaryStatus(),
      window.api.getLibrary(),
      window.api.getDownloadQueue(),
      window.api.getDapProfiles(),
      window.api.getSyncProgress()
    ])

    set({
      settings,
      streamBaseUrl,
      appUpdateStatus,
      quickFormat: settings.defaultFormat,
      quickQuality: settings.defaultQuality,
      binaryStatus,
      tracks: lib.tracks,
      playlists: lib.playlists,
      downloadJobs: jobs,
      dapProfiles: profiles,
      syncProgress: syncProg
    })

    window.api.onAppUpdateStatus((nextStatus) => {
      set({ appUpdateStatus: nextStatus })
    })

    window.api.onBinaryProgress((progress) => {
      set({ binaryProgress: progress.active ? progress : null })
    })
    window.api.onDownloadQueueUpdated((updatedJobs) => {
      const prevJobs = get().downloadJobs
      for (const nextJob of updatedJobs) {
        const prev = prevJobs.find((p) => p.id === nextJob.id)
        if (prev && prev.stage !== nextJob.stage) {
          if (nextJob.stage === 'completed') {
            get().pushToast(`Saved "${nextJob.title}" to Library`, 'success')
          } else if (nextJob.stage === 'failed') {
            get().pushToast(`Download failed: ${nextJob.error || nextJob.title}`, 'error')
          }
        }
      }
      set({ downloadJobs: updatedJobs })
    })
    window.api.onLibraryUpdated((updatedLib) => {
      set({ tracks: updatedLib.tracks, playlists: updatedLib.playlists })
    })
    window.api.onSyncProgress((prog) => {
      set({ syncProgress: prog })
    })
  },

  refreshBinaries: async () => {
    const binaryStatus = await window.api.getBinaryStatus()
    set({ binaryStatus })
  },

  updateSettings: async (partial) => {
    const updated = await window.api.updateSettings(partial)
    set({
      settings: updated,
      quickFormat: partial.defaultFormat ?? get().quickFormat,
      quickQuality: partial.defaultQuality ?? get().quickQuality
    })
  },

  playItem: (item, queue) => {
    const nextQueue = queue && queue.length > 0 ? queue : [item]
    const idx = Math.max(
      0,
      nextQueue.findIndex((q) => q.id === item.id)
    )
    set({
      currentTrack: item,
      playbackQueue: nextQueue,
      queueIndex: idx,
      isPlaying: true,
      isBuffering: true,
      playerError: null
    })
  },

  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setIsBuffering: (buffering) => set({ isBuffering: buffering }),
  setPlayerError: (err) => set({ playerError: err }),

  playNext: () => {
    const { playbackQueue, queueIndex } = get()
    if (playbackQueue.length === 0) return
    const nextIdx = queueIndex + 1
    if (nextIdx < playbackQueue.length) {
      set({
        currentTrack: playbackQueue[nextIdx],
        queueIndex: nextIdx,
        isPlaying: true,
        isBuffering: true,
        playerError: null
      })
    } else {
      set({ isPlaying: false })
    }
  },

  playPrev: () => {
    const { playbackQueue, queueIndex } = get()
    if (playbackQueue.length === 0) return
    const prevIdx = Math.max(0, queueIndex - 1)
    set({
      currentTrack: playbackQueue[prevIdx],
      queueIndex: prevIdx,
      isPlaying: true,
      isBuffering: true,
      playerError: null
    })
  },

  enqueueRemoteTracks: async (tracks, opts) => {
    if (tracks.length === 0) return
    const { quickFormat, quickQuality, pushToast } = get()
    const format = opts?.format || quickFormat
    const quality = opts?.quality || quickQuality

    const requests: DownloadRequest[] = tracks.map((t) => ({
      videoId: t.videoId,
      url: t.url,
      title: t.title,
      artist: t.artist,
      album: t.album,
      albumId: t.albumId,
      trackNumber: t.trackNumber,
      thumbnailUrl: t.thumbnailUrl,
      format,
      quality,
      targetPlaylistName: opts?.targetPlaylistName
    }))

    await window.api.enqueueDownloads(requests)
    pushToast(
      tracks.length === 1
        ? `Downloading "${tracks[0].title}" (${format.toUpperCase()})`
        : `Queued ${tracks.length} tracks (${format.toUpperCase()})`,
      'success'
    )
  },

  refreshDapProfiles: async () => {
    const dapProfiles = await window.api.getDapProfiles()
    set({ dapProfiles })
  }
}))

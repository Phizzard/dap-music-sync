export type AudioFormat = 'flac' | 'mp3' | 'm4a' | 'opus'
export type AudioQuality = 'best' | '320k' | '256k' | '192k'
export type FolderStructure = 'artist-album' | 'artist' | 'flat'
export type SearchFilter = 'all' | 'songs' | 'albums' | 'playlists'
export type CookiesBrowser = 'none' | 'chrome' | 'safari' | 'firefox' | 'edge' | 'brave' | 'opera' | 'vivaldi'

export interface RemoteTrack {
  videoId: string
  url: string
  title: string
  artist: string
  album?: string
  albumId?: string
  trackNumber?: number
  durationSec?: number
  durationText?: string
  thumbnailUrl?: string
  inLibrary?: boolean
  libraryTrackId?: string
}

export interface RemoteCollection {
  id: string
  url: string
  type: 'album' | 'playlist'
  title: string
  author?: string
  year?: string
  trackCount?: number
  thumbnailUrl?: string
  tracks?: RemoteTrack[]
}

export interface SearchResults {
  query: string
  songs: RemoteTrack[]
  albums: RemoteCollection[]
  playlists: RemoteCollection[]
  source: 'ytmusic' | 'ytdlp'
}

export interface ResolvedUrlResult {
  kind: 'track' | 'collection'
  track?: RemoteTrack
  collection?: RemoteCollection
}

export type DownloadStage =
  | 'queued'
  | 'downloading'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface DownloadRequest {
  videoId: string
  url: string
  title: string
  artist: string
  album?: string
  albumId?: string
  trackNumber?: number
  thumbnailUrl?: string
  format?: AudioFormat
  quality?: AudioQuality
  targetPlaylistName?: string
}

export interface DownloadJob {
  id: string
  videoId: string
  sourceUrl: string
  title: string
  artist: string
  album?: string
  albumId?: string
  trackNumber?: number
  thumbnailUrl?: string
  format: AudioFormat
  quality: AudioQuality
  stage: DownloadStage
  progress: number
  speed?: string
  eta?: string
  error?: string
  outputPath?: string
  libraryTrackId?: string
  targetPlaylistName?: string
  createdAt: string
  completedAt?: string
}

export interface LibraryTrack {
  id: string
  sourceVideoId?: string
  sourceUrl?: string
  title: string
  artist: string
  album: string
  isSingle?: boolean
  trackNumber?: number
  year?: number
  durationSec: number
  format: string
  bitrateKbps?: number
  sampleRate?: number
  fileSize: number
  filePath: string
  relativePath: string
  coverArtDataUrl?: string
  thumbnailUrl?: string
  addedAt: string
  missingOnDisk?: boolean
}

export interface LibraryPlaylist {
  id: string
  name: string
  description?: string
  trackIds: string[]
  createdAt: string
  updatedAt: string
}

export type DapSyncMode = 'all' | 'selected'

export interface DapProfile {
  id: string
  name: string
  targetPath: string
  syncMode: DapSyncMode
  selectedTrackIds: string[]
  selectedAlbums: string[] // key: `${artist}|||${album}`
  selectedPlaylistIds: string[]
  folderTemplate: FolderStructure
  exportM3u8: boolean
  mirrorDeletions: boolean
  lastSyncedAt?: string
}

export interface SyncPlanItem {
  libraryTrackId: string
  title: string
  artist: string
  album: string
  sourcePath: string
  destRelativePath: string
  destFullPath: string
  fileSize: number
  action: 'copy' | 'skip'
}

export interface SyncPlan {
  profileId: string
  targetPath: string
  targetAvailable: boolean
  freeBytes?: number
  totalBytes?: number
  toCopy: SyncPlanItem[]
  skippedCount: number
  skippedBytes: number
  toCopyBytes: number
  totalSelectedCount: number
  toRemoveRelativePaths: string[]
  playlistsToExport: number
  insufficientSpace: boolean
  warning?: string
}

export interface SyncProgress {
  active: boolean
  profileId?: string
  stage:
    | 'idle'
    | 'scanning'
    | 'copying'
    | 'playlists'
    | 'cleaning'
    | 'completed'
    | 'failed'
    | 'cancelled'
  completedFiles: number
  totalFiles: number
  copiedBytes: number
  totalBytes: number
  currentTrackTitle?: string
  removedFiles?: number
  exportedPlaylists?: number
  error?: string
}

export interface BinaryInfo {
  name: 'yt-dlp' | 'ffmpeg'
  found: boolean
  path?: string
  version?: string
  source: 'custom' | 'system' | 'managed' | 'missing'
}

export interface BinaryStatus {
  ytdlp: BinaryInfo
  ffmpeg: BinaryInfo
  ready: boolean
}

export interface BinaryInstallProgress {
  active: boolean
  binary?: 'yt-dlp' | 'ffmpeg'
  message: string
  percent?: number
  error?: string
}

export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface AppUpdateStatus {
  currentVersion: string
  isPackaged: boolean
  stage: UpdateStage
  latestVersion?: string
  releaseNotes?: string
  releaseUrl?: string
  macDmgUrl?: string
  downloadPercent?: number
  downloadedFilePath?: string
  message?: string
  error?: string
}

export interface AppSettings {
  libraryRootPath: string
  defaultFormat: AudioFormat
  defaultQuality: AudioQuality
  squareCoverArt: boolean
  maxConcurrentDownloads: number
  folderStructure: FolderStructure
  cookiesBrowser?: CookiesBrowser
  customYtdlpPath?: string
  customFfmpegPath?: string
}

export interface PlayableItem {
  id: string
  title: string
  artist: string
  album?: string
  thumbnailUrl?: string
  durationSec?: number
  source: 'remote' | 'local'
  videoId?: string
  remoteUrl?: string
  libraryTrackId?: string
  streamUri: string
}

export interface ElectronApi {
  // Settings & System
  getSettings: () => Promise<AppSettings>
  updateSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>
  pickDirectory: (title?: string, defaultPath?: string) => Promise<string | null>
  pickBinaryFile: (title?: string) => Promise<string | null>
  showItemInFolder: (filePath: string) => Promise<void>
  openPath: (folderPath: string) => Promise<void>

  // Binaries
  getBinaryStatus: () => Promise<BinaryStatus>
  installMissingBinaries: () => Promise<BinaryStatus>
  updateYtdlp: () => Promise<{ updated: boolean; output: string; status: BinaryStatus }>
  onBinaryProgress: (cb: (progress: BinaryInstallProgress) => void) => () => void

  // App Auto-Updater
  getAppUpdateStatus: () => Promise<AppUpdateStatus>
  checkForAppUpdates: () => Promise<AppUpdateStatus>
  downloadAppUpdate: () => Promise<AppUpdateStatus>
  installAppUpdate: () => Promise<void>
  onAppUpdateStatus: (cb: (status: AppUpdateStatus) => void) => () => void

  // Search & URL
  getStreamBaseUrl: () => Promise<string>
  searchMusic: (query: string) => Promise<SearchResults>
  resolveUrl: (url: string) => Promise<ResolvedUrlResult>
  resolveCollection: (collection: RemoteCollection) => Promise<RemoteCollection>
  warmPreviewStream: (
    videoId: string
  ) => Promise<{ ready: boolean; streamUrl?: string; durationSec?: number; error?: string }>

  // Downloads
  getDownloadQueue: () => Promise<DownloadJob[]>
  enqueueDownloads: (items: DownloadRequest[]) => Promise<DownloadJob[]>
  cancelDownload: (jobId: string) => Promise<void>
  retryDownload: (jobId: string) => Promise<void>
  clearFinishedDownloads: () => Promise<DownloadJob[]>
  onDownloadQueueUpdated: (cb: (jobs: DownloadJob[]) => void) => () => void

  // Local Library
  getLibrary: () => Promise<{ tracks: LibraryTrack[]; playlists: LibraryPlaylist[] }>
  reorganizeLibrary: () => Promise<{ moved: number }>
  scanLibraryFolder: (externalFolderPath?: string) => Promise<{ added: number; updated: number; missing: number }>
  deleteLibraryTrack: (trackId: string, deleteFromDisk: boolean) => Promise<void>
  updateLibraryTrackMeta: (
    trackId: string,
    patch: Partial<Pick<LibraryTrack, 'title' | 'artist' | 'album' | 'trackNumber'>>
  ) => Promise<LibraryTrack>
  createPlaylist: (name: string, description?: string) => Promise<LibraryPlaylist>
  renamePlaylist: (playlistId: string, name: string, description?: string) => Promise<LibraryPlaylist>
  deletePlaylist: (playlistId: string) => Promise<void>
  addTracksToPlaylist: (playlistId: string, trackIds: string[]) => Promise<LibraryPlaylist>
  removeTrackFromPlaylist: (playlistId: string, trackId: string) => Promise<LibraryPlaylist>
  onLibraryUpdated: (cb: (payload: { tracks: LibraryTrack[]; playlists: LibraryPlaylist[] }) => void) => () => void

  // DAP Sync
  getDapProfiles: () => Promise<DapProfile[]>
  saveDapProfile: (profile: Omit<DapProfile, 'id'> & { id?: string }) => Promise<DapProfile>
  deleteDapProfile: (profileId: string) => Promise<void>
  computeSyncPlan: (profileId: string) => Promise<SyncPlan>
  startDapSync: (profileId: string) => Promise<void>
  cancelDapSync: () => Promise<void>
  getSyncProgress: () => Promise<SyncProgress>
  onSyncProgress: (cb: (progress: SyncProgress) => void) => () => void
}

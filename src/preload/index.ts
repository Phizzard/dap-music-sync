import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  AppUpdateStatus,
  BinaryInstallProgress,
  DapProfile,
  DownloadJob,
  DownloadRequest,
  ElectronApi,
  LibraryPlaylist,
  LibraryTrack,
  RemoteCollection,
  SyncProgress
} from '@shared/types'

const api: ElectronApi = {
  // Settings & System
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', partial),
  pickDirectory: (title?: string, defaultPath?: string) =>
    ipcRenderer.invoke('dialog:pickDirectory', title, defaultPath),
  pickBinaryFile: (title?: string) => ipcRenderer.invoke('dialog:pickBinaryFile', title),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  openPath: (folderPath: string) => ipcRenderer.invoke('shell:openPath', folderPath),

  // Binaries
  getBinaryStatus: () => ipcRenderer.invoke('binaries:status'),
  installMissingBinaries: () => ipcRenderer.invoke('binaries:install'),
  updateYtdlp: () => ipcRenderer.invoke('binaries:updateYtdlp'),
  onBinaryProgress: (cb: (progress: BinaryInstallProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: BinaryInstallProgress) => cb(progress)
    ipcRenderer.on('binaries:progress', listener)
    return () => ipcRenderer.removeListener('binaries:progress', listener)
  },

  // App Auto-Updater
  getAppUpdateStatus: () => ipcRenderer.invoke('updater:status'),
  checkForAppUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadAppUpdate: () => ipcRenderer.invoke('updater:download'),
  installAppUpdate: () => ipcRenderer.invoke('updater:install'),
  onAppUpdateStatus: (cb: (status: AppUpdateStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AppUpdateStatus) => cb(status)
    ipcRenderer.on('updater:statusChanged', listener)
    return () => ipcRenderer.removeListener('updater:statusChanged', listener)
  },

  // Search & URL
  getStreamBaseUrl: () => ipcRenderer.invoke('stream:baseUrl'),
  searchMusic: (query: string) => ipcRenderer.invoke('music:search', query),
  resolveUrl: (url: string) => ipcRenderer.invoke('music:resolveUrl', url),
  resolveCollection: (collection: RemoteCollection) =>
    ipcRenderer.invoke('music:resolveCollection', collection),
  warmPreviewStream: (videoId: string) => ipcRenderer.invoke('stream:warm', videoId),

  // Downloads
  getDownloadQueue: () => ipcRenderer.invoke('downloads:getQueue'),
  enqueueDownloads: (items: DownloadRequest[]) => ipcRenderer.invoke('downloads:enqueue', items),
  cancelDownload: (jobId: string) => ipcRenderer.invoke('downloads:cancel', jobId),
  retryDownload: (jobId: string) => ipcRenderer.invoke('downloads:retry', jobId),
  clearFinishedDownloads: () => ipcRenderer.invoke('downloads:clearFinished'),
  onDownloadQueueUpdated: (cb: (jobs: DownloadJob[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, jobs: DownloadJob[]) => cb(jobs)
    ipcRenderer.on('downloads:updated', listener)
    return () => ipcRenderer.removeListener('downloads:updated', listener)
  },

  // Local Library
  getLibrary: () => ipcRenderer.invoke('library:get'),
  reorganizeLibrary: () => ipcRenderer.invoke('library:reorganize'),
  scanLibraryFolder: (externalFolderPath?: string) =>
    ipcRenderer.invoke('library:scan', externalFolderPath),
  deleteLibraryTrack: (trackId: string, deleteFromDisk: boolean) =>
    ipcRenderer.invoke('library:deleteTrack', trackId, deleteFromDisk),
  updateLibraryTrackMeta: (
    trackId: string,
    patch: Partial<Pick<LibraryTrack, 'title' | 'artist' | 'album' | 'trackNumber'>>
  ) => ipcRenderer.invoke('library:updateTrackMeta', trackId, patch),
  createPlaylist: (name: string, description?: string) =>
    ipcRenderer.invoke('library:createPlaylist', name, description),
  renamePlaylist: (playlistId: string, name: string, description?: string) =>
    ipcRenderer.invoke('library:renamePlaylist', playlistId, name, description),
  deletePlaylist: (playlistId: string) => ipcRenderer.invoke('library:deletePlaylist', playlistId),
  addTracksToPlaylist: (playlistId: string, trackIds: string[]) =>
    ipcRenderer.invoke('library:addTracksToPlaylist', playlistId, trackIds),
  removeTrackFromPlaylist: (playlistId: string, trackId: string) =>
    ipcRenderer.invoke('library:removeTrackFromPlaylist', playlistId, trackId),
  onLibraryUpdated: (cb: (payload: { tracks: LibraryTrack[]; playlists: LibraryPlaylist[] }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { tracks: LibraryTrack[]; playlists: LibraryPlaylist[] }
    ) => cb(payload)
    ipcRenderer.on('library:updated', listener)
    return () => ipcRenderer.removeListener('library:updated', listener)
  },

  // DAP Sync
  getDapProfiles: () => ipcRenderer.invoke('dap:getProfiles'),
  saveDapProfile: (profile: Omit<DapProfile, 'id'> & { id?: string }) =>
    ipcRenderer.invoke('dap:saveProfile', profile),
  deleteDapProfile: (profileId: string) => ipcRenderer.invoke('dap:deleteProfile', profileId),
  computeSyncPlan: (profileId: string) => ipcRenderer.invoke('dap:computePlan', profileId),
  startDapSync: (profileId: string) => ipcRenderer.invoke('dap:startSync', profileId),
  cancelDapSync: () => ipcRenderer.invoke('dap:cancelSync'),
  getSyncProgress: () => ipcRenderer.invoke('dap:getProgress'),
  onSyncProgress: (cb: (progress: SyncProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SyncProgress) => cb(progress)
    ipcRenderer.on('dap:progress', listener)
    return () => ipcRenderer.removeListener('dap:progress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

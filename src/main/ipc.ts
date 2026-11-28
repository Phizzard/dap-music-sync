import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AppSettings,
  DapProfile,
  DownloadRequest,
  LibraryTrack,
  RemoteCollection
} from '@shared/types'
import type { BinaryManager } from './services/binaryManager'
import type { DapSyncService } from './services/dapSyncService'
import type { DownloadQueueService } from './services/downloadQueue'
import type { LibraryService } from './services/libraryService'
import type { SearchService } from './services/searchService'
import type { StoreService } from './services/storeService'
import type { StreamService } from './services/streamService'
import type { UpdaterService } from './services/updaterService'
import type { UrlResolverService } from './services/urlResolver'

export function registerIpcHandlers(services: {
  store: StoreService
  binaryManager: BinaryManager
  libraryService: LibraryService
  searchService: SearchService
  urlResolver: UrlResolverService
  streamService: StreamService
  downloadQueue: DownloadQueueService
  dapSync: DapSyncService
  updater: UpdaterService
}): void {
  const {
    store,
    binaryManager,
    libraryService,
    searchService,
    urlResolver,
    streamService,
    downloadQueue,
    dapSync,
    updater
  } = services

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }

  binaryManager.onProgress((p) => broadcast('binaries:progress', p))
  downloadQueue.onUpdated((jobs) => broadcast('downloads:updated', jobs))
  libraryService.onUpdated((lib) => broadcast('library:updated', lib))
  dapSync.onProgress((p) => broadcast('dap:progress', p))
  updater.onStatusChanged((s) => broadcast('updater:statusChanged', s))

  // Settings & System
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:update', async (_e, partial: Partial<AppSettings>) => {
    const updated = await store.updateSettings(partial)
    if (partial.folderStructure) {
      await libraryService.reorganizeLibrary().catch(() => {})
    }
    return updated
  })

  ipcMain.handle('dialog:pickDirectory', async (event, title?: string, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: title || 'Select Folder',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dialog:pickBinaryFile', async (event, title?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: title || 'Select Executable',
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('shell:showItemInFolder', (_e, filePath: string) => {
    if (filePath) shell.showItemInFolder(filePath)
  })

  ipcMain.handle('shell:openPath', async (_e, folderPath: string) => {
    if (folderPath) await shell.openPath(folderPath)
  })

  // Binaries
  ipcMain.handle('binaries:status', () => binaryManager.getStatus(true))
  ipcMain.handle('binaries:install', () => binaryManager.installMissingBinaries())
  ipcMain.handle('binaries:updateYtdlp', () => binaryManager.updateYtdlp())

  // App Auto-Updater
  ipcMain.handle('updater:status', () => updater.getStatus())
  ipcMain.handle('updater:check', () => updater.checkForUpdates())
  ipcMain.handle('updater:download', () => updater.downloadUpdate())
  ipcMain.handle('updater:install', () => updater.quitAndInstall())

  // Search, URL & Stream Warmup
  ipcMain.handle('stream:baseUrl', () => streamService.getBaseUrl())
  ipcMain.handle('music:search', (_e, query: string) => searchService.search(query))
  ipcMain.handle('music:resolveUrl', (_e, url: string) => urlResolver.resolveUrl(url))
  ipcMain.handle('music:resolveCollection', (_e, collection: RemoteCollection) =>
    urlResolver.resolveCollection(collection)
  )
  ipcMain.handle('stream:warm', async (_e, videoId: string) => {
    try {
      const stream = await streamService.resolveRemoteStream(videoId)
      const streamUrl = `${streamService.getBaseUrl()}/remote/${encodeURIComponent(videoId)}`
      return { ready: true, streamUrl, durationSec: stream.durationSec }
    } catch (err: unknown) {
      return { ready: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('stream:prefetch', (_e, videoId: string) =>
    streamService.prefetchRemoteStream(videoId)
  )

  // Downloads
  ipcMain.handle('downloads:getQueue', () => downloadQueue.getQueue())
  ipcMain.handle('downloads:enqueue', (_e, items: DownloadRequest[]) =>
    downloadQueue.enqueue(items)
  )
  ipcMain.handle('downloads:cancel', (_e, jobId: string) => downloadQueue.cancel(jobId))
  ipcMain.handle('downloads:retry', (_e, jobId: string) => downloadQueue.retry(jobId))
  ipcMain.handle('downloads:clearFinished', () => downloadQueue.clearFinished())

  // Library
  ipcMain.handle('library:get', () => libraryService.getLibrary())
  ipcMain.handle('library:reorganize', () => libraryService.reorganizeLibrary())
  ipcMain.handle('library:scan', (_e, externalFolderPath?: string) =>
    libraryService.scanLibraryFolder(externalFolderPath)
  )
  ipcMain.handle('library:deleteTrack', (_e, trackId: string, deleteFromDisk: boolean) =>
    libraryService.deleteTrack(trackId, deleteFromDisk)
  )
  ipcMain.handle(
    'library:updateTrackMeta',
    (
      _e,
      trackId: string,
      patch: Partial<Pick<LibraryTrack, 'title' | 'artist' | 'album' | 'trackNumber'>>
    ) => libraryService.updateTrackMeta(trackId, patch)
  )
  ipcMain.handle('library:createPlaylist', (_e, name: string, description?: string) =>
    libraryService.createPlaylist(name, description)
  )
  ipcMain.handle(
    'library:renamePlaylist',
    (_e, playlistId: string, name: string, description?: string) =>
      libraryService.renamePlaylist(playlistId, name, description)
  )
  ipcMain.handle('library:deletePlaylist', (_e, playlistId: string) =>
    libraryService.deletePlaylist(playlistId)
  )
  ipcMain.handle('library:addTracksToPlaylist', (_e, playlistId: string, trackIds: string[]) =>
    libraryService.addTracksToPlaylist(playlistId, trackIds)
  )
  ipcMain.handle('library:removeTrackFromPlaylist', (_e, playlistId: string, trackId: string) =>
    libraryService.removeTrackFromPlaylist(playlistId, trackId)
  )

  // DAP Sync
  ipcMain.handle('dap:getProfiles', () => dapSync.getProfiles())
  ipcMain.handle('dap:saveProfile', (_e, profile: Omit<DapProfile, 'id'> & { id?: string }) =>
    dapSync.saveProfile(profile)
  )
  ipcMain.handle('dap:deleteProfile', (_e, profileId: string) => dapSync.deleteProfile(profileId))
  ipcMain.handle('dap:computePlan', (_e, profileId: string) => dapSync.computeSyncPlan(profileId))
  ipcMain.handle('dap:startSync', (_e, profileId: string) => dapSync.startSync(profileId))
  ipcMain.handle('dap:cancelSync', () => dapSync.cancelSync())
  ipcMain.handle('dap:getProgress', () => dapSync.getProgress())
}

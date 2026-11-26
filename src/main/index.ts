import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { BinaryManager } from './services/binaryManager'
import { DapSyncService } from './services/dapSyncService'
import { DownloadQueueService } from './services/downloadQueue'
import { LibraryService } from './services/libraryService'
import { SearchService } from './services/searchService'
import { StoreService } from './services/storeService'
import { StreamService } from './services/streamService'
import { UpdaterService } from './services/updaterService'
import { UrlResolverService } from './services/urlResolver'

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: true,
    backgroundColor: '#090b10',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const revealWindow = (): void => {
    if (mainWindow.isDestroyed()) return
    mainWindow.show()
    mainWindow.focus()
    if (process.platform === 'win32') {
      mainWindow.setAlwaysOnTop(true)
      mainWindow.setAlwaysOnTop(false)
    }
  }

  mainWindow.once('ready-to-show', revealWindow)
  mainWindow.webContents.once('did-finish-load', revealWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  revealWindow()

  return mainWindow
}

app.whenReady().then(async () => {
  const store = new StoreService()
  const binaryManager = new BinaryManager(store)
  const libraryService = new LibraryService(store)
  const searchService = new SearchService(binaryManager, libraryService)
  const urlResolver = new UrlResolverService(binaryManager, libraryService, searchService)
  const streamService = new StreamService(binaryManager, libraryService)
  await streamService.start()
  const downloadQueue = new DownloadQueueService(
    store,
    binaryManager,
    libraryService,
    searchService
  )
  const dapSync = new DapSyncService(store, libraryService)
  const updater = new UpdaterService()

  app.on('will-quit', () => {
    streamService.stop()
  })

  registerIpcHandlers({
    store,
    binaryManager,
    libraryService,
    searchService,
    urlResolver,
    streamService,
    downloadQueue,
    dapSync,
    updater
  })

  if (app.isPackaged) {
    setTimeout(() => {
      updater.checkForUpdates().catch(() => {})
    }, 4000)
  }

  // Background reorganize singles/folder structure & check library folder on launch
  libraryService
    .reorganizeLibrary()
    .then(() => libraryService.scanLibraryFolder())
    .catch((err) => {
      console.warn('Initial library scan warning:', err)
    })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

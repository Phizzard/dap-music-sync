import { app, shell } from 'electron'
import electronUpdater from 'electron-updater'
import fs from 'fs'
import https from 'https'
import path from 'path'
import type { AppUpdateStatus } from '@shared/types'

const { autoUpdater } = electronUpdater

export const GITHUB_OWNER = 'Phizzard'
export const GITHUB_REPO = 'cratesync'

function compareSemver(a: string, b: string): number {
  const clean = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0)
  const pa = clean(a)
  const pb = clean(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

interface GithubReleaseResponse {
  tag_name?: string
  html_url?: string
  body?: string
  assets?: Array<{
    name: string
    browser_download_url: string
  }>
}

export class UpdaterService {
  private status: AppUpdateStatus
  private listeners: Array<(status: AppUpdateStatus) => void> = []
  private useNativeAutoUpdater: boolean

  constructor() {
    // Use electron-updater native Squirrel/NSIS engine on packaged Windows/Linux builds;
    // use GitHub Releases direct API fallback on unsigned macOS and unpackaged dev runs.
    this.useNativeAutoUpdater = app.isPackaged && process.platform !== 'darwin'

    this.status = {
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      stage: 'idle'
    }

    if (this.useNativeAutoUpdater) {
      this.configureNativeUpdater()
    }
  }

  public onStatusChanged(cb: (status: AppUpdateStatus) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }

  private emit(patch: Partial<AppUpdateStatus>): AppUpdateStatus {
    this.status = { ...this.status, ...patch }
    for (const cb of this.listeners) {
      cb({ ...this.status })
    }
    return { ...this.status }
  }

  public getStatus(): AppUpdateStatus {
    return { ...this.status }
  }

  private configureNativeUpdater(): void {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      this.emit({ stage: 'checking', error: undefined, message: 'Checking GitHub Releases...' })
    })

    autoUpdater.on('update-available', (info) => {
      const notes =
        typeof info.releaseNotes === 'string'
          ? info.releaseNotes
          : Array.isArray(info.releaseNotes)
            ? info.releaseNotes.map((n) => n.note).join('\n')
            : undefined

      this.emit({
        stage: 'available',
        latestVersion: info.version,
        releaseNotes: notes,
        releaseUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${info.version}`,
        message: `Version ${info.version} is available!`
      })
    })

    autoUpdater.on('update-not-available', (info) => {
      this.emit({
        stage: 'not-available',
        latestVersion: info.version,
        message: `You're on the latest version (v${app.getVersion()}).`
      })
    })

    autoUpdater.on('download-progress', (prog) => {
      this.emit({
        stage: 'downloading',
        downloadPercent: Math.round(prog.percent),
        message: `Downloading update (${Math.round(prog.percent)}%)...`
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.emit({
        stage: 'downloaded',
        latestVersion: info.version,
        downloadPercent: 100,
        message: `Update v${info.version} is ready — restart to install.`
      })
    })

    autoUpdater.on('error', (err) => {
      const raw = err?.message || String(err)
      // Friendly message when repo has no published releases yet
      const noReleasesYet =
        raw.includes('404') ||
        raw.toLowerCase().includes('cannot find latest') ||
        raw.toLowerCase().includes('no published versions')
      if (noReleasesYet) {
        this.emit({
          stage: 'not-available',
          error: undefined,
          message: `You're up to date (v${app.getVersion()}).`
        })
      } else {
        this.emit({
          stage: 'error',
          error: raw,
          message: 'Update check failed.'
        })
      }
    })
  }

  public async checkForUpdates(): Promise<AppUpdateStatus> {
    if (this.useNativeAutoUpdater) {
      try {
        await autoUpdater.checkForUpdates()
      } catch {
        // Handled by error event listener
      }
      return this.getStatus()
    }

    // Fallback: GitHub Releases REST API (used in dev mode and on unsigned macOS builds)
    this.emit({ stage: 'checking', error: undefined, message: 'Checking GitHub Releases...' })
    try {
      const release = await this.fetchLatestGithubRelease()
      if (!release || !release.tag_name) {
        return this.emit({
          stage: 'not-available',
          message: `No releases published yet (running v${app.getVersion()}).`
        })
      }

      const latestVer = release.tag_name.replace(/^v/i, '')
      if (compareSemver(latestVer, app.getVersion()) > 0) {
        const archToken = process.arch === 'arm64' ? 'arm64' : 'x64'
        const assets = release.assets || []
        const dmgAsset =
          assets.find((a) => a.name.endsWith('.dmg') && a.name.includes(archToken)) ||
          assets.find((a) => a.name.endsWith('.dmg'))
        const winAsset = assets.find((a) => a.name.endsWith('.exe'))

        return this.emit({
          stage: 'available',
          latestVersion: latestVer,
          releaseNotes: release.body,
          releaseUrl: release.html_url,
          macDmgUrl: process.platform === 'darwin' ? dmgAsset?.browser_download_url : winAsset?.browser_download_url,
          message: `Version ${latestVer} is available!`
        })
      }

      return this.emit({
        stage: 'not-available',
        latestVersion: latestVer,
        message: `You're on the latest version (v${app.getVersion()}).`
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return this.emit({
        stage: 'error',
        error: msg,
        message: 'Could not reach GitHub Releases.'
      })
    }
  }

  public async downloadUpdate(): Promise<AppUpdateStatus> {
    if (this.useNativeAutoUpdater) {
      this.emit({ stage: 'downloading', downloadPercent: 0, message: 'Starting download...' })
      await autoUpdater.downloadUpdate()
      return this.getStatus()
    }

    // Unsigned macOS / dev mode installer download
    const assetUrl = this.status.macDmgUrl
    if (!assetUrl) {
      if (this.status.releaseUrl) {
        await shell.openExternal(this.status.releaseUrl)
      }
      return this.getStatus()
    }

    const fileName = path.basename(new URL(assetUrl).pathname) || `CrateSync-${this.status.latestVersion}.dmg`
    const destPath = path.join(app.getPath('downloads'), fileName)

    this.emit({ stage: 'downloading', downloadPercent: 1, message: `Downloading ${fileName}...` })
    await this.downloadAssetWithRedirects(assetUrl, destPath, (pct) => {
      this.emit({
        stage: 'downloading',
        downloadPercent: pct,
        message: `Downloading ${fileName} (${pct}%)...`
      })
    })

    return this.emit({
      stage: 'downloaded',
      downloadPercent: 100,
      downloadedFilePath: destPath,
      message: `Downloaded installer to Downloads (${fileName}).`
    })
  }

  public async quitAndInstall(): Promise<void> {
    if (this.useNativeAutoUpdater) {
      autoUpdater.quitAndInstall(false, true)
      return
    }

    if (this.status.downloadedFilePath && fs.existsSync(this.status.downloadedFilePath)) {
      await shell.openPath(this.status.downloadedFilePath)
    } else if (this.status.releaseUrl) {
      await shell.openExternal(this.status.releaseUrl)
    }
  }

  private fetchLatestGithubRelease(): Promise<GithubReleaseResponse | null> {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
    return new Promise((resolve, reject) => {
      https
        .get(
          url,
          {
            headers: {
              'User-Agent': `CrateSync/${app.getVersion()}`,
              Accept: 'application/vnd.github+json'
            }
          },
          (res) => {
            if (res.statusCode === 404) {
              res.resume()
              resolve(null)
              return
            }
            if (res.statusCode !== 200) {
              res.resume()
              reject(new Error(`GitHub API returned HTTP ${res.statusCode}`))
              return
            }
            let body = ''
            res.setEncoding('utf-8')
            res.on('data', (chunk) => {
              body += chunk
            })
            res.on('end', () => {
              try {
                resolve(JSON.parse(body) as GithubReleaseResponse)
              } catch (e) {
                reject(e)
              }
            })
          }
        )
        .on('error', reject)
    })
  }

  private downloadAssetWithRedirects(
    url: string,
    destPath: string,
    onPercent: (pct: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = (targetUrl: string, redirects = 0): void => {
        if (redirects > 8) {
          reject(new Error('Too many redirects'))
          return
        }
        https
          .get(
            targetUrl,
            { headers: { 'User-Agent': `CrateSync/${app.getVersion()}` } },
            (res) => {
              if (
                res.statusCode &&
                res.statusCode >= 300 &&
                res.statusCode < 400 &&
                res.headers.location
              ) {
                res.resume()
                request(new URL(res.headers.location, targetUrl).toString(), redirects + 1)
                return
              }
              if (res.statusCode !== 200) {
                res.resume()
                reject(new Error(`HTTP ${res.statusCode} downloading update`))
                return
              }
              const total = parseInt(res.headers['content-length'] || '0', 10)
              let received = 0
              const out = fs.createWriteStream(destPath)
              res.on('data', (chunk: Buffer) => {
                received += chunk.length
                if (total > 0) {
                  onPercent(Math.min(99, Math.round((received / total) * 100)))
                }
              })
              res.pipe(out)
              out.on('finish', () => resolve())
              out.on('error', reject)
            }
          )
          .on('error', reject)
      }
      request(url)
    })
  }
}

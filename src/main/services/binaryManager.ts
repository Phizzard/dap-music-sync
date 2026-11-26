import { app } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import fsp from 'fs/promises'
import https from 'https'
import path from 'path'
import { promisify } from 'util'
import zlib from 'zlib'
import type { BinaryInfo, BinaryInstallProgress, BinaryStatus } from '@shared/types'
import type { StoreService } from './storeService'

const execFileAsync = promisify(execFile)

export class BinaryManager {
  private managedBinDir: string
  private progressListeners: Array<(progress: BinaryInstallProgress) => void> = []
  private cachedStatus: BinaryStatus | null = null

  constructor(private store: StoreService) {
    this.managedBinDir = path.join(app.getPath('userData'), 'bin')
  }

  public onProgress(cb: (progress: BinaryInstallProgress) => void): () => void {
    this.progressListeners.push(cb)
    return () => {
      this.progressListeners = this.progressListeners.filter((l) => l !== cb)
    }
  }

  private emitProgress(progress: BinaryInstallProgress): void {
    for (const cb of this.progressListeners) {
      cb(progress)
    }
  }

  private getExeName(base: 'yt-dlp' | 'ffmpeg'): string {
    return process.platform === 'win32' ? `${base}.exe` : base
  }

  private getCandidateSystemPaths(base: 'yt-dlp' | 'ffmpeg'): string[] {
    const exe = this.getExeName(base)
    const candidates: string[] = []

    // PATH directories
    const pathEnv = process.env.PATH || ''
    const sep = process.platform === 'win32' ? ';' : ':'
    for (const dir of pathEnv.split(sep)) {
      if (dir.trim()) {
        candidates.push(path.join(dir.trim(), exe))
      }
    }

    if (process.platform === 'darwin') {
      // macOS Finder GUI apps often do not inherit Homebrew/local shell PATH
      candidates.push(
        `/opt/homebrew/bin/${exe}`,
        `/usr/local/bin/${exe}`,
        path.join(app.getPath('home'), '.local', 'bin', exe)
      )
    } else if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA
      if (localAppData) {
        candidates.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Links', exe))
        // Scan WinGet Packages folder if Links symlink is not in PATH
        const wingetPkgs = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages')
        if (fs.existsSync(wingetPkgs)) {
          try {
            const entries = fs.readdirSync(wingetPkgs)
            const prefix = base === 'yt-dlp' ? 'yt-dlp.yt-dlp' : 'Gyan.FFmpeg'
            for (const entry of entries) {
              if (entry.toLowerCase().startsWith(prefix.toLowerCase())) {
                const pkgDir = path.join(wingetPkgs, entry)
                const found = this.findFileRecursive(pkgDir, exe, 3)
                if (found) candidates.push(found)
              }
            }
          } catch {
            // ignore
          }
        }
      }
    }

    return [...new Set(candidates)]
  }

  private findFileRecursive(dir: string, targetName: string, maxDepth: number): string | null {
    if (maxDepth < 0) return null
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isFile() && e.name.toLowerCase() === targetName.toLowerCase()) {
          return full
        }
        if (e.isDirectory() && maxDepth > 0) {
          const sub = this.findFileRecursive(full, targetName, maxDepth - 1)
          if (sub) return sub
        }
      }
    } catch {
      // ignore
    }
    return null
  }

  private async probeBinary(binPath: string, name: 'yt-dlp' | 'ffmpeg'): Promise<string | null> {
    try {
      if (!fs.existsSync(binPath)) return null
      const args = name === 'yt-dlp' ? ['--version'] : ['-version']
      const { stdout } = await execFileAsync(binPath, args, {
        timeout: 8000,
        windowsHide: true
      })
      const firstLine = stdout.trim().split(/\r?\n/)[0] || 'installed'
      if (name === 'ffmpeg') {
        const match = firstLine.match(/ffmpeg version\s+([^\s]+)/i)
        return match ? match[1] : firstLine.slice(0, 40)
      }
      return firstLine.trim()
    } catch {
      return null
    }
  }

  public async resolveBinary(name: 'yt-dlp' | 'ffmpeg'): Promise<BinaryInfo> {
    const settings = this.store.getSettings()
    const customPath = name === 'yt-dlp' ? settings.customYtdlpPath : settings.customFfmpegPath

    // 1. Custom path
    if (customPath && customPath.trim()) {
      const ver = await this.probeBinary(customPath.trim(), name)
      if (ver) {
        return { name, found: true, path: customPath.trim(), version: ver, source: 'custom' }
      }
    }

    // 2. Managed binary (prioritize if updated via app, or check after system? Checking managed first if present ensures in-app updates take effect immediately)
    const managedPath = path.join(this.managedBinDir, this.getExeName(name))
    const managedVer = await this.probeBinary(managedPath, name)
    if (managedVer) {
      return { name, found: true, path: managedPath, version: managedVer, source: 'managed' }
    }

    // 3. System PATH & OS standard locations
    for (const candidate of this.getCandidateSystemPaths(name)) {
      const ver = await this.probeBinary(candidate, name)
      if (ver) {
        return { name, found: true, path: candidate, version: ver, source: 'system' }
      }
    }

    return { name, found: false, source: 'missing' }
  }

  public async getStatus(forceRefresh = false): Promise<BinaryStatus> {
    if (this.cachedStatus && !forceRefresh) {
      return this.cachedStatus
    }
    const [ytdlp, ffmpeg] = await Promise.all([
      this.resolveBinary('yt-dlp'),
      this.resolveBinary('ffmpeg')
    ])
    this.cachedStatus = {
      ytdlp,
      ffmpeg,
      ready: ytdlp.found && ffmpeg.found
    }
    return this.cachedStatus
  }

  public async getPaths(): Promise<{
    ytdlpPath: string
    ffmpegPath: string
    ffmpegDir: string
    jsRuntimeArgs: string[]
  }> {
    const status = await this.getStatus()
    if (!status.ytdlp.found || !status.ytdlp.path) {
      throw new Error('yt-dlp binary is not installed. Please install binaries in Settings.')
    }
    if (!status.ffmpeg.found || !status.ffmpeg.path) {
      throw new Error('ffmpeg binary is not installed. Please install binaries in Settings.')
    }
    return {
      ytdlpPath: status.ytdlp.path,
      ffmpegPath: status.ffmpeg.path,
      ffmpegDir: path.dirname(status.ffmpeg.path),
      jsRuntimeArgs: this.resolveNodeJsRuntimeArgs()
    }
  }

  private resolveNodeJsRuntimeArgs(): string[] {
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    const candidates: string[] = []
    const sep = process.platform === 'win32' ? ';' : ':'
    for (const dir of (process.env.PATH || '').split(sep)) {
      if (dir.trim()) candidates.push(path.join(dir.trim(), exe))
    }
    if (process.platform === 'win32' && process.env.APPDATA) {
      const nvmDir = path.join(process.env.APPDATA, 'nvm')
      if (fs.existsSync(nvmDir)) {
        try {
          for (const d of fs.readdirSync(nvmDir)) {
            if (d.startsWith('v')) candidates.unshift(path.join(nvmDir, d, 'node.exe'))
          }
        } catch {
          // ignore
        }
      }
      candidates.push('C:\\Program Files\\nodejs\\node.exe')
    } else if (process.platform === 'darwin') {
      candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node')
    }
    const found = candidates.find((c) => fs.existsSync(c))
    return found ? ['--js-runtimes', `node:${found}`] : []
  }

  public async installMissingBinaries(): Promise<BinaryStatus> {
    await fsp.mkdir(this.managedBinDir, { recursive: true })
    const current = await this.getStatus(true)

    try {
      if (!current.ytdlp.found) {
        await this.downloadYtdlp()
      }
      if (!current.ffmpeg.found) {
        await this.downloadFfmpeg()
      }
      this.emitProgress({ active: false, message: 'Binaries ready', percent: 100 })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitProgress({ active: false, message: 'Installation failed', error: message })
      throw err
    }

    return this.getStatus(true)
  }

  private async downloadYtdlp(): Promise<void> {
    const assetName =
      process.platform === 'win32'
        ? 'yt-dlp.exe'
        : process.platform === 'darwin'
          ? 'yt-dlp_macos'
          : 'yt-dlp_linux'

    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`
    const dest = path.join(this.managedBinDir, this.getExeName('yt-dlp'))

    this.emitProgress({
      active: true,
      binary: 'yt-dlp',
      message: 'Downloading yt-dlp...',
      percent: 5
    })

    await this.downloadFile(url, dest, false, (pct) => {
      this.emitProgress({
        active: true,
        binary: 'yt-dlp',
        message: `Downloading yt-dlp (${pct}%)...`,
        percent: pct
      })
    })

    if (process.platform !== 'win32') {
      await fsp.chmod(dest, 0o755)
    }
  }

  private async downloadFfmpeg(): Promise<void> {
    const platform = process.platform // win32, darwin, linux
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/${platform}-${arch}.gz`
    const dest = path.join(this.managedBinDir, this.getExeName('ffmpeg'))

    this.emitProgress({
      active: true,
      binary: 'ffmpeg',
      message: 'Downloading ffmpeg...',
      percent: 5
    })

    await this.downloadFile(url, dest, true, (pct) => {
      this.emitProgress({
        active: true,
        binary: 'ffmpeg',
        message: `Downloading ffmpeg (${pct}%)...`,
        percent: pct
      })
    })

    if (process.platform !== 'win32') {
      await fsp.chmod(dest, 0o755)
    }
  }

  public async updateYtdlp(): Promise<{ updated: boolean; output: string; status: BinaryStatus }> {
    const status = await this.getStatus(true)
    if (status.ytdlp.found && status.ytdlp.path && status.ytdlp.source === 'managed') {
      try {
        const { stdout, stderr } = await execFileAsync(status.ytdlp.path, ['-U'], {
          timeout: 60000,
          windowsHide: true
        })
        const refreshed = await this.getStatus(true)
        return { updated: true, output: (stdout || stderr).trim(), status: refreshed }
      } catch {
        // Fallback to direct download into managed folder
      }
    }

    await fsp.mkdir(this.managedBinDir, { recursive: true })
    await this.downloadYtdlp()
    this.emitProgress({ active: false, message: 'yt-dlp updated', percent: 100 })
    const refreshed = await this.getStatus(true)
    return {
      updated: true,
      output: `Installed latest standalone yt-dlp (${refreshed.ytdlp.version || 'latest'}) in app bin directory.`,
      status: refreshed
    }
  }

  private downloadFile(
    url: string,
    destPath: string,
    gunzip: boolean,
    onPercent: (pct: number) => void
  ): Promise<void> {
    const tmpPath = `${destPath}.download`
    return new Promise((resolve, reject) => {
      const request = (targetUrl: string, redirects = 0): void => {
        if (redirects > 8) {
          reject(new Error('Too many redirects while downloading binary'))
          return
        }
        https
          .get(
            targetUrl,
            { headers: { 'User-Agent': 'CrateSync-Desktop/1.0' } },
            (res) => {
              if (
                res.statusCode &&
                res.statusCode >= 300 &&
                res.statusCode < 400 &&
                res.headers.location
              ) {
                res.resume()
                const nextUrl = new URL(res.headers.location, targetUrl).toString()
                request(nextUrl, redirects + 1)
                return
              }
              if (res.statusCode !== 200) {
                res.resume()
                reject(new Error(`HTTP ${res.statusCode} downloading ${targetUrl}`))
                return
              }

              const total = parseInt(res.headers['content-length'] || '0', 10)
              let received = 0

              res.on('data', (chunk: Buffer) => {
                received += chunk.length
                if (total > 0) {
                  onPercent(Math.min(99, Math.round((received / total) * 100)))
                }
              })

              const fileOut = fs.createWriteStream(tmpPath)
              const streamChain = gunzip ? res.pipe(zlib.createGunzip()).pipe(fileOut) : res.pipe(fileOut)

              streamChain.on('finish', async () => {
                try {
                  await fsp.rename(tmpPath, destPath)
                  resolve()
                } catch (e) {
                  reject(e)
                }
              })

              streamChain.on('error', (err) => {
                fs.unlink(tmpPath, () => {})
                reject(err)
              })
            }
          )
          .on('error', (err) => {
            fs.unlink(tmpPath, () => {})
            reject(err)
          })
      }

      request(url)
    })
  }
}

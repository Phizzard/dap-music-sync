import { app } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import fsp from 'fs/promises'
import http from 'http'
import { AddressInfo } from 'net'
import path from 'path'
import { promisify } from 'util'
import { parseFile } from 'music-metadata'
import type { BinaryManager } from './binaryManager'
import type { LibraryService } from './libraryService'

const execFileAsync = promisify(execFile)

interface CachedPreviewFile {
  filePath: string
  durationSec?: number
  createdAt: number
}

const MIME_BY_EXT: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm'
}

const PREVIEW_AUDIO_EXTS = ['.webm', '.m4a', '.opus', '.mp3', '.ogg', '.aac']

export class StreamService {
  private previewDir: string
  private previewCache = new Map<string, CachedPreviewFile>()
  private inflightResolutions = new Map<string, Promise<CachedPreviewFile>>()
  private server: http.Server | null = null
  private baseUrl = ''

  constructor(
    private binaryManager: BinaryManager,
    private libraryService: LibraryService
  ) {
    this.previewDir = path.join(app.getPath('temp'), 'cratesync-previews')
  }

  public async start(): Promise<string> {
    if (this.server && this.baseUrl) return this.baseUrl

    await fsp.mkdir(this.previewDir, { recursive: true })

    this.server = http.createServer((req, res) => {
      this.routeHttpRequest(req, res).catch((err) => {
        console.error('Stream server error:', err)
        if (!res.headersSent) {
          res.writeHead(500, {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*'
          })
        }
        res.end('Internal stream error')
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as AddressInfo
        this.baseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    })

    return this.baseUrl
  }

  public stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  public getBaseUrl(): string {
    return this.baseUrl
  }

  private async routeHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type'
      })
      res.end()
      return
    }

    const parsed = new URL(req.url || '/', 'http://127.0.0.1')
    const parts = parsed.pathname.split('/').filter(Boolean)
    const kind = parts[0]
    const id = parts[1] ? decodeURIComponent(parts[1]) : ''

    if (kind === 'remote' && id) {
      const preview = await this.resolveRemoteStream(id)
      await this.serveAudioFile(preview.filePath, req, res)
      return
    }
    if (kind === 'local' && id) {
      const track = this.libraryService.getTrackById(id)
      if (!track || !fs.existsSync(track.filePath)) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
        res.end('Local audio file not found')
        return
      }
      await this.serveAudioFile(track.filePath, req, res)
      return
    }

    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
    res.end('Not found')
  }

  private findExistingPreviewFile(cleanId: string): string | null {
    for (const ext of PREVIEW_AUDIO_EXTS) {
      const candidate = path.join(this.previewDir, `${cleanId}${ext}`)
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 1024) {
        return candidate
      }
    }
    return null
  }

  public async resolveRemoteStream(videoId: string): Promise<CachedPreviewFile> {
    const cleanId = videoId.replace(/[^A-Za-z0-9_-]/g, '')
    if (!cleanId) throw new Error('Invalid videoId')

    // If user already owns this song in their local library, play local file directly!
    const owned = this.libraryService.findByVideoId(cleanId)
    if (owned && fs.existsSync(owned.filePath)) {
      return {
        filePath: owned.filePath,
        durationSec: owned.durationSec,
        createdAt: Date.now()
      }
    }

    const cached = this.previewCache.get(cleanId)
    if (cached && fs.existsSync(cached.filePath)) {
      return cached
    }

    const onDisk = this.findExistingPreviewFile(cleanId)
    if (onDisk) {
      let durationSec: number | undefined
      try {
        const meta = await parseFile(onDisk, { duration: true })
        if (meta.format.duration) durationSec = Math.round(meta.format.duration)
      } catch {
        // ignore
      }
      const entry: CachedPreviewFile = { filePath: onDisk, durationSec, createdAt: Date.now() }
      this.previewCache.set(cleanId, entry)
      return entry
    }

    const inflight = this.inflightResolutions.get(cleanId)
    if (inflight) return inflight

    const promise = (async (): Promise<CachedPreviewFile> => {
      await fsp.mkdir(this.previewDir, { recursive: true })
      const { ytdlpPath, jsRuntimeArgs } = await this.binaryManager.getPaths()
      const targetUrl = `https://music.youtube.com/watch?v=${cleanId}`
      const outTemplate = path.join(this.previewDir, `${cleanId}.%(ext)s`)

      await execFileAsync(
        ytdlpPath,
        [
          '--no-playlist',
          ...jsRuntimeArgs,
          '-f',
          'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
          '--no-part',
          '--no-warnings',
          '-o',
          outTemplate,
          targetUrl
        ],
        { timeout: 60000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
      )

      const downloadedPath = this.findExistingPreviewFile(cleanId)
      if (!downloadedPath) {
        throw new Error('Could not prepare audio preview stream.')
      }

      let durationSec: number | undefined
      try {
        const meta = await parseFile(downloadedPath, { duration: true })
        if (meta.format.duration) durationSec = Math.round(meta.format.duration)
      } catch {
        // ignore
      }

      const entry: CachedPreviewFile = {
        filePath: downloadedPath,
        durationSec,
        createdAt: Date.now()
      }
      this.previewCache.set(cleanId, entry)
      this.pruneOldPreviews().catch(() => {})
      return entry
    })()

    this.inflightResolutions.set(cleanId, promise)
    try {
      return await promise
    } finally {
      this.inflightResolutions.delete(cleanId)
    }
  }

  private async pruneOldPreviews(): Promise<void> {
    const entries = await fsp.readdir(this.previewDir)
    if (entries.length <= 30) return
    const stats = await Promise.all(
      entries.map(async (name) => {
        const full = path.join(this.previewDir, name)
        const s = await fsp.stat(full)
        return { full, mtime: s.mtimeMs }
      })
    )
    stats.sort((a, b) => b.mtime - a.mtime)
    for (const old of stats.slice(30)) {
      await fsp.unlink(old.full).catch(() => {})
    }
  }

  private async serveAudioFile(
    filePath: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const stat = await fsp.stat(filePath)
    const totalSize = stat.size
    const ext = path.extname(filePath).toLowerCase()
    const mimeType = MIME_BY_EXT[ext] || 'audio/webm'
    const rangeHeader = req.headers.range

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0
        const end = match[2] ? Math.min(parseInt(match[2], 10), totalSize - 1) : totalSize - 1
        if (start >= totalSize || start > end) {
          res.writeHead(416, {
            'Access-Control-Allow-Origin': '*',
            'Content-Range': `bytes */${totalSize}`
          })
          res.end()
          return
        }
        const chunkSize = end - start + 1
        res.writeHead(206, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Range': `bytes ${start}-${end}/${totalSize}`
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        const stream = fs.createReadStream(filePath, { start, end })
        res.on('close', () => stream.destroy())
        stream.pipe(res)
        return
      }
    }

    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Length': totalSize
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(filePath)
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }
}

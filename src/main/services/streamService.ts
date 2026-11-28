import { app } from 'electron'
import { execFile, spawn } from 'child_process'
import fs from 'fs'
import fsp from 'fs/promises'
import http from 'http'
import { AddressInfo } from 'net'
import path from 'path'
import { promisify } from 'util'
import type { BinaryManager } from './binaryManager'
import type { LibraryService } from './libraryService'

const execFileAsync = promisify(execFile)

type ResolvedPreviewStream =
  | {
      kind: 'file'
      filePath: string
      durationSec?: number
    }
  | {
      kind: 'stream'
      videoId: string
      durationSec?: number
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

function sniffAudioFormat(chunk: Buffer): { mimeType: string; ext: string } {
  if (chunk.length >= 4) {
    // EBML / WebM
    if (chunk[0] === 0x1a && chunk[1] === 0x45 && chunk[2] === 0xdf && chunk[3] === 0xa3) {
      return { mimeType: 'audio/webm', ext: '.webm' }
    }
    // Ogg / Opus
    if (chunk.subarray(0, 4).toString('ascii') === 'OggS') {
      return { mimeType: 'audio/ogg', ext: '.ogg' }
    }
    // MP3 ID3 or frame sync
    if (
      chunk.subarray(0, 3).toString('ascii') === 'ID3' ||
      (chunk[0] === 0xff && (chunk[1] & 0xe0) === 0xe0)
    ) {
      return { mimeType: 'audio/mpeg', ext: '.mp3' }
    }
  }
  if (chunk.length >= 8 && chunk.subarray(4, 8).toString('ascii') === 'ftyp') {
    return { mimeType: 'audio/mp4', ext: '.m4a' }
  }
  return { mimeType: 'audio/webm', ext: '.webm' }
}

export class StreamService {
  private previewDir: string
  private inflightPrefetches = new Map<string, Promise<void>>()
  private server: http.Server | null = null
  private baseUrl = ''

  constructor(
    private binaryManager: BinaryManager,
    private libraryService: LibraryService
  ) {
    this.previewDir = path.join(app.getPath('temp'), 'dap-music-sync-previews')
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
      if (preview.kind === 'file') {
        await this.serveAudioFile(preview.filePath, req, res)
        return
      }
      await this.streamViaYtdlp(preview.videoId, req, res)
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

  public async resolveRemoteStream(videoId: string): Promise<ResolvedPreviewStream> {
    const cleanId = videoId.replace(/[^A-Za-z0-9_-]/g, '')
    if (!cleanId) throw new Error('Invalid videoId')

    // If user already owns this song in their local library, play local file directly!
    const owned = this.libraryService.findByVideoId(cleanId)
    if (owned && fs.existsSync(owned.filePath)) {
      return {
        kind: 'file',
        filePath: owned.filePath,
        durationSec: owned.durationSec
      }
    }

    // If previously cached or prefetched to temp disk, serve with full Range seeking
    const cachedFile = this.findExistingPreviewFile(cleanId)
    if (cachedFile) {
      return {
        kind: 'file',
        filePath: cachedFile
      }
    }

    return {
      kind: 'stream',
      videoId: cleanId
    }
  }

  public async prefetchRemoteStream(videoId: string): Promise<void> {
    const cleanId = videoId.replace(/[^A-Za-z0-9_-]/g, '')
    if (!cleanId) return

    const owned = this.libraryService.findByVideoId(cleanId)
    if (owned && fs.existsSync(owned.filePath)) return
    if (this.findExistingPreviewFile(cleanId)) return

    const existing = this.inflightPrefetches.get(cleanId)
    if (existing) return existing

    const promise = (async (): Promise<void> => {
      try {
        await fsp.mkdir(this.previewDir, { recursive: true })
        const { ytdlpPath, jsRuntimeArgs } = await this.binaryManager.getPaths()
        const targetUrl = `https://music.youtube.com/watch?v=${cleanId}`
        const outTemplate = path.join(this.previewDir, `${cleanId}.%(ext)s`)
        const t0 = Date.now()

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
          { timeout: 45000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
        )
        console.log(`[stream] prefetched ${cleanId} in ${Date.now() - t0}ms`)
        this.pruneOldPreviews().catch(() => {})
      } catch {
        // Prefetch is best-effort; ignore failures silently
      }
    })()

    this.inflightPrefetches.set(cleanId, promise)
    try {
      await promise
    } finally {
      this.inflightPrefetches.delete(cleanId)
    }
  }

  private async pruneOldPreviews(): Promise<void> {
    const entries = await fsp.readdir(this.previewDir)
    const completed = entries.filter((name) => !name.includes('.part.'))
    if (completed.length <= 30) return
    const stats = await Promise.all(
      completed.map(async (name) => {
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

  private async streamViaYtdlp(
    cleanId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    useCookies = false
  ): Promise<void> {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'audio/webm'
      })
      res.end()
      return
    }

    await fsp.mkdir(this.previewDir, { recursive: true })
    const t0 = Date.now()
    const { ytdlpPath, jsRuntimeArgs, cookieArgs } = await this.binaryManager.getPaths()
    const activeCookieArgs = useCookies ? cookieArgs : []
    const targetUrl = `https://music.youtube.com/watch?v=${cleanId}`

    const result = await new Promise<'ok' | 'age_restricted'>((resolve, reject) => {
      const proc = spawn(
        ytdlpPath,
        [
          '--no-playlist',
          ...jsRuntimeArgs,
          ...activeCookieArgs,
          '-f',
          'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
          '--no-warnings',
          '-o',
          '-',
          targetUrl
        ],
        { windowsHide: true }
      )

      let headersSent = false
      let stderrText = ''
      let partPath: string | null = null
      let finalPath: string | null = null
      let fileStream: fs.WriteStream | null = null
      let streamCompleted = false

      const cleanupPart = (): void => {
        if (fileStream) {
          fileStream.destroy()
          fileStream = null
        }
        if (partPath) {
          fsp.unlink(partPath).catch(() => {})
          partPath = null
        }
      }

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString()
      })

      proc.stdout.once('data', (firstChunk: Buffer) => {
        if (res.destroyed || res.writableEnded) {
          proc.kill()
          resolve('ok')
          return
        }
        headersSent = true
        const { mimeType, ext } = sniffAudioFormat(firstChunk)
        console.log(
          `[stream] ${cleanId} yt-dlp${useCookies ? ' (cookies)' : ''} first audio chunk (${mimeType}) in ${Date.now() - t0}ms`
        )

        partPath = path.join(this.previewDir, `${cleanId}.part.${Date.now()}${ext}`)
        finalPath = path.join(this.previewDir, `${cleanId}${ext}`)
        fileStream = fs.createWriteStream(partPath)
        fileStream.on('error', () => {
          cleanupPart()
        })
        fileStream.write(firstChunk)

        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': mimeType
        })
        res.write(firstChunk)
        proc.stdout.on('data', (chunk: Buffer) => {
          if (fileStream && !fileStream.destroyed) {
            fileStream.write(chunk)
          }
          if (!res.destroyed && !res.writableEnded) {
            res.write(chunk)
          }
        })
      })

      proc.stdout.on('end', () => {
        streamCompleted = true
        if (!res.writableEnded) {
          res.end()
        }
      })

      proc.on('error', (err) => {
        cleanupPart()
        if (!headersSent && !res.headersSent) reject(err)
        else {
          res.destroy(err)
          resolve('ok')
        }
      })

      proc.on('close', (code) => {
        if (code === 0 && streamCompleted && fileStream && partPath && finalPath) {
          const completedPart = partPath
          const completedFinal = finalPath
          const ws = fileStream
          fileStream = null
          partPath = null
          ws.end(() => {
            fsp
              .rename(completedPart, completedFinal)
              .then(() => this.pruneOldPreviews())
              .catch(() => {
                fsp.unlink(completedPart).catch(() => {})
              })
          })
        } else {
          cleanupPart()
        }

        if (!headersSent && !res.headersSent) {
          const msg = stderrText.trim() || `yt-dlp stream exited with code ${code}`
          if (/sign in to confirm your age/i.test(msg)) {
            if (!useCookies && cookieArgs.length > 0) {
              resolve('age_restricted')
              return
            }
            reject(
              new Error(
                'This track is age-restricted on YouTube. Select a signed-in browser under Settings → YouTube Cookies to play or download it.'
              )
            )
          } else {
            reject(new Error(msg))
          }
        } else {
          resolve('ok')
        }
      })

      res.on('close', () => {
        if (!res.writableEnded && !proc.killed) {
          proc.kill()
          cleanupPart()
        }
      })
    })

    if (result === 'age_restricted' && !res.headersSent && !res.writableEnded) {
      await this.streamViaYtdlp(cleanId, req, res, true)
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

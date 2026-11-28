import { execFile } from 'child_process'
import fs from 'fs'
import fsp from 'fs/promises'
import http from 'http'
import https from 'https'
import { AddressInfo } from 'net'
import path from 'path'
import { promisify } from 'util'
import type { BinaryManager } from './binaryManager'
import type { LibraryService } from './libraryService'

const execFileAsync = promisify(execFile)

interface CachedRemoteStream {
  kind: 'remote'
  streamUrl: string
  mimeType: string
  headers: Record<string, string>
  durationSec?: number
  expiresAt: number
}

type ResolvedPreviewStream =
  | {
      kind: 'file'
      filePath: string
      durationSec?: number
    }
  | CachedRemoteStream

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

export class StreamService {
  private remoteCache = new Map<string, CachedRemoteStream>()
  private inflightResolutions = new Map<string, Promise<ResolvedPreviewStream>>()
  private server: http.Server | null = null
  private baseUrl = ''

  constructor(
    private binaryManager: BinaryManager,
    private libraryService: LibraryService
  ) {}

  public async start(): Promise<string> {
    if (this.server && this.baseUrl) return this.baseUrl

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
      await this.proxyRemoteStream(id, preview, req, res)
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

  private parseStreamExpiration(streamUrl: string): number {
    try {
      const expireParam = new URL(streamUrl).searchParams.get('expire')
      if (expireParam) {
        const expireSec = parseInt(expireParam, 10)
        if (!isNaN(expireSec) && expireSec > 0) {
          // Refresh 5 minutes before upstream URL expires
          return expireSec * 1000 - 5 * 60 * 1000
        }
      }
    } catch {
      // ignore invalid URL
    }
    return Date.now() + 30 * 60 * 1000
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

    const cached = this.remoteCache.get(cleanId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached
    }

    const inflight = this.inflightResolutions.get(cleanId)
    if (inflight) return inflight

    const promise = (async (): Promise<ResolvedPreviewStream> => {
      const { ytdlpPath, jsRuntimeArgs } = await this.binaryManager.getPaths()
      const targetUrl = `https://music.youtube.com/watch?v=${cleanId}`

      const { stdout } = await execFileAsync(
        ytdlpPath,
        [
          '--no-playlist',
          ...jsRuntimeArgs,
          '-f',
          'bestaudio[ext=webm][protocol^=http]/bestaudio[ext=m4a][protocol^=http]/bestaudio[protocol^=http]/bestaudio',
          '--dump-single-json',
          '--no-warnings',
          targetUrl
        ],
        { timeout: 30000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
      )

      const data = JSON.parse(stdout) as Record<string, unknown>
      const requestedFormats = Array.isArray(data.requested_formats)
        ? (data.requested_formats as Array<Record<string, unknown>>)
        : []
      const directUrl =
        typeof data.url === 'string' && data.url
          ? data.url
          : typeof requestedFormats[0]?.url === 'string'
            ? requestedFormats[0].url
            : ''

      if (!directUrl) {
        throw new Error('Could not resolve direct audio stream URL.')
      }

      const extRaw =
        typeof data.ext === 'string' && data.ext
          ? data.ext
          : typeof requestedFormats[0]?.ext === 'string'
            ? requestedFormats[0].ext
            : 'webm'
      const normalizedExt = extRaw.startsWith('.') ? extRaw.toLowerCase() : `.${extRaw.toLowerCase()}`
      const mimeType = MIME_BY_EXT[normalizedExt] || 'audio/webm'

      const durationSec =
        typeof data.duration === 'number' && data.duration > 0
          ? Math.round(data.duration)
          : undefined

      const rawHeaders =
        data.http_headers && typeof data.http_headers === 'object'
          ? (data.http_headers as Record<string, unknown>)
          : {}
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (typeof value === 'string' && key.toLowerCase() !== 'accept-encoding') {
          headers[key] = value
        }
      }

      const entry: CachedRemoteStream = {
        kind: 'remote',
        streamUrl: directUrl,
        mimeType,
        headers,
        durationSec,
        expiresAt: this.parseStreamExpiration(directUrl)
      }
      this.remoteCache.set(cleanId, entry)
      return entry
    })()

    this.inflightResolutions.set(cleanId, promise)
    try {
      return await promise
    } finally {
      this.inflightResolutions.delete(cleanId)
    }
  }

  private async proxyRemoteStream(
    videoId: string,
    stream: CachedRemoteStream,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    allowRetry = true
  ): Promise<void> {
    const status = await this.forwardUpstreamRequest(stream, req, res)
    if ((status === 403 || status === 410) && allowRetry) {
      const cleanId = videoId.replace(/[^A-Za-z0-9_-]/g, '')
      this.remoteCache.delete(cleanId)
      const refreshed = await this.resolveRemoteStream(cleanId)
      if (refreshed.kind === 'file') {
        await this.serveAudioFile(refreshed.filePath, req, res)
        return
      }
      await this.proxyRemoteStream(videoId, refreshed, req, res, false)
    }
  }

  private forwardUpstreamRequest(
    stream: CachedRemoteStream,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    targetUrl = stream.streamUrl,
    redirectsRemaining = 3
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(targetUrl)
      const client = parsedUrl.protocol === 'https:' ? https : http

      const headers: Record<string, string> = { ...stream.headers }
      if (req.headers.range) {
        headers['Range'] = req.headers.range
      }

      const upstreamReq = client.request(
        parsedUrl,
        {
          method: req.method === 'HEAD' ? 'HEAD' : 'GET',
          headers
        },
        (upstreamRes) => {
          const statusCode = upstreamRes.statusCode || 502

          if (
            statusCode >= 300 &&
            statusCode < 400 &&
            upstreamRes.headers.location &&
            redirectsRemaining > 0
          ) {
            upstreamRes.resume()
            const nextUrl = new URL(upstreamRes.headers.location, parsedUrl).toString()
            this.forwardUpstreamRequest(stream, req, res, nextUrl, redirectsRemaining - 1)
              .then(resolve)
              .catch(reject)
            return
          }

          if (statusCode === 403 || statusCode === 410) {
            upstreamRes.resume()
            resolve(statusCode)
            return
          }

          const responseHeaders: Record<string, string | number> = {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': upstreamRes.headers['content-type'] || stream.mimeType,
            'Accept-Ranges': upstreamRes.headers['accept-ranges'] || 'bytes'
          }
          if (upstreamRes.headers['content-length']) {
            responseHeaders['Content-Length'] = upstreamRes.headers['content-length']
          }
          if (upstreamRes.headers['content-range']) {
            responseHeaders['Content-Range'] = upstreamRes.headers['content-range']
          }

          res.writeHead(statusCode, responseHeaders)
          if (req.method === 'HEAD') {
            upstreamRes.resume()
            res.end()
            resolve(statusCode)
            return
          }

          upstreamRes.pipe(res)
          upstreamRes.on('end', () => resolve(statusCode))
          upstreamRes.on('error', (err) => {
            if (!res.headersSent) reject(err)
            else {
              res.destroy(err)
              resolve(statusCode)
            }
          })
        }
      )

      res.on('close', () => {
        if (!res.writableEnded) {
          upstreamReq.destroy()
        }
      })

      upstreamReq.on('error', (err) => {
        if (!res.headersSent) reject(err)
        else res.destroy(err)
      })

      upstreamReq.end()
    })
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

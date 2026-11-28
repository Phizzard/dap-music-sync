import { spawn } from 'child_process'
import fs from 'fs'
import fsp from 'fs/promises'
import http from 'http'
import { AddressInfo } from 'net'
import path from 'path'
import type { BinaryManager } from './binaryManager'
import type { LibraryService } from './libraryService'

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

function sniffAudioMimeType(chunk: Buffer): string {
  if (chunk.length >= 4) {
    // EBML / WebM
    if (chunk[0] === 0x1a && chunk[1] === 0x45 && chunk[2] === 0xdf && chunk[3] === 0xa3) {
      return 'audio/webm'
    }
    // Ogg / Opus
    if (chunk.subarray(0, 4).toString('ascii') === 'OggS') {
      return 'audio/ogg'
    }
    // MP3 ID3 or frame sync
    if (
      chunk.subarray(0, 3).toString('ascii') === 'ID3' ||
      (chunk[0] === 0xff && (chunk[1] & 0xe0) === 0xe0)
    ) {
      return 'audio/mpeg'
    }
  }
  if (chunk.length >= 8 && chunk.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'audio/mp4'
  }
  return 'audio/webm'
}

export class StreamService {
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

    // Ensure binaries are available before PlayerBar starts playback
    await this.binaryManager.getPaths()

    return {
      kind: 'stream',
      videoId: cleanId
    }
  }

  private async streamViaYtdlp(
    cleanId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'audio/webm'
      })
      res.end()
      return
    }

    const t0 = Date.now()
    const { ytdlpPath, jsRuntimeArgs, cookieArgs } = await this.binaryManager.getPaths()
    const targetUrl = `https://music.youtube.com/watch?v=${cleanId}`

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        ytdlpPath,
        [
          '--no-playlist',
          ...jsRuntimeArgs,
          ...cookieArgs,
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

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString()
      })

      proc.stdout.once('data', (firstChunk: Buffer) => {
        if (res.destroyed || res.writableEnded) {
          proc.kill()
          resolve()
          return
        }
        headersSent = true
        const mimeType = sniffAudioMimeType(firstChunk)
        console.log(
          `[stream] ${cleanId} first audio chunk (${mimeType}) in ${Date.now() - t0}ms`
        )
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': mimeType
        })
        res.write(firstChunk)
        proc.stdout.pipe(res)
      })

      proc.stdout.on('end', () => {
        if (!res.writableEnded) {
          res.end()
        }
        resolve()
      })

      proc.on('error', (err) => {
        if (!headersSent && !res.headersSent) reject(err)
        else {
          res.destroy(err)
          resolve()
        }
      })

      proc.on('close', (code) => {
        if (!headersSent && !res.headersSent) {
          const msg = stderrText.trim() || `yt-dlp stream exited with code ${code}`
          if (/sign in to confirm your age/i.test(msg)) {
            reject(
              new Error(
                'This track is age-restricted on YouTube. Select a signed-in browser under Settings → YouTube Cookies to play or download it.'
              )
            )
          } else {
            reject(new Error(msg))
          }
        } else {
          resolve()
        }
      })

      res.on('close', () => {
        if (!res.writableEnded && !proc.killed) {
          proc.kill()
        }
      })
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

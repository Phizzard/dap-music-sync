import { app } from 'electron'
import { ChildProcess, execFile, spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import type { DownloadJob, DownloadRequest } from '@shared/types'
import type { BinaryManager } from './binaryManager'
import type { LibraryService } from './libraryService'
import type { SearchService } from './searchService'
import type { StoreService } from './storeService'

export class DownloadQueueService {
  private jobs: DownloadJob[]
  private activeProcesses = new Map<string, ChildProcess>()
  private listeners: Array<(jobs: DownloadJob[]) => void> = []
  private notifyTimer: NodeJS.Timeout | null = null

  constructor(
    private store: StoreService,
    private binaryManager: BinaryManager,
    private libraryService: LibraryService,
    private searchService: SearchService
  ) {
    this.jobs = [...this.store.getDownloadJobs()]
  }

  public onUpdated(cb: (jobs: DownloadJob[]) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }

  private emitUpdated(immediate = false): void {
    if (immediate) {
      if (this.notifyTimer) {
        clearTimeout(this.notifyTimer)
        this.notifyTimer = null
      }
      this.store.setDownloadJobs(this.jobs)
      const snapshot = this.getQueue()
      for (const cb of this.listeners) cb(snapshot)
      return
    }

    if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null
        this.store.setDownloadJobs(this.jobs)
        const snapshot = this.getQueue()
        for (const cb of this.listeners) cb(snapshot)
      }, 120)
    }
  }

  public getQueue(): DownloadJob[] {
    return this.jobs.map((j) => ({ ...j }))
  }

  public enqueue(requests: DownloadRequest[]): DownloadJob[] {
    const settings = this.store.getSettings()
    const created: DownloadJob[] = []

    for (const req of requests) {
      // Skip if identical videoId is already queued/downloading
      const alreadyActive = this.jobs.find(
        (j) =>
          j.videoId === req.videoId &&
          (j.stage === 'queued' || j.stage === 'downloading' || j.stage === 'processing')
      )
      if (alreadyActive) {
        created.push(alreadyActive)
        continue
      }

      const job: DownloadJob = {
        id: crypto.randomUUID(),
        videoId: req.videoId,
        sourceUrl: req.url || `https://music.youtube.com/watch?v=${req.videoId}`,
        title: req.title,
        artist: req.artist,
        album: req.album,
        albumId: req.albumId,
        trackNumber: req.trackNumber,
        thumbnailUrl: req.thumbnailUrl,
        format: req.format || settings.defaultFormat,
        quality: req.quality || settings.defaultQuality,
        stage: 'queued',
        progress: 0,
        targetPlaylistName: req.targetPlaylistName,
        createdAt: new Date().toISOString()
      }
      this.jobs.unshift(job)
      created.push(job)
    }

    this.emitUpdated(true)
    this.pumpQueue()
    return created
  }

  public async cancel(jobId: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId)
    if (!job) return

    const proc = this.activeProcesses.get(jobId)
    job.stage = 'cancelled'
    job.speed = undefined
    job.eta = undefined

    if (proc && proc.pid) {
      this.killProcessTree(proc)
      this.activeProcesses.delete(jobId)
    }

    this.emitUpdated(true)
    this.pumpQueue()
  }

  public async retry(jobId: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId)
    if (!job) return
    if (job.stage !== 'failed' && job.stage !== 'cancelled') return

    job.stage = 'queued'
    job.progress = 0
    job.error = undefined
    job.speed = undefined
    job.eta = undefined
    this.emitUpdated(true)
    this.pumpQueue()
  }

  public clearFinished(): DownloadJob[] {
    this.jobs = this.jobs.filter(
      (j) => j.stage === 'queued' || j.stage === 'downloading' || j.stage === 'processing'
    )
    this.emitUpdated(true)
    return this.getQueue()
  }

  private killProcessTree(proc: ChildProcess): void {
    if (!proc.pid) return
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      try {
        proc.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
  }

  private pumpQueue(): void {
    const maxConcurrent = Math.max(1, this.store.getSettings().maxConcurrentDownloads || 2)
    while (this.activeProcesses.size < maxConcurrent) {
      // Pick oldest queued job (FIFO)
      const nextJob = [...this.jobs].reverse().find((j) => j.stage === 'queued')
      if (!nextJob) break
      this.runJob(nextJob)
    }
  }

  private async runJob(job: DownloadJob): Promise<void> {
    job.stage = 'downloading'
    job.progress = 1
    this.emitUpdated(true)

    const stagingDir = path.join(app.getPath('userData'), 'staging', job.id)
    // Reserve active slot immediately using a placeholder until spawned
    this.activeProcesses.set(job.id, null as unknown as ChildProcess)

    try {
      await fsp.mkdir(stagingDir, { recursive: true })
      const { ytdlpPath, ffmpegDir, jsRuntimeArgs, cookieArgs } = await this.binaryManager.getPaths()
      const settings = this.store.getSettings()

      const audioQualityArg =
        job.format === 'flac' || job.format === 'opus' || job.quality === 'best'
          ? '0'
          : job.quality.toUpperCase()

      const outTemplate = path.join(stagingDir, 'track.%(ext)s')
      const args: string[] = [
        '--no-playlist',
        ...jsRuntimeArgs,
        ...cookieArgs,
        '--ffmpeg-location',
        ffmpegDir,
        '-f',
        'bestaudio/best',
        '--extract-audio',
        '--audio-format',
        job.format,
        '--audio-quality',
        audioQualityArg,
        '--embed-metadata',
        '--embed-thumbnail',
        '--convert-thumbnails',
        'jpg'
      ]

      if (settings.squareCoverArt) {
        // Comma-free algebraic min(iw,ih) = (iw+ih-abs(iw-ih))/2 avoids yt-dlp shlex.split stripping escapes
        args.push('--ppa', 'ThumbnailsConvertor:-vf crop=(iw+ih-abs(iw-ih))/2:(iw+ih-abs(iw-ih))/2')
      }

      args.push(
        '--newline',
        '--progress-template',
        'download:PROGRESS|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
        '-o',
        outTemplate,
        job.sourceUrl
      )

      await new Promise<void>((resolve, reject) => {
        if (job.stage === 'cancelled') {
          resolve()
          return
        }

        const proc = spawn(ytdlpPath, args, { windowsHide: true })
        this.activeProcesses.set(job.id, proc)

        let stderrTail = ''

        const handleLine = (line: string): void => {
          const trimmed = line.trim()
          if (!trimmed) return

          if (trimmed.startsWith('PROGRESS|')) {
            const parts = trimmed.split('|')
            const pctStr = (parts[1] || '').replace('%', '').trim()
            const pct = parseFloat(pctStr)
            if (!isNaN(pct)) {
              job.progress = Math.min(95, Math.max(job.progress, Math.round(pct * 0.9)))
            }
            const speed = (parts[2] || '').trim()
            const eta = (parts[3] || '').trim()
            if (speed && speed !== 'Unknown B/s' && speed !== 'N/A') job.speed = speed
            if (eta && eta !== 'Unknown' && eta !== 'N/A') job.eta = eta
            this.emitUpdated()
          } else if (
            trimmed.includes('[ExtractAudio]') ||
            trimmed.includes('[Metadata]') ||
            trimmed.includes('[EmbedThumbnail]') ||
            trimmed.includes('[ThumbnailsConvertor]')
          ) {
            job.stage = 'processing'
            job.progress = Math.max(job.progress, 94)
            job.speed = undefined
            job.eta = undefined
            this.emitUpdated()
          }
        }

        let stdoutBuf = ''
        proc.stdout.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf-8')
          const lines = stdoutBuf.split(/\r?\n/)
          stdoutBuf = lines.pop() || ''
          for (const line of lines) handleLine(line)
        })

        proc.stderr.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-1500)
        })

        proc.on('error', (err) => reject(err))
        proc.on('close', (code) => {
          if (job.stage === 'cancelled') {
            resolve()
            return
          }
          if (code === 0) {
            resolve()
          } else {
            const lastErrLine =
              stderrTail
                .trim()
                .split(/\r?\n/)
                .reverse()
                .find((l) => l.toLowerCase().includes('error')) ||
              stderrTail.trim().slice(-300) ||
              `yt-dlp exited with code ${code}`
            reject(new Error(lastErrLine))
          }
        })
      })

      if ((job.stage as string) === 'cancelled') {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
        return
      }

      // Locate extracted audio file inside stagingDir
      const files = await fsp.readdir(stagingDir)
      const audioFile = files.find((f) => {
        const ext = path.extname(f).toLowerCase()
        return ['.flac', '.mp3', '.m4a', '.opus', '.ogg', '.aac', '.wav'].includes(ext)
      })

      if (!audioFile) {
        throw new Error('Converted audio file was not produced in staging directory.')
      }

      let isSingleRelease: boolean | undefined
      let resolvedTrackNum = job.trackNumber
      let resolvedAlbumName = job.album

      if (job.albumId) {
        const albumInfo = await this.searchService.inspectReleaseByAlbumId(job.albumId, job.videoId)
        if (albumInfo) {
          isSingleRelease = albumInfo.isSingle
          if (!resolvedTrackNum && albumInfo.trackNumber) {
            resolvedTrackNum = albumInfo.trackNumber
          }
          if (albumInfo.albumName && !albumInfo.isSingle) {
            resolvedAlbumName = albumInfo.albumName
          }
        }
      }

      const stagedAudioPath = path.join(stagingDir, audioFile)
      const importedTrack = await this.libraryService.importDownloadedTrack({
        tempFilePath: stagedAudioPath,
        sourceVideoId: job.videoId,
        sourceUrl: job.sourceUrl,
        fallbackTitle: job.title,
        fallbackArtist: job.artist,
        fallbackAlbum: resolvedAlbumName,
        fallbackTrackNumber: resolvedTrackNum,
        isSingleRelease,
        thumbnailUrl: job.thumbnailUrl,
        targetPlaylistName: job.targetPlaylistName
      })

      job.stage = 'completed'
      job.progress = 100
      job.speed = undefined
      job.eta = undefined
      job.outputPath = importedTrack.filePath
      job.libraryTrackId = importedTrack.id
      job.completedAt = new Date().toISOString()

      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    } catch (err: unknown) {
      if ((job.stage as string) !== 'cancelled') {
        job.stage = 'failed'
        job.error = err instanceof Error ? err.message : String(err)
        job.speed = undefined
        job.eta = undefined
      }
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    } finally {
      this.activeProcesses.delete(job.id)
      this.emitUpdated(true)
      if (fs.existsSync(stagingDir)) {
        fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      }
      this.pumpQueue()
    }
  }
}

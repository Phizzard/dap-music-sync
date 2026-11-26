import type { LibraryTrack, PlayableItem, RemoteTrack } from '@shared/types'

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

export function formatDurationSec(sec?: number): string {
  if (!sec || isNaN(sec) || sec <= 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function isLikelyYoutubeUrl(input: string): boolean {
  const trimmed = input.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  try {
    const u = new URL(trimmed)
    const host = u.hostname.toLowerCase()
    return (
      host.includes('youtube.com') ||
      host.includes('youtu.be') ||
      host.includes('youtube-nocookie.com')
    )
  } catch {
    return false
  }
}

export function remoteTrackToPlayable(track: RemoteTrack): PlayableItem {
  return {
    id: `remote:${track.videoId}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    thumbnailUrl: track.thumbnailUrl,
    durationSec: track.durationSec,
    source: 'remote',
    videoId: track.videoId,
    remoteUrl: track.url,
    libraryTrackId: track.libraryTrackId,
    streamUri: `ytm-stream://track/${encodeURIComponent(track.videoId)}`
  }
}

export function libraryTrackToPlayable(track: LibraryTrack): PlayableItem {
  return {
    id: `local:${track.id}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    thumbnailUrl: track.coverArtDataUrl || track.thumbnailUrl,
    durationSec: track.durationSec,
    source: 'local',
    videoId: track.sourceVideoId,
    libraryTrackId: track.id,
    streamUri: `ytm-local://track/${encodeURIComponent(track.id)}`
  }
}

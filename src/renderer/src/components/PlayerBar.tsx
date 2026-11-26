import React, { useEffect, useRef, useState } from 'react'
import {
  Check,
  Download,
  Loader2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Disc3
} from 'lucide-react'
import { useAppStore } from '../state/useAppStore'
import { formatDurationSec } from '../utils/format'

export const PlayerBar: React.FC = () => {
  const {
    currentTrack,
    streamBaseUrl,
    playbackQueue,
    queueIndex,
    isPlaying,
    isBuffering,
    playerError,
    tracks,
    setIsPlaying,
    setIsBuffering,
    setPlayerError,
    playNext,
    playPrev,
    enqueueRemoteTracks
  } = useAppStore()

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.85)
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack) return

    let cancelled = false
    setCurrentTime(0)
    setDuration(currentTrack.durationSec || 0)
    setPlayerError(null)
    setIsBuffering(true)

    const startPlayback = async (): Promise<void> => {
      const base = streamBaseUrl || (await window.api.getStreamBaseUrl())
      let resolvedAudioSrc = ''

      if (currentTrack.source === 'remote' && currentTrack.videoId) {
        const warm = await window.api.warmPreviewStream(currentTrack.videoId)
        if (cancelled) return
        if (!warm.ready) {
          setIsBuffering(false)
          setIsPlaying(false)
          setPlayerError(warm.error || 'Could not load stream preview')
          return
        }
        if (warm.durationSec) {
          setDuration(warm.durationSec)
        }
        resolvedAudioSrc =
          warm.streamUrl || `${base}/remote/${encodeURIComponent(currentTrack.videoId)}`
      } else if (currentTrack.source === 'local' && currentTrack.libraryTrackId) {
        resolvedAudioSrc = `${base}/local/${encodeURIComponent(currentTrack.libraryTrackId)}`
      } else {
        resolvedAudioSrc = currentTrack.streamUri
      }

      if (cancelled) return
      audio.src = resolvedAudioSrc
      audio.load()
      try {
        await audio.play()
        if (!cancelled) {
          setIsPlaying(true)
          setIsBuffering(false)
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setIsBuffering(false)
          setIsPlaying(false)
          setPlayerError(err instanceof Error ? err.message : 'Playback failed')
        }
      }
    }

    startPlayback()
    return () => {
      cancelled = true
    }
  }, [currentTrack?.id])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentTrack || !audio.src) return
    if (isPlaying && audio.paused && !isBuffering) {
      audio.play().catch(() => setIsPlaying(false))
    } else if (!isPlaying && !audio.paused) {
      audio.pause()
    }
  }, [isPlaying])

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = muted ? 0 : volume
    }
  }, [volume, muted])

  const ownedInLibrary =
    currentTrack?.source === 'local' ||
    Boolean(
      currentTrack?.videoId &&
        tracks.some((t) => t.sourceVideoId === currentTrack.videoId && !t.missingOnDisk)
    )

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const val = parseFloat(e.target.value)
    setCurrentTime(val)
    if (audioRef.current) {
      audioRef.current.currentTime = val
    }
  }

  return (
    <footer className="player-bar">
      <audio
        ref={audioRef}
        onTimeUpdate={() => {
          if (audioRef.current) setCurrentTime(audioRef.current.currentTime)
        }}
        onLoadedMetadata={() => {
          if (audioRef.current && isFinite(audioRef.current.duration) && audioRef.current.duration > 0) {
            setDuration(audioRef.current.duration)
          }
          setIsBuffering(false)
        }}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => {
          setIsBuffering(false)
          setIsPlaying(true)
        }}
        onPause={() => {
          if (audioRef.current && !audioRef.current.ended) {
            setIsPlaying(false)
          }
        }}
        onEnded={() => playNext()}
        onError={() => {
          setIsBuffering(false)
          setIsPlaying(false)
          setPlayerError('Stream unavailable or interrupted.')
        }}
      />

      {/* Left: Track Info */}
      <div className="player-track">
        {currentTrack ? (
          <>
            <div className="player-thumb">
              {currentTrack.thumbnailUrl ? (
                <img src={currentTrack.thumbnailUrl} alt={currentTrack.title} />
              ) : (
                <Disc3 size={24} className="muted-icon" />
              )}
            </div>
            <div className="player-meta">
              <div className="player-title-row">
                <span className="player-title" title={currentTrack.title}>
                  {currentTrack.title}
                </span>
                <span
                  className={`source-pill ${currentTrack.source === 'local' ? 'local' : 'preview'}`}
                >
                  {currentTrack.source === 'local' ? 'LIBRARY' : 'PREVIEW'}
                </span>
              </div>
              <div className="player-artist">
                {currentTrack.artist}
                {currentTrack.album ? ` · ${currentTrack.album}` : ''}
              </div>
              {playerError && <div className="player-error">{playerError}</div>}
            </div>
          </>
        ) : (
          <div className="player-empty">
            <Disc3 size={22} className="muted-icon" />
            <span>Click play on any search result or library song to listen</span>
          </div>
        )}
      </div>

      {/* Center: Transport & Seek */}
      <div className="player-center">
        <div className="player-controls">
          <button
            className="icon-btn"
            disabled={!currentTrack || queueIndex <= 0}
            onClick={playPrev}
            title="Previous"
          >
            <SkipBack size={18} />
          </button>
          <button
            className="play-main-btn"
            disabled={!currentTrack}
            onClick={() => setIsPlaying(!isPlaying)}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isBuffering ? (
              <Loader2 size={20} className="spin" />
            ) : isPlaying ? (
              <Pause size={20} />
            ) : (
              <Play size={20} style={{ marginLeft: 2 }} />
            )}
          </button>
          <button
            className="icon-btn"
            disabled={!currentTrack || queueIndex >= playbackQueue.length - 1}
            onClick={playNext}
            title="Next"
          >
            <SkipForward size={18} />
          </button>
        </div>

        <div className="player-scrubber">
          <span className="time-label">{formatDurationSec(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={0.25}
            value={Math.min(currentTime, Math.max(duration, 1))}
            disabled={!currentTrack || duration <= 0}
            onChange={handleSeek}
          />
          <span className="time-label">{formatDurationSec(duration)}</span>
        </div>
      </div>

      {/* Right: Quick Download & Volume */}
      <div className="player-right">
        {currentTrack && currentTrack.source === 'remote' && currentTrack.videoId && (
          ownedInLibrary ? (
            <span className="owned-pill" title="Already saved in your Library">
              <Check size={14} /> Saved
            </span>
          ) : (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() =>
                enqueueRemoteTracks([
                  {
                    videoId: currentTrack.videoId!,
                    url:
                      currentTrack.remoteUrl ||
                      `https://music.youtube.com/watch?v=${currentTrack.videoId}`,
                    title: currentTrack.title,
                    artist: currentTrack.artist,
                    album: currentTrack.album,
                    durationSec: currentTrack.durationSec,
                    thumbnailUrl: currentTrack.thumbnailUrl
                  }
                ])
              }
            >
              <Download size={14} /> Save to Library
            </button>
          )
        )}

        <div className="volume-box">
          <button
            className="icon-btn"
            onClick={() => setMuted(!muted)}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : volume}
            onChange={(e) => {
              setMuted(false)
              setVolume(parseFloat(e.target.value))
            }}
          />
        </div>
      </div>
    </footer>
  )
}

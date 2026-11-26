import React, { useMemo, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Disc,
  Download,
  Link2,
  ListMusic,
  Loader2,
  Music2,
  Pause,
  Play,
  Search
} from 'lucide-react'
import type {
  AudioFormat,
  AudioQuality,
  RemoteCollection,
  RemoteTrack,
  SearchFilter,
  SearchResults
} from '@shared/types'
import { useAppStore } from '../state/useAppStore'
import {
  isLikelyYoutubeUrl,
  libraryTrackToPlayable,
  remoteTrackToPlayable
} from '../utils/format'

export const DiscoverView: React.FC = () => {
  const {
    tracks: libraryTracks,
    downloadJobs,
    binaryStatus,
    quickFormat,
    quickQuality,
    setQuickFormat,
    setQuickQuality,
    currentTrack,
    isPlaying,
    setIsPlaying,
    playItem,
    enqueueRemoteTracks,
    pushToast,
    setActiveTab
  } = useAppStore()

  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<SearchFilter>('all')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [singleResolvedTrack, setSingleResolvedTrack] = useState<RemoteTrack | null>(null)

  // Collection (Album / Playlist) detail state
  const [activeCollection, setActiveCollection] = useState<RemoteCollection | null>(null)
  const [loadingCollection, setLoadingCollection] = useState(false)
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(new Set())
  const [saveAsLibraryPlaylist, setSaveAsLibraryPlaylist] = useState(false)

  const isUrlInput = useMemo(() => isLikelyYoutubeUrl(query), [query])

  const ownedByVideoId = useMemo(() => {
    const map = new Map<string, (typeof libraryTracks)[number]>()
    for (const t of libraryTracks) {
      if (t.sourceVideoId && !t.missingOnDisk) {
        map.set(t.sourceVideoId, t)
      }
    }
    return map
  }, [libraryTracks])

  const activeJobByVideoId = useMemo(() => {
    const map = new Map<string, (typeof downloadJobs)[number]>()
    for (const j of downloadJobs) {
      if (j.stage === 'queued' || j.stage === 'downloading' || j.stage === 'processing') {
        map.set(j.videoId, j)
      }
    }
    return map
  }, [downloadJobs])

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) return

    setError(null)
    setLoading(true)
    setActiveCollection(null)
    setSingleResolvedTrack(null)

    try {
      if (isLikelyYoutubeUrl(trimmed)) {
        const resolved = await window.api.resolveUrl(trimmed)
        if (resolved.kind === 'track' && resolved.track) {
          setSingleResolvedTrack(resolved.track)
          setResults(null)
        } else if (resolved.kind === 'collection' && resolved.collection) {
          const col = resolved.collection
          setActiveCollection(col)
          const allIds = new Set((col.tracks || []).map((t) => t.videoId))
          setSelectedVideoIds(allIds)
          setSaveAsLibraryPlaylist(col.type === 'playlist')
        }
      } else {
        const searchRes = await window.api.searchMusic(trimmed)
        setResults(searchRes)
        setFilter('all')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const openCollection = async (col: RemoteCollection): Promise<void> => {
    setError(null)
    setLoadingCollection(true)
    try {
      const full = await window.api.resolveCollection(col)
      setActiveCollection(full)
      const unownedOrAll = (full.tracks || [])
        .filter((t) => !ownedByVideoId.has(t.videoId))
        .map((t) => t.videoId)
      setSelectedVideoIds(
        new Set(
          unownedOrAll.length > 0 ? unownedOrAll : (full.tracks || []).map((t) => t.videoId)
        )
      )
      setSaveAsLibraryPlaylist(full.type === 'playlist')
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to load collection tracks', 'error')
    } finally {
      setLoadingCollection(false)
    }
  }

  const handlePlayRemoteOrLocal = (track: RemoteTrack, contextList?: RemoteTrack[]): void => {
    const localCopy = ownedByVideoId.get(track.videoId)
    const targetPlayable = localCopy
      ? libraryTrackToPlayable(localCopy)
      : remoteTrackToPlayable(track)

    if (currentTrack?.id === targetPlayable.id) {
      setIsPlaying(!isPlaying)
      return
    }

    const queue = (contextList || [track]).map((t) => {
      const owned = ownedByVideoId.get(t.videoId)
      return owned ? libraryTrackToPlayable(owned) : remoteTrackToPlayable(t)
    })
    playItem(targetPlayable, queue)
  }

  const renderTrackRow = (
    track: RemoteTrack,
    contextList: RemoteTrack[],
    opts?: { selectable?: boolean; indexNum?: number }
  ): React.ReactNode => {
    const owned = ownedByVideoId.get(track.videoId)
    const activeJob = activeJobByVideoId.get(track.videoId)
    const playableId = owned ? `local:${owned.id}` : `remote:${track.videoId}`
    const isCurrent = currentTrack?.id === playableId
    const checked = selectedVideoIds.has(track.videoId)

    return (
      <div key={`${track.videoId}-${opts?.indexNum ?? ''}`} className={`track-row ${isCurrent ? 'playing' : ''}`}>
        {opts?.selectable && (
          <label className="checkbox-cell">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                const next = new Set(selectedVideoIds)
                if (e.target.checked) next.add(track.videoId)
                else next.delete(track.videoId)
                setSelectedVideoIds(next)
              }}
            />
          </label>
        )}

        <button
          className="thumb-play-btn"
          onClick={() => handlePlayRemoteOrLocal(track, contextList)}
          title={owned ? 'Play from Local Library' : 'Stream Preview'}
        >
          {track.thumbnailUrl ? (
            <img src={track.thumbnailUrl} alt={track.title} loading="lazy" />
          ) : (
            <div className="thumb-placeholder">
              <Music2 size={18} />
            </div>
          )}
          <div className="thumb-overlay">
            {isCurrent && isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </div>
        </button>

        <div className="track-info">
          <div className="track-title">
            {opts?.indexNum !== undefined && (
              <span className="track-num">{String(opts.indexNum).padStart(2, '0')}.</span>
            )}
            <span>{track.title}</span>
          </div>
          <div className="track-sub">
            <span>{track.artist}</span>
            {track.album && <span> · {track.album}</span>}
          </div>
        </div>

        <div className="track-duration">{track.durationText || ''}</div>

        <div className="track-actions">
          {activeJob ? (
            <span className="status-pill active" onClick={() => setActiveTab('downloads')}>
              <Loader2 size={13} className="spin" />
              {activeJob.stage === 'processing'
                ? 'Tagging...'
                : `${activeJob.progress}%`}
            </span>
          ) : owned ? (
            <span
              className="owned-pill clickable"
              onClick={() => handlePlayRemoteOrLocal(track, contextList)}
              title="Saved in your Library — click to play local file"
            >
              <Check size={13} /> In Library ({owned.format})
            </span>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => enqueueRemoteTracks([track])}
            >
              <Download size={14} /> Download
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="view-container">
      {/* Binary warning banner if missing */}
      {binaryStatus && !binaryStatus.ready && (
        <div className="alert-banner warning">
          <div>
            <strong>CLI Tools Needed:</strong>{' '}
            {!binaryStatus.ytdlp.found && 'yt-dlp '}
            {!binaryStatus.ffmpeg.found && 'ffmpeg '}
            not detected yet. Install them with one click in Settings before downloading or previewing.
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setActiveTab('settings')}>
            Open Setup
          </button>
        </div>
      )}

      {/* Top Search / URL Omnibar */}
      <form className="omnibar-card" onSubmit={handleSubmit}>
        <div className="omnibar-input-wrap">
          {isUrlInput ? (
            <Link2 size={19} className="accent-icon" />
          ) : (
            <Search size={19} className="muted-icon" />
          )}
          <input
            type="text"
            className="omnibar-input"
            placeholder="Search songs, albums, playlists — or paste a YouTube Music / YouTube URL..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <span className={`mode-chip ${isUrlInput ? 'url' : 'search'}`}>
              {isUrlInput ? 'Direct URL' : 'YT Music Search'}
            </span>
          )}
        </div>

        <div className="omnibar-controls">
          <div className="format-selector" title="Target Audio Format">
            <label>Format</label>
            <select
              value={quickFormat}
              onChange={(e) => setQuickFormat(e.target.value as AudioFormat)}
            >
              <option value="flac">FLAC (Lossless)</option>
              <option value="mp3">MP3</option>
              <option value="m4a">M4A (AAC)</option>
              <option value="opus">Opus</option>
            </select>
          </div>

          {(quickFormat === 'mp3' || quickFormat === 'm4a') && (
            <div className="format-selector" title="Target Bitrate">
              <label>Quality</label>
              <select
                value={quickQuality}
                onChange={(e) => setQuickQuality(e.target.value as AudioQuality)}
              >
                <option value="best">Best (V0)</option>
                <option value="320k">320 kbps</option>
                <option value="256k">256 kbps</option>
                <option value="192k">192 kbps</option>
              </select>
            </div>
          )}

          <button type="submit" className="btn btn-primary" disabled={loading || !query.trim()}>
            {loading ? (
              <>
                <Loader2 size={16} className="spin" /> {isUrlInput ? 'Inspecting...' : 'Searching...'}
              </>
            ) : isUrlInput ? (
              'Load URL'
            ) : (
              'Search'
            )}
          </button>
        </div>
      </form>

      {error && <div className="alert-banner error">{error}</div>}

      {loadingCollection && (
        <div className="empty-state">
          <Loader2 size={28} className="spin accent-icon" />
          <p>Loading tracklist from YouTube Music...</p>
        </div>
      )}

      {/* Collection Detail View (Album or Playlist) */}
      {!loadingCollection && activeCollection && (
        <div className="collection-panel">
          <div className="collection-top-nav">
            {results && (
              <button className="btn btn-ghost btn-sm" onClick={() => setActiveCollection(null)}>
                <ArrowLeft size={15} /> Back to Search Results
              </button>
            )}
          </div>

          <div className="collection-header">
            <div className="collection-cover">
              {activeCollection.thumbnailUrl ? (
                <img src={activeCollection.thumbnailUrl} alt={activeCollection.title} />
              ) : (
                <Disc size={44} className="muted-icon" />
              )}
            </div>

            <div className="collection-meta">
              <span className="badge">{activeCollection.type.toUpperCase()}</span>
              <h2>{activeCollection.title}</h2>
              <p className="subtext">
                {activeCollection.author || 'YouTube Music'}
                {activeCollection.year ? ` · ${activeCollection.year}` : ''}
                {activeCollection.tracks ? ` · ${activeCollection.tracks.length} tracks` : ''}
              </p>

              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={saveAsLibraryPlaylist}
                  onChange={(e) => setSaveAsLibraryPlaylist(e.target.checked)}
                />
                <span>
                  Also create/update Library Playlist <strong>"{activeCollection.title}"</strong>
                </span>
              </label>

              <div className="collection-actions">
                <button
                  className="btn btn-primary"
                  disabled={selectedVideoIds.size === 0}
                  onClick={() => {
                    const chosen = (activeCollection.tracks || []).filter((t) =>
                      selectedVideoIds.has(t.videoId)
                    )
                    enqueueRemoteTracks(chosen, {
                      targetPlaylistName: saveAsLibraryPlaylist ? activeCollection.title : undefined
                    })
                  }}
                >
                  <Download size={16} /> Download Selected ({selectedVideoIds.size})
                </button>

                {activeCollection.tracks && activeCollection.tracks.length > 0 && (
                  <button
                    className="btn btn-secondary"
                    onClick={() =>
                      handlePlayRemoteOrLocal(activeCollection.tracks![0], activeCollection.tracks)
                    }
                  >
                    <Play size={16} /> Preview All
                  </button>
                )}

                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const tracks = activeCollection.tracks || []
                    if (selectedVideoIds.size === tracks.length) {
                      setSelectedVideoIds(new Set())
                    } else {
                      setSelectedVideoIds(new Set(tracks.map((t) => t.videoId)))
                    }
                  }}
                >
                  {selectedVideoIds.size === (activeCollection.tracks?.length || 0)
                    ? 'Deselect All'
                    : 'Select All'}
                </button>
              </div>
            </div>
          </div>

          <div className="track-list">
            {(activeCollection.tracks || []).map((t, idx) =>
              renderTrackRow(t, activeCollection.tracks || [], {
                selectable: true,
                indexNum: t.trackNumber ?? idx + 1
              })
            )}
          </div>
        </div>
      )}

      {/* Single Pasted Track URL Result */}
      {!loadingCollection && !activeCollection && singleResolvedTrack && (
        <div className="section-block">
          <div className="section-header">
            <h3>Resolved Track from URL</h3>
          </div>
          <div className="track-list">
            {renderTrackRow(singleResolvedTrack, [singleResolvedTrack])}
          </div>
        </div>
      )}

      {/* Search Results */}
      {!loadingCollection && !activeCollection && results && (
        <div className="results-wrapper">
          <div className="filter-pills">
            <button
              className={`pill ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All
            </button>
            <button
              className={`pill ${filter === 'songs' ? 'active' : ''}`}
              onClick={() => setFilter('songs')}
            >
              Songs ({results.songs.length})
            </button>
            {results.albums.length > 0 && (
              <button
                className={`pill ${filter === 'albums' ? 'active' : ''}`}
                onClick={() => setFilter('albums')}
              >
                Albums ({results.albums.length})
              </button>
            )}
            {results.playlists.length > 0 && (
              <button
                className={`pill ${filter === 'playlists' ? 'active' : ''}`}
                onClick={() => setFilter('playlists')}
              >
                Playlists ({results.playlists.length})
              </button>
            )}
          </div>

          {(filter === 'all' || filter === 'songs') && results.songs.length > 0 && (
            <section className="section-block">
              <div className="section-header">
                <h3>Songs</h3>
                <span className="hint-text">Click artwork to preview stream before saving</span>
              </div>
              <div className="track-list">
                {(filter === 'all' ? results.songs.slice(0, 10) : results.songs).map((s) =>
                  renderTrackRow(s, results.songs)
                )}
              </div>
            </section>
          )}

          {(filter === 'all' || filter === 'albums') && results.albums.length > 0 && (
            <section className="section-block">
              <div className="section-header">
                <h3>Albums</h3>
              </div>
              <div className="card-grid">
                {results.albums.map((alb) => (
                  <div
                    key={alb.id}
                    className="media-card"
                    onClick={() => openCollection(alb)}
                  >
                    <div className="media-card-art">
                      {alb.thumbnailUrl ? (
                        <img src={alb.thumbnailUrl} alt={alb.title} loading="lazy" />
                      ) : (
                        <Disc size={36} className="muted-icon" />
                      )}
                    </div>
                    <div className="media-card-title" title={alb.title}>
                      {alb.title}
                    </div>
                    <div className="media-card-sub">
                      {alb.author || 'Album'}
                      {alb.year ? ` · ${alb.year}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(filter === 'all' || filter === 'playlists') && results.playlists.length > 0 && (
            <section className="section-block">
              <div className="section-header">
                <h3>Community & Featured Playlists</h3>
              </div>
              <div className="card-grid">
                {results.playlists.map((pl) => (
                  <div
                    key={pl.id}
                    className="media-card"
                    onClick={() => openCollection(pl)}
                  >
                    <div className="media-card-art">
                      {pl.thumbnailUrl ? (
                        <img src={pl.thumbnailUrl} alt={pl.title} loading="lazy" />
                      ) : (
                        <ListMusic size={36} className="muted-icon" />
                      )}
                    </div>
                    <div className="media-card-title" title={pl.title}>
                      {pl.title}
                    </div>
                    <div className="media-card-sub">{pl.author || 'Playlist'}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {results.songs.length === 0 &&
            results.albums.length === 0 &&
            results.playlists.length === 0 && (
              <div className="empty-state">
                <Search size={32} className="muted-icon" />
                <h3>No matches found</h3>
                <p>Try a different song title, artist name, or paste a direct YouTube Music URL.</p>
              </div>
            )}
        </div>
      )}

      {/* Initial Empty State */}
      {!loading && !loadingCollection && !results && !singleResolvedTrack && !activeCollection && (
        <div className="empty-state hero">
          <div className="hero-icon-ring">
            <Music2 size={34} />
          </div>
          <h2>Search YouTube Music or Paste Any Link</h2>
          <p>
            Audition full-length previews right in the bottom player, download tagged{' '}
            <strong>FLAC / MP3 / M4A / Opus</strong> tracks with square album art into your Library,
            and sync them straight to your DAP.
          </p>
        </div>
      )}
    </div>
  )
}

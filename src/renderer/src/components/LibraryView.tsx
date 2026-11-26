import React, { useMemo, useState } from 'react'
import {
  ArrowLeft,
  Disc,
  FolderInput,
  FolderOpen,
  ListMusic,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  User
} from 'lucide-react'
import type { LibraryPlaylist, LibraryTrack } from '@shared/types'
import { useAppStore } from '../state/useAppStore'
import { formatBytes, formatDurationSec, libraryTrackToPlayable } from '../utils/format'

type LibrarySubTab = 'songs' | 'albums' | 'artists' | 'playlists'
type SortKey = 'recent' | 'title' | 'artist' | 'album'

export const LibraryView: React.FC = () => {
  const {
    tracks,
    playlists,
    settings,
    currentTrack,
    isPlaying,
    setIsPlaying,
    playItem,
    pushToast
  } = useAppStore()

  const [subTab, setSubTab] = useState<LibrarySubTab>('songs')
  const [filterText, setFilterText] = useState('')
  const [sortBy, setSortBy] = useState<SortKey>('recent')
  const [scanning, setScanning] = useState(false)

  // Drill-down states
  const [selectedAlbumKey, setSelectedAlbumKey] = useState<string | null>(null)
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null)
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null)
  const [newPlaylistName, setNewPlaylistName] = useState('')

  // Add to playlist popover trackId
  const [playlistMenuTrackId, setPlaylistMenuTrackId] = useState<string | null>(null)

  const filteredTracks = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    const base = q
      ? tracks.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.artist.toLowerCase().includes(q) ||
            t.album.toLowerCase().includes(q)
        )
      : [...tracks]

    base.sort((a, b) => {
      if (sortBy === 'title') return a.title.localeCompare(b.title)
      if (sortBy === 'artist') return a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album)
      if (sortBy === 'album')
        return a.album.localeCompare(b.album) || (a.trackNumber || 0) - (b.trackNumber || 0)
      return b.addedAt.localeCompare(a.addedAt)
    })
    return base
  }, [tracks, filterText, sortBy])

  const albums = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string
        album: string
        artist: string
        cover?: string
        year?: number
        tracks: LibraryTrack[]
      }
    >()
    for (const t of filteredTracks) {
      const key = `${t.artist}|||${t.album}`
      const existing = map.get(key)
      if (existing) {
        existing.tracks.push(t)
        if (!existing.cover && (t.coverArtDataUrl || t.thumbnailUrl)) {
          existing.cover = t.coverArtDataUrl || t.thumbnailUrl
        }
      } else {
        map.set(key, {
          key,
          album: t.album || 'Singles',
          artist: t.artist || 'Unknown Artist',
          cover: t.coverArtDataUrl || t.thumbnailUrl,
          year: t.year,
          tracks: [t]
        })
      }
    }
    return [...map.values()].map((alb) => ({
      ...alb,
      tracks: alb.tracks.sort((a, b) => (a.trackNumber || 999) - (b.trackNumber || 999))
    }))
  }, [filteredTracks])

  const artists = useMemo(() => {
    const map = new Map<string, { artist: string; cover?: string; tracks: LibraryTrack[]; albums: Set<string> }>()
    for (const t of filteredTracks) {
      const name = t.artist || 'Unknown Artist'
      const existing = map.get(name)
      if (existing) {
        existing.tracks.push(t)
        existing.albums.add(t.album)
        if (!existing.cover && (t.coverArtDataUrl || t.thumbnailUrl)) {
          existing.cover = t.coverArtDataUrl || t.thumbnailUrl
        }
      } else {
        map.set(name, {
          artist: name,
          cover: t.coverArtDataUrl || t.thumbnailUrl,
          tracks: [t],
          albums: new Set([t.album])
        })
      }
    }
    return [...map.values()].sort((a, b) => a.artist.localeCompare(b.artist))
  }, [filteredTracks])

  const playTrackList = (target: LibraryTrack, list: LibraryTrack[]): void => {
    const playable = libraryTrackToPlayable(target)
    if (currentTrack?.id === playable.id) {
      setIsPlaying(!isPlaying)
      return
    }
    playItem(
      playable,
      list.filter((t) => !t.missingOnDisk).map(libraryTrackToPlayable)
    )
  }

  const handleRescan = async (): Promise<void> => {
    setScanning(true)
    try {
      const res = await window.api.scanLibraryFolder()
      pushToast(
        `Scan complete: ${res.added} added, ${res.updated} updated, ${res.missing} missing`,
        'success'
      )
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Scan failed', 'error')
    } finally {
      setScanning(false)
    }
  }

  const handleImportExternal = async (): Promise<void> => {
    const folder = await window.api.pickDirectory('Import Music Folder into Library')
    if (!folder) return
    setScanning(true)
    try {
      const res = await window.api.scanLibraryFolder(folder)
      pushToast(`Imported ${res.added} audio tracks into your Library`, 'success')
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Import failed', 'error')
    } finally {
      setScanning(false)
    }
  }

  const handleCreatePlaylist = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!newPlaylistName.trim()) return
    try {
      const created = await window.api.createPlaylist(newPlaylistName.trim())
      setNewPlaylistName('')
      setSelectedPlaylistId(created.id)
      pushToast(`Created playlist "${created.name}"`, 'success')
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Could not create playlist', 'error')
    }
  }

  const renderLibraryTrackRow = (
    t: LibraryTrack,
    contextTracks: LibraryTrack[],
    playlistContext?: LibraryPlaylist
  ): React.ReactNode => {
    const isCurrent = currentTrack?.id === `local:${t.id}`
    const cover = t.coverArtDataUrl || t.thumbnailUrl

    return (
      <div key={t.id} className={`track-row ${isCurrent ? 'playing' : ''}`}>
        <button
          className="thumb-play-btn"
          disabled={t.missingOnDisk}
          onClick={() => playTrackList(t, contextTracks)}
          title={t.missingOnDisk ? 'File missing on disk' : 'Play local file'}
        >
          {cover ? (
            <img src={cover} alt={t.title} loading="lazy" />
          ) : (
            <div className="thumb-placeholder">
              <Music size={18} />
            </div>
          )}
          <div className="thumb-overlay">
            {isCurrent && isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </div>
        </button>

        <div className="track-info">
          <div className="track-title">
            {t.trackNumber ? (
              <span className="track-num">{String(t.trackNumber).padStart(2, '0')}.</span>
            ) : null}
            <span>{t.title}</span>
            {t.missingOnDisk && <span className="badge danger">Missing File</span>}
          </div>
          <div className="track-sub">
            <span>{t.artist}</span>
            <span> · {t.album}</span>
          </div>
        </div>

        <div className="track-tech">
          <span className="tech-pill">
            {t.format}
            {t.bitrateKbps ? ` · ${t.bitrateKbps}k` : ''}
          </span>
          <span className="size-label">{formatBytes(t.fileSize)}</span>
        </div>

        <div className="track-duration">{formatDurationSec(t.durationSec)}</div>

        <div className="track-actions relative">
          <button
            className="icon-btn"
            title="Add to Playlist"
            onClick={() =>
              setPlaylistMenuTrackId(playlistMenuTrackId === t.id ? null : t.id)
            }
          >
            <Plus size={16} />
          </button>

          {playlistMenuTrackId === t.id && (
            <div className="popover-menu">
              <div className="popover-title">Add to Playlist</div>
              {playlists.length === 0 ? (
                <div className="popover-empty">
                  No playlists yet. Create one in the Playlists tab.
                </div>
              ) : (
                playlists.map((pl) => (
                  <button
                    key={pl.id}
                    className="popover-item"
                    onClick={async () => {
                      await window.api.addTracksToPlaylist(pl.id, [t.id])
                      setPlaylistMenuTrackId(null)
                      pushToast(`Added to "${pl.name}"`, 'success')
                    }}
                  >
                    <ListMusic size={13} /> {pl.name}
                  </button>
                ))
              )}
            </div>
          )}

          <button
            className="icon-btn"
            title="Show in Explorer / Finder"
            onClick={() => window.api.showItemInFolder(t.filePath)}
          >
            <FolderOpen size={15} />
          </button>

          {playlistContext ? (
            <button
              className="icon-btn danger-hover"
              title="Remove from Playlist"
              onClick={() => window.api.removeTrackFromPlaylist(playlistContext.id, t.id)}
            >
              <Trash2 size={15} />
            </button>
          ) : (
            <button
              className="icon-btn danger-hover"
              title="Delete from Library & Disk"
              onClick={async () => {
                if (
                  window.confirm(
                    `Delete "${t.title}" from your Library and remove the audio file from disk?`
                  )
                ) {
                  await window.api.deleteLibraryTrack(t.id, true)
                  pushToast(`Deleted "${t.title}"`, 'info')
                }
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
    )
  }

  const activeAlbum = selectedAlbumKey ? albums.find((a) => a.key === selectedAlbumKey) : null
  const activeArtistObj = selectedArtist
    ? artists.find((a) => a.artist === selectedArtist)
    : null
  const activePlaylist = selectedPlaylistId
    ? playlists.find((p) => p.id === selectedPlaylistId)
    : null

  return (
    <div className="view-container">
      <div className="page-header">
        <div>
          <h1>My Music Library</h1>
          <p className="subtext">
            {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'} ·{' '}
            {formatBytes(tracks.reduce((acc, t) => acc + (t.fileSize || 0), 0))} stored in{' '}
            <code>{settings?.libraryRootPath || 'Library'}</code>
          </p>
        </div>

        <div className="header-actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleImportExternal}
            disabled={scanning}
          >
            <FolderInput size={15} /> Import Folder
          </button>
          <button className="btn btn-ghost btn-sm" onClick={handleRescan} disabled={scanning}>
            <RefreshCw size={15} className={scanning ? 'spin' : ''} /> Rescan
          </button>
          {settings?.libraryRootPath && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => window.api.openPath(settings.libraryRootPath)}
            >
              <FolderOpen size={15} /> Open Folder
            </button>
          )}
        </div>
      </div>

      {/* Sub-navigation + Filter */}
      <div className="toolbar-row">
        <div className="filter-pills">
          <button
            className={`pill ${subTab === 'songs' ? 'active' : ''}`}
            onClick={() => {
              setSubTab('songs')
              setSelectedAlbumKey(null)
              setSelectedArtist(null)
              setSelectedPlaylistId(null)
            }}
          >
            Songs ({tracks.length})
          </button>
          <button
            className={`pill ${subTab === 'albums' ? 'active' : ''}`}
            onClick={() => {
              setSubTab('albums')
              setSelectedAlbumKey(null)
            }}
          >
            Albums ({albums.length})
          </button>
          <button
            className={`pill ${subTab === 'artists' ? 'active' : ''}`}
            onClick={() => {
              setSubTab('artists')
              setSelectedArtist(null)
            }}
          >
            Artists ({artists.length})
          </button>
          <button
            className={`pill ${subTab === 'playlists' ? 'active' : ''}`}
            onClick={() => {
              setSubTab('playlists')
              setSelectedPlaylistId(null)
            }}
          >
            Playlists ({playlists.length})
          </button>
        </div>

        <div className="toolbar-right">
          <div className="mini-search">
            <Search size={15} className="muted-icon" />
            <input
              type="text"
              placeholder="Filter library..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>

          {subTab === 'songs' && (
            <select
              className="select-sm"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
            >
              <option value="recent">Recently Added</option>
              <option value="title">Title (A–Z)</option>
              <option value="artist">Artist (A–Z)</option>
              <option value="album">Album</option>
            </select>
          )}

          {filteredTracks.length > 0 && subTab === 'songs' && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => playTrackList(filteredTracks[0], filteredTracks)}
            >
              <Play size={14} /> Play All
            </button>
          )}
        </div>
      </div>

      {/* Empty Library */}
      {tracks.length === 0 && subTab !== 'playlists' && (
        <div className="empty-state hero">
          <Disc size={38} className="muted-icon" />
          <h3>Your Library is Empty</h3>
          <p>
            Download tracks or albums from the <strong>Discover</strong> tab, or click{' '}
            <strong>Import Folder</strong> to add existing local music.
          </p>
        </div>
      )}

      {/* SONGS VIEW */}
      {subTab === 'songs' && tracks.length > 0 && (
        <div className="track-list">
          {filteredTracks.map((t) => renderLibraryTrackRow(t, filteredTracks))}
        </div>
      )}

      {/* ALBUMS VIEW */}
      {subTab === 'albums' && tracks.length > 0 && (
        activeAlbum ? (
          <div className="collection-panel">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setSelectedAlbumKey(null)}
            >
              <ArrowLeft size={15} /> All Albums
            </button>
            <div className="collection-header">
              <div className="collection-cover">
                {activeAlbum.cover ? (
                  <img src={activeAlbum.cover} alt={activeAlbum.album} />
                ) : (
                  <Disc size={44} className="muted-icon" />
                )}
              </div>
              <div className="collection-meta">
                <span className="badge">ALBUM</span>
                <h2>{activeAlbum.album}</h2>
                <p className="subtext">
                  {activeAlbum.artist} · {activeAlbum.tracks.length} tracks
                </p>
                <div className="collection-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => playTrackList(activeAlbum.tracks[0], activeAlbum.tracks)}
                  >
                    <Play size={16} /> Play Album
                  </button>
                </div>
              </div>
            </div>
            <div className="track-list">
              {activeAlbum.tracks.map((t) => renderLibraryTrackRow(t, activeAlbum.tracks))}
            </div>
          </div>
        ) : (
          <div className="card-grid">
            {albums.map((alb) => (
              <div
                key={alb.key}
                className="media-card"
                onClick={() => setSelectedAlbumKey(alb.key)}
              >
                <div className="media-card-art">
                  {alb.cover ? (
                    <img src={alb.cover} alt={alb.album} loading="lazy" />
                  ) : (
                    <Disc size={36} className="muted-icon" />
                  )}
                </div>
                <div className="media-card-title">{alb.album}</div>
                <div className="media-card-sub">
                  {alb.artist} · {alb.tracks.length} songs
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* ARTISTS VIEW */}
      {subTab === 'artists' && tracks.length > 0 && (
        activeArtistObj ? (
          <div className="collection-panel">
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectedArtist(null)}>
              <ArrowLeft size={15} /> All Artists
            </button>
            <div className="collection-header">
              <div className="collection-cover">
                {activeArtistObj.cover ? (
                  <img src={activeArtistObj.cover} alt={activeArtistObj.artist} />
                ) : (
                  <User size={44} className="muted-icon" />
                )}
              </div>
              <div className="collection-meta">
                <span className="badge">ARTIST</span>
                <h2>{activeArtistObj.artist}</h2>
                <p className="subtext">
                  {activeArtistObj.albums.size} albums · {activeArtistObj.tracks.length} tracks
                </p>
                <div className="collection-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      playTrackList(activeArtistObj.tracks[0], activeArtistObj.tracks)
                    }
                  >
                    <Play size={16} /> Play Artist
                  </button>
                </div>
              </div>
            </div>
            <div className="track-list">
              {activeArtistObj.tracks.map((t) =>
                renderLibraryTrackRow(t, activeArtistObj.tracks)
              )}
            </div>
          </div>
        ) : (
          <div className="card-grid">
            {artists.map((art) => (
              <div
                key={art.artist}
                className="media-card"
                onClick={() => setSelectedArtist(art.artist)}
              >
                <div className="media-card-art">
                  {art.cover ? (
                    <img src={art.cover} alt={art.artist} loading="lazy" />
                  ) : (
                    <User size={36} className="muted-icon" />
                  )}
                </div>
                <div className="media-card-title">{art.artist}</div>
                <div className="media-card-sub">
                  {art.albums.size} albums · {art.tracks.length} songs
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* PLAYLISTS VIEW */}
      {subTab === 'playlists' && (
        <div>
          <form className="inline-create-bar" onSubmit={handleCreatePlaylist}>
            <input
              type="text"
              placeholder="New playlist name (e.g., Gym Mix, Roadtrip, Reference Tracks)..."
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!newPlaylistName.trim()}
            >
              <Plus size={15} /> Create Playlist
            </button>
          </form>

          {activePlaylist ? (
            <div className="collection-panel">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setSelectedPlaylistId(null)}
              >
                <ArrowLeft size={15} /> All Playlists
              </button>
              <div className="collection-header">
                <div className="collection-cover">
                  <ListMusic size={42} className="accent-icon" />
                </div>
                <div className="collection-meta">
                  <span className="badge">PLAYLIST</span>
                  <h2>{activePlaylist.name}</h2>
                  <p className="subtext">{activePlaylist.trackIds.length} tracks</p>
                  <div className="collection-actions">
                    {activePlaylist.trackIds.length > 0 && (
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          const resolved = activePlaylist.trackIds
                            .map((id) => tracks.find((t) => t.id === id))
                            .filter(Boolean) as LibraryTrack[]
                          if (resolved.length > 0) playTrackList(resolved[0], resolved)
                        }}
                      >
                        <Play size={16} /> Play Playlist
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-sm danger-hover"
                      onClick={async () => {
                        if (window.confirm(`Delete playlist "${activePlaylist.name}"?`)) {
                          await window.api.deletePlaylist(activePlaylist.id)
                          setSelectedPlaylistId(null)
                        }
                      }}
                    >
                      <Trash2 size={14} /> Delete Playlist
                    </button>
                  </div>
                </div>
              </div>

              <div className="track-list">
                {(() => {
                  const plTracks = activePlaylist.trackIds
                    .map((id) => tracks.find((t) => t.id === id))
                    .filter(Boolean) as LibraryTrack[]
                  if (plTracks.length === 0) {
                    return (
                      <div className="empty-state">
                        <p>
                          No songs in this playlist yet. Click <strong>+</strong> on any track in
                          Songs to add it here.
                        </p>
                      </div>
                    )
                  }
                  return plTracks.map((t) => renderLibraryTrackRow(t, plTracks, activePlaylist))
                })()}
              </div>
            </div>
          ) : playlists.length === 0 ? (
            <div className="empty-state">
              <ListMusic size={34} className="muted-icon" />
              <h3>No Playlists Yet</h3>
              <p>Create a playlist above or import a playlist directly from Discover.</p>
            </div>
          ) : (
            <div className="card-grid">
              {playlists.map((pl) => {
                const firstTrack = pl.trackIds
                  .map((id) => tracks.find((t) => t.id === id))
                  .find(Boolean)
                const cover = firstTrack?.coverArtDataUrl || firstTrack?.thumbnailUrl
                return (
                  <div
                    key={pl.id}
                    className="media-card"
                    onClick={() => setSelectedPlaylistId(pl.id)}
                  >
                    <div className="media-card-art">
                      {cover ? (
                        <img src={cover} alt={pl.name} />
                      ) : (
                        <ListMusic size={36} className="muted-icon" />
                      )}
                    </div>
                    <div className="media-card-title">{pl.name}</div>
                    <div className="media-card-sub">{pl.trackIds.length} songs</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  HardDrive,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Usb
} from 'lucide-react'
import type { DapProfile, FolderStructure, SyncPlan } from '@shared/types'
import { useAppStore } from '../state/useAppStore'
import { formatBytes } from '../utils/format'

type SelectorTab = 'playlists' | 'albums' | 'artists' | 'songs'

export const DapSyncView: React.FC = () => {
  const {
    dapProfiles,
    tracks,
    playlists,
    syncProgress,
    refreshDapProfiles,
    pushToast
  } = useAppStore()

  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [loadingPlan, setLoadingPlan] = useState(false)
  const [selectorTab, setSelectorTab] = useState<SelectorTab>('albums')
  const [selectorSearch, setSelectorSearch] = useState('')
  const [showCopyDetails, setShowCopyDetails] = useState(false)

  useEffect(() => {
    if (dapProfiles.length > 0 && (!activeProfileId || !dapProfiles.some((p) => p.id === activeProfileId))) {
      setActiveProfileId(dapProfiles[0].id)
    } else if (dapProfiles.length === 0) {
      setActiveProfileId(null)
    }
  }, [dapProfiles, activeProfileId])

  const activeProfile: DapProfile | null = useMemo(
    () => dapProfiles.find((p) => p.id === activeProfileId) || null,
    [dapProfiles, activeProfileId]
  )

  const albums = useMemo(() => {
    const map = new Map<string, { key: string; album: string; artist: string; count: number; bytes: number }>()
    for (const t of tracks) {
      if (t.missingOnDisk) continue
      const key = `${t.artist}|||${t.album}`
      const existing = map.get(key)
      if (existing) {
        existing.count++
        existing.bytes += t.fileSize
      } else {
        map.set(key, {
          key,
          album: t.album,
          artist: t.artist,
          count: 1,
          bytes: t.fileSize
        })
      }
    }
    return [...map.values()].sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album))
  }, [tracks])

  const artists = useMemo(() => {
    const map = new Map<
      string,
      { artist: string; albums: Set<string>; count: number; bytes: number }
    >()
    for (const t of tracks) {
      if (t.missingOnDisk) continue
      const existing = map.get(t.artist)
      if (existing) {
        existing.albums.add(t.album)
        existing.count++
        existing.bytes += t.fileSize
      } else {
        map.set(t.artist, {
          artist: t.artist,
          albums: new Set([t.album]),
          count: 1,
          bytes: t.fileSize
        })
      }
    }
    return [...map.values()]
      .map((a) => ({
        artist: a.artist,
        albumCount: a.albums.size,
        count: a.count,
        bytes: a.bytes
      }))
      .sort((a, b) => a.artist.localeCompare(b.artist))
  }, [tracks])

  const reloadPlan = async (profileId: string): Promise<void> => {
    setLoadingPlan(true)
    try {
      const nextPlan = await window.api.computeSyncPlan(profileId)
      setPlan(nextPlan)
    } catch (err: unknown) {
      console.error(err)
    } finally {
      setLoadingPlan(false)
    }
  }

  useEffect(() => {
    if (activeProfile) {
      reloadPlan(activeProfile.id)
    } else {
      setPlan(null)
    }
  }, [
    activeProfile?.id,
    activeProfile?.targetPath,
    activeProfile?.syncMode,
    activeProfile?.folderTemplate,
    activeProfile?.exportM3u8,
    activeProfile?.mirrorDeletions,
    activeProfile?.selectedTrackIds.length,
    activeProfile?.selectedAlbums.length,
    activeProfile?.selectedArtists?.length,
    activeProfile?.selectedPlaylistIds.length,
    tracks.length,
    playlists.length,
    syncProgress.stage
  ])

  const createNewProfile = async (): Promise<void> => {
    const picked = await window.api.pickDirectory('Select DAP / SD Card Music Folder')
    const saved = await window.api.saveDapProfile({
      name: picked ? picked.split(/[\\/]/).filter(Boolean).pop() || 'My DAP' : 'My DAP Player',
      targetPath: picked || '',
      syncMode: 'all',
      selectedTrackIds: [],
      selectedAlbums: [],
      selectedArtists: [],
      selectedPlaylistIds: [],
      folderTemplate: 'artist-album',
      exportM3u8: true,
      mirrorDeletions: false
    })
    await refreshDapProfiles()
    setActiveProfileId(saved.id)
    pushToast(`Created sync target "${saved.name}"`, 'success')
  }

  const updateActiveProfile = async (patch: Partial<DapProfile>): Promise<void> => {
    if (!activeProfile) return
    await window.api.saveDapProfile({ ...activeProfile, ...patch })
    await refreshDapProfiles()
  }

  const handleStartSync = async (): Promise<void> => {
    if (!activeProfile) return
    try {
      await window.api.startDapSync(activeProfile.id)
      await refreshDapProfiles()
      pushToast(`DAP Sync finished for "${activeProfile.name}"!`, 'success')
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'DAP Sync failed', 'error')
    }
  }

  const q = selectorSearch.trim().toLowerCase()

  return (
    <div className="view-container">
      <div className="page-header">
        <div>
          <h1>DAP & Directory Sync</h1>
          <p className="subtext">
            Incrementally sync your entire Library or chosen albums, playlists, and songs to a
            mounted Digital Audio Player, microSD card, or local folder.
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={createNewProfile}>
          <Plus size={15} /> New Sync Target
        </button>
      </div>

      {dapProfiles.length === 0 ? (
        <div className="empty-state hero">
          <div className="hero-icon-ring">
            <Usb size={34} />
          </div>
          <h2>Set Up Your First DAP or Sync Folder</h2>
          <p>
            Target any local directory, USB-connected DAP internal drive, or microSD card (e.g.,{' '}
            <code>E:\Music</code> or <code>/Volumes/DAP/Music</code>). Only new or changed songs
            are copied on each sync.
          </p>
          <button className="btn btn-primary" onClick={createNewProfile}>
            <Plus size={16} /> Choose Target Directory
          </button>
        </div>
      ) : (
        <div className="dap-layout">
          {/* Left Rail: Target Profiles */}
          <aside className="dap-profiles-rail">
            <div className="rail-label">Saved Targets</div>
            {dapProfiles.map((p) => (
              <button
                key={p.id}
                className={`dap-profile-btn ${p.id === activeProfile?.id ? 'active' : ''}`}
                onClick={() => setActiveProfileId(p.id)}
              >
                <HardDrive size={17} />
                <div className="dap-profile-btn-text">
                  <div className="name">{p.name}</div>
                  <div className="path">{p.targetPath || 'No folder set'}</div>
                </div>
              </button>
            ))}
          </aside>

          {/* Main DAP Configuration & Sync Plan */}
          {activeProfile && (
            <div className="dap-main">
              {/* Target Config Card */}
              <div className="card">
                <div className="card-row-between">
                  <div className="field-inline" style={{ flex: 1 }}>
                    <label>Target Name</label>
                    <input
                      type="text"
                      value={activeProfile.name}
                      onChange={(e) => updateActiveProfile({ name: e.target.value })}
                    />
                  </div>
                  <button
                    className="btn btn-ghost btn-sm danger-hover"
                    onClick={async () => {
                      if (window.confirm(`Remove sync profile "${activeProfile.name}"? (Files on disk will NOT be deleted)`)) {
                        await window.api.deleteDapProfile(activeProfile.id)
                        await refreshDapProfiles()
                      }
                    }}
                  >
                    <Trash2 size={14} /> Remove Profile
                  </button>
                </div>

                <div className="field-block" style={{ marginTop: 12 }}>
                  <label>Target Directory (DAP Drive / SD Card / Local Folder)</label>
                  <div className="path-picker-row">
                    <input
                      type="text"
                      value={activeProfile.targetPath}
                      placeholder="Select a target directory..."
                      onChange={(e) => updateActiveProfile({ targetPath: e.target.value })}
                    />
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={async () => {
                        const chosen = await window.api.pickDirectory(
                          'Select Target Sync Directory',
                          activeProfile.targetPath
                        )
                        if (chosen) updateActiveProfile({ targetPath: chosen })
                      }}
                    >
                      Browse...
                    </button>
                    {activeProfile.targetPath && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => window.api.openPath(activeProfile.targetPath)}
                        title="Open in Explorer / Finder"
                      >
                        <FolderOpen size={15} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Drive Space Meter */}
                {plan && (
                  <div className="drive-status-box">
                    <div className="drive-status-top">
                      <span
                        className={`status-pill ${plan.targetAvailable ? 'ready' : 'offline'}`}
                      >
                        {plan.targetAvailable ? (
                          <>
                            <CheckCircle2 size={13} /> Target Ready
                          </>
                        ) : (
                          <>
                            <AlertTriangle size={13} /> Target Unavailable
                          </>
                        )}
                      </span>

                      {plan.freeBytes !== undefined && plan.totalBytes !== undefined && (
                        <span className="drive-space-text">
                          <strong>{formatBytes(plan.freeBytes)} free</strong> of{' '}
                          {formatBytes(plan.totalBytes)}
                        </span>
                      )}
                    </div>

                    {plan.freeBytes !== undefined &&
                      plan.totalBytes !== undefined &&
                      plan.totalBytes > 0 && (
                        <div className="space-meter">
                          <div
                            className="space-used"
                            style={{
                              width: `${Math.min(
                                100,
                                Math.round(((plan.totalBytes - plan.freeBytes) / plan.totalBytes) * 100)
                              )}%`
                            }}
                          />
                          <div
                            className={`space-pending ${plan.insufficientSpace ? 'danger' : ''}`}
                            style={{
                              width: `${Math.min(
                                100,
                                Math.round((plan.toCopyBytes / plan.totalBytes) * 100)
                              )}%`
                            }}
                          />
                        </div>
                      )}
                  </div>
                )}

                {/* Sync Mode & DAP Structure Options */}
                <div className="dap-options-grid">
                  <div>
                    <label className="block-label">What to Sync</label>
                    <div className="segmented-toggle">
                      <button
                        className={activeProfile.syncMode === 'all' ? 'active' : ''}
                        onClick={() => updateActiveProfile({ syncMode: 'all' })}
                      >
                        Entire Library ({tracks.length})
                      </button>
                      <button
                        className={activeProfile.syncMode === 'selected' ? 'active' : ''}
                        onClick={() => updateActiveProfile({ syncMode: 'selected' })}
                      >
                        Selected Music Only
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block-label">DAP Folder Hierarchy</label>
                    <select
                      className="full-select"
                      value={activeProfile.folderTemplate}
                      onChange={(e) =>
                        updateActiveProfile({
                          folderTemplate: e.target.value as FolderStructure
                        })
                      }
                    >
                      <option value="artist-album">
                        Artist / Album (Singles in Artist Root)
                      </option>
                      <option value="artist">Artist Root Only (Artist / Song)</option>
                      <option value="flat">Flat (Artist - Song)</option>
                    </select>
                  </div>
                </div>

                <div className="dap-checkboxes">
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={activeProfile.exportM3u8}
                      onChange={(e) => updateActiveProfile({ exportM3u8: e.target.checked })}
                    />
                    <span>
                      Export <code>.m3u8</code> Playlists into <code>/Playlists</code> folder
                    </span>
                  </label>

                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={activeProfile.mirrorDeletions}
                      onChange={(e) => updateActiveProfile({ mirrorDeletions: e.target.checked })}
                    />
                    <span>
                      Mirror Mode (remove previously synced tracks if unselected — leaves manual
                      DAP files untouched)
                    </span>
                  </label>
                </div>
              </div>

              {/* Selective Music Picker */}
              {activeProfile.syncMode === 'selected' && (
                <div className="card">
                  <div className="toolbar-row" style={{ marginBottom: 10 }}>
                    <div className="filter-pills">
                      <button
                        className={`pill ${selectorTab === 'albums' ? 'active' : ''}`}
                        onClick={() => setSelectorTab('albums')}
                      >
                        Albums ({activeProfile.selectedAlbums.length}/{albums.length})
                      </button>
                      <button
                        className={`pill ${selectorTab === 'artists' ? 'active' : ''}`}
                        onClick={() => setSelectorTab('artists')}
                      >
                        Artists ({(activeProfile.selectedArtists || []).length}/{artists.length})
                      </button>
                      <button
                        className={`pill ${selectorTab === 'playlists' ? 'active' : ''}`}
                        onClick={() => setSelectorTab('playlists')}
                      >
                        Playlists ({activeProfile.selectedPlaylistIds.length}/{playlists.length})
                      </button>
                      <button
                        className={`pill ${selectorTab === 'songs' ? 'active' : ''}`}
                        onClick={() => setSelectorTab('songs')}
                      >
                        Individual Songs ({activeProfile.selectedTrackIds.length}/{tracks.length})
                      </button>
                    </div>

                    <div className="mini-search">
                      <Search size={14} className="muted-icon" />
                      <input
                        type="text"
                        placeholder="Filter selection..."
                        value={selectorSearch}
                        onChange={(e) => setSelectorSearch(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="selector-scroll-box">
                    {selectorTab === 'albums' &&
                      (albums.length === 0 ? (
                        <p className="subtext">No albums in your Library yet.</p>
                      ) : (
                        albums
                          .filter(
                            (a) =>
                              !q ||
                              a.album.toLowerCase().includes(q) ||
                              a.artist.toLowerCase().includes(q)
                          )
                          .map((alb) => {
                            const checked = activeProfile.selectedAlbums.includes(alb.key)
                            return (
                              <label key={alb.key} className="selector-row">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? [...activeProfile.selectedAlbums, alb.key]
                                      : activeProfile.selectedAlbums.filter((k) => k !== alb.key)
                                    updateActiveProfile({ selectedAlbums: next })
                                  }}
                                />
                                <span className="selector-primary">
                                  {alb.album} <span className="muted">— {alb.artist}</span>
                                </span>
                                <span className="selector-meta">
                                  {alb.count} tracks · {formatBytes(alb.bytes)}
                                </span>
                              </label>
                            )
                          })
                      ))}

                    {selectorTab === 'artists' &&
                      (artists.length === 0 ? (
                        <p className="subtext">No artists in your Library yet.</p>
                      ) : (
                        artists
                          .filter((a) => !q || a.artist.toLowerCase().includes(q))
                          .map((art) => {
                            const selectedArtists = activeProfile.selectedArtists || []
                            const checked = selectedArtists.includes(art.artist)
                            return (
                              <label key={art.artist} className="selector-row">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? [...selectedArtists, art.artist]
                                      : selectedArtists.filter((name) => name !== art.artist)
                                    updateActiveProfile({ selectedArtists: next })
                                  }}
                                />
                                <span className="selector-primary">{art.artist}</span>
                                <span className="selector-meta">
                                  {art.albumCount} {art.albumCount === 1 ? 'album' : 'albums'} ·{' '}
                                  {art.count} tracks · {formatBytes(art.bytes)}
                                </span>
                              </label>
                            )
                          })
                      ))}

                    {selectorTab === 'playlists' &&
                      (playlists.length === 0 ? (
                        <p className="subtext">No playlists created in your Library yet.</p>
                      ) : (
                        playlists
                          .filter((p) => !q || p.name.toLowerCase().includes(q))
                          .map((pl) => {
                            const checked = activeProfile.selectedPlaylistIds.includes(pl.id)
                            return (
                              <label key={pl.id} className="selector-row">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? [...activeProfile.selectedPlaylistIds, pl.id]
                                      : activeProfile.selectedPlaylistIds.filter(
                                          (id) => id !== pl.id
                                        )
                                    updateActiveProfile({ selectedPlaylistIds: next })
                                  }}
                                />
                                <span className="selector-primary">{pl.name}</span>
                                <span className="selector-meta">{pl.trackIds.length} tracks</span>
                              </label>
                            )
                          })
                      ))}

                    {selectorTab === 'songs' &&
                      tracks
                        .filter(
                          (t) =>
                            !t.missingOnDisk &&
                            (!q ||
                              t.title.toLowerCase().includes(q) ||
                              t.artist.toLowerCase().includes(q) ||
                              t.album.toLowerCase().includes(q))
                        )
                        .map((t) => {
                          const checked = activeProfile.selectedTrackIds.includes(t.id)
                          return (
                            <label key={t.id} className="selector-row">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const next = e.target.checked
                                    ? [...activeProfile.selectedTrackIds, t.id]
                                    : activeProfile.selectedTrackIds.filter((id) => id !== t.id)
                                  updateActiveProfile({ selectedTrackIds: next })
                                }}
                              />
                              <span className="selector-primary">
                                {t.title} <span className="muted">— {t.artist}</span>
                              </span>
                              <span className="selector-meta">
                                {t.format} · {formatBytes(t.fileSize)}
                              </span>
                            </label>
                          )
                        })}
                  </div>
                </div>
              )}

              {/* Live Sync Plan & Action Card */}
              <div className="card highlight-card">
                <div className="card-row-between">
                  <div>
                    <h3>Sync Summary</h3>
                    {activeProfile.lastSyncedAt && (
                      <p className="subtext">
                        Last synced: {new Date(activeProfile.lastSyncedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => reloadPlan(activeProfile.id)}
                    disabled={loadingPlan || syncProgress.active}
                  >
                    <RefreshCw size={14} className={loadingPlan ? 'spin' : ''} /> Recalculate Diff
                  </button>
                </div>

                {plan && (
                  <>
                    <div className="sync-stats-grid">
                      <div className="stat-box">
                        <div className="stat-val accent">{plan.toCopy.length}</div>
                        <div className="stat-label">
                          New / Changed ({formatBytes(plan.toCopyBytes)})
                        </div>
                      </div>
                      <div className="stat-box">
                        <div className="stat-val">{plan.skippedCount}</div>
                        <div className="stat-label">
                          Already on Target ({formatBytes(plan.skippedBytes)})
                        </div>
                      </div>
                      <div className="stat-box">
                        <div className="stat-val">{plan.playlistsToExport}</div>
                        <div className="stat-label">M3U8 Playlists</div>
                      </div>
                      {activeProfile.mirrorDeletions && (
                        <div className="stat-box">
                          <div className="stat-val">{plan.toRemoveRelativePaths.length}</div>
                          <div className="stat-label">Unselected to Prune</div>
                        </div>
                      )}
                    </div>

                    {plan.warning && (
                      <div className="alert-banner warning" style={{ marginTop: 12 }}>
                        {plan.warning}
                      </div>
                    )}

                    {plan.toCopy.length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setShowCopyDetails(!showCopyDetails)}
                        >
                          {showCopyDetails
                            ? 'Hide files to copy'
                            : `Preview ${plan.toCopy.length} files to copy`}
                        </button>
                        {showCopyDetails && (
                          <div className="copy-preview-list">
                            {plan.toCopy.slice(0, 100).map((item) => (
                              <div key={item.libraryTrackId} className="copy-preview-item">
                                <span>{item.destRelativePath}</span>
                                <span>{formatBytes(item.fileSize)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Active Sync Progress */}
                {syncProgress.active && (
                  <div className="sync-live-box">
                    <div className="card-row-between">
                      <strong>
                        <Loader2 size={15} className="spin" style={{ marginRight: 6 }} />
                        {syncProgress.stage === 'copying'
                          ? `Copying ${syncProgress.completedFiles + 1} of ${syncProgress.totalFiles}`
                          : syncProgress.stage.toUpperCase()}
                      </strong>
                      <span>
                        {formatBytes(syncProgress.copiedBytes)} /{' '}
                        {formatBytes(syncProgress.totalBytes)}
                      </span>
                    </div>
                    {syncProgress.currentTrackTitle && (
                      <div className="subtext">{syncProgress.currentTrackTitle}</div>
                    )}
                    <div className="progress-bar-track">
                      <div
                        className="progress-bar-fill"
                        style={{
                          width: `${
                            syncProgress.totalBytes > 0
                              ? Math.round(
                                  (syncProgress.copiedBytes / syncProgress.totalBytes) * 100
                                )
                              : 0
                          }%`
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className="sync-cta-row">
                  {syncProgress.active ? (
                    <button
                      className="btn btn-secondary"
                      onClick={() => window.api.cancelDapSync()}
                    >
                      Cancel Sync
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      disabled={
                        !plan ||
                        !plan.targetAvailable ||
                        plan.insufficientSpace ||
                        plan.totalSelectedCount === 0
                      }
                      onClick={handleStartSync}
                    >
                      <Usb size={16} />{' '}
                      {plan && plan.toCopy.length > 0
                        ? `Sync ${plan.toCopy.length} Tracks (${formatBytes(plan.toCopyBytes)})`
                        : 'Run Sync & Update Manifest / Playlists'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

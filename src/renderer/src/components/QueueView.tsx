import React from 'react'
import {
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  Play,
  RotateCcw,
  Trash2,
  XCircle
} from 'lucide-react'
import { useAppStore } from '../state/useAppStore'
import { libraryTrackToPlayable } from '../utils/format'

export const QueueView: React.FC = () => {
  const { downloadJobs, tracks, playItem, pushToast } = useAppStore()

  const activeCount = downloadJobs.filter(
    (j) => j.stage === 'queued' || j.stage === 'downloading' || j.stage === 'processing'
  ).length

  return (
    <div className="view-container">
      <div className="page-header">
        <div>
          <h1>Downloads & History</h1>
          <p className="subtext">
            {activeCount > 0
              ? `${activeCount} active ${activeCount === 1 ? 'download' : 'downloads'} in progress`
              : 'All queued downloads complete — saved tracks are automatically indexed in My Library'}
          </p>
        </div>

        {downloadJobs.some(
          (j) => j.stage === 'completed' || j.stage === 'failed' || j.stage === 'cancelled'
        ) && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => window.api.clearFinishedDownloads()}
          >
            <Trash2 size={14} /> Clear Finished
          </button>
        )}
      </div>

      {downloadJobs.length === 0 ? (
        <div className="empty-state hero">
          <Download size={36} className="muted-icon" />
          <h3>No Downloads in Queue</h3>
          <p>Search YouTube Music or paste a song/album/playlist URL in Discover to start.</p>
        </div>
      ) : (
        <div className="queue-list">
          {downloadJobs.map((job) => {
            const libTrack = job.libraryTrackId
              ? tracks.find((t) => t.id === job.libraryTrackId)
              : undefined

            return (
              <div key={job.id} className="queue-card">
                <div className="queue-thumb">
                  {job.thumbnailUrl ? (
                    <img src={job.thumbnailUrl} alt={job.title} />
                  ) : (
                    <Download size={18} className="muted-icon" />
                  )}
                </div>

                <div className="queue-body">
                  <div className="queue-top">
                    <div>
                      <div className="queue-title">{job.title}</div>
                      <div className="queue-sub">
                        {job.artist}
                        {job.album ? ` · ${job.album}` : ''} ·{' '}
                        <span className="tech-pill">{job.format.toUpperCase()}</span>
                      </div>
                    </div>

                    <div className="queue-stage">
                      {job.stage === 'queued' && <span className="badge">Queued</span>}
                      {job.stage === 'downloading' && (
                        <span className="status-pill active">
                          <Loader2 size={13} className="spin" /> {job.progress}%
                          {job.speed ? ` · ${job.speed}` : ''}
                          {job.eta ? ` · ETA ${job.eta}` : ''}
                        </span>
                      )}
                      {job.stage === 'processing' && (
                        <span className="status-pill active">
                          <Loader2 size={13} className="spin" /> Converting & Embedding Art...
                        </span>
                      )}
                      {job.stage === 'completed' && (
                        <span className="owned-pill">
                          <CheckCircle2 size={13} /> Saved to Library
                        </span>
                      )}
                      {job.stage === 'failed' && (
                        <span className="badge danger">
                          <XCircle size={13} /> Failed
                        </span>
                      )}
                      {job.stage === 'cancelled' && <span className="badge">Cancelled</span>}
                    </div>
                  </div>

                  {(job.stage === 'downloading' || job.stage === 'processing') && (
                    <div className="progress-bar-track" style={{ marginTop: 8 }}>
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${Math.max(4, job.progress)}%` }}
                      />
                    </div>
                  )}

                  {job.error && <div className="job-error">{job.error}</div>}
                </div>

                <div className="queue-actions">
                  {(job.stage === 'queued' ||
                    job.stage === 'downloading' ||
                    job.stage === 'processing') && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => window.api.cancelDownload(job.id)}
                    >
                      Cancel
                    </button>
                  )}

                  {(job.stage === 'failed' || job.stage === 'cancelled') && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        window.api.retryDownload(job.id)
                        pushToast(`Retrying "${job.title}"`, 'info')
                      }}
                    >
                      <RotateCcw size={14} /> Retry
                    </button>
                  )}

                  {job.stage === 'completed' && libTrack && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => playItem(libraryTrackToPlayable(libTrack))}
                      title="Play from Library"
                    >
                      <Play size={14} /> Play
                    </button>
                  )}

                  {job.outputPath && (
                    <button
                      className="icon-btn"
                      title="Show in Explorer / Finder"
                      onClick={() => window.api.showItemInFolder(job.outputPath!)}
                    >
                      <FolderOpen size={16} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

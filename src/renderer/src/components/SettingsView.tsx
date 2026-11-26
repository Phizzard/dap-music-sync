import React, { useState } from 'react'
import {
  CheckCircle2,
  DownloadCloud,
  FolderOpen,
  Loader2,
  RefreshCw,
  XCircle
} from 'lucide-react'
import type { AudioFormat, AudioQuality, FolderStructure } from '@shared/types'
import { useAppStore } from '../state/useAppStore'

export const SettingsView: React.FC = () => {
  const {
    settings,
    appUpdateStatus,
    binaryStatus,
    binaryProgress,
    updateSettings,
    refreshBinaries,
    pushToast
  } = useAppStore()

  const [busyBinaries, setBusyBinaries] = useState(false)

  if (!settings) return null

  const handleInstallMissing = async (): Promise<void> => {
    setBusyBinaries(true)
    try {
      await window.api.installMissingBinaries()
      await refreshBinaries()
      pushToast('yt-dlp and ffmpeg are installed and ready!', 'success')
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Binary install failed', 'error')
    } finally {
      setBusyBinaries(false)
    }
  }

  const handleUpdateYtdlp = async (): Promise<void> => {
    setBusyBinaries(true)
    try {
      const res = await window.api.updateYtdlp()
      await refreshBinaries()
      pushToast(res.output || 'yt-dlp updated!', 'success')
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Update failed', 'error')
    } finally {
      setBusyBinaries(false)
    }
  }

  return (
    <div className="view-container narrow">
      <div className="page-header">
        <div>
          <h1>Settings & CLI Tools</h1>
          <p className="subtext">
            Configure your local Music Library storage, audio encoding defaults, and{' '}
            <code>yt-dlp</code> / <code>ffmpeg</code> binaries.
          </p>
        </div>
      </div>

      {/* Library & Audio Defaults */}
      <div className="card">
        <h3>Music Library & Encoding</h3>

        <div className="field-block" style={{ marginTop: 14 }}>
          <label>Managed Library Root Folder</label>
          <div className="path-picker-row">
            <input type="text" value={settings.libraryRootPath} readOnly />
            <button
              className="btn btn-secondary btn-sm"
              onClick={async () => {
                const folder = await window.api.pickDirectory(
                  'Choose Music Library Folder',
                  settings.libraryRootPath
                )
                if (folder) {
                  await updateSettings({ libraryRootPath: folder })
                  pushToast('Updated Library folder', 'success')
                }
              }}
            >
              Change...
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => window.api.openPath(settings.libraryRootPath)}
            >
              <FolderOpen size={15} />
            </button>
          </div>
        </div>

        <div className="settings-grid-2">
          <div className="field-block">
            <label>Default Audio Format</label>
            <select
              className="full-select"
              value={settings.defaultFormat}
              onChange={(e) =>
                updateSettings({ defaultFormat: e.target.value as AudioFormat })
              }
            >
              <option value="flac">FLAC (Lossless Container — Best for DAPs)</option>
              <option value="mp3">MP3 (Universal Compatibility)</option>
              <option value="m4a">M4A / AAC</option>
              <option value="opus">Opus (Native YT Music Stream)</option>
            </select>
          </div>

          <div className="field-block">
            <label>Default Bitrate (MP3 / M4A)</label>
            <select
              className="full-select"
              value={settings.defaultQuality}
              onChange={(e) =>
                updateSettings({ defaultQuality: e.target.value as AudioQuality })
              }
            >
              <option value="best">Best Quality (V0)</option>
              <option value="320k">320 kbps CBR</option>
              <option value="256k">256 kbps</option>
              <option value="192k">192 kbps</option>
            </select>
          </div>

          <div className="field-block">
            <label>Library Folder Organization</label>
            <select
              className="full-select"
              value={settings.folderStructure}
              onChange={async (e) => {
                await updateSettings({ folderStructure: e.target.value as FolderStructure })
                pushToast('Updated folder layout and reorganized library files', 'success')
              }}
            >
              <option value="artist-album">
                Artist / Album (Singles in Artist Root)
              </option>
              <option value="artist">Artist Root Only (Artist / Song)</option>
              <option value="flat">Flat (Artist - Song)</option>
            </select>
          </div>

          <div className="field-block">
            <label>Max Concurrent Downloads</label>
            <select
              className="full-select"
              value={settings.maxConcurrentDownloads}
              onChange={(e) =>
                updateSettings({ maxConcurrentDownloads: parseInt(e.target.value, 10) })
              }
            >
              <option value={1}>1 at a time</option>
              <option value={2}>2 simultaneous</option>
              <option value={3}>3 simultaneous</option>
              <option value={4}>4 simultaneous</option>
            </select>
          </div>
        </div>

        <label className="inline-check" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={settings.squareCoverArt}
            onChange={(e) => updateSettings({ squareCoverArt: e.target.checked })}
          />
          <span>
            Center-crop wide 16:9 thumbnails into <strong>1:1 square JPEG cover art</strong>{' '}
            (recommended for DAP screens)
          </span>
        </label>
      </div>

      {/* CLI Binaries Card */}
      <div className="card">
        <div className="card-row-between">
          <h3>CLI Engines (yt-dlp & ffmpeg)</h3>
          <div className="header-actions">
            {binaryStatus && !binaryStatus.ready && (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleInstallMissing}
                disabled={busyBinaries}
              >
                <DownloadCloud size={15} /> Auto-Install Missing Tools
              </button>
            )}
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleUpdateYtdlp}
              disabled={busyBinaries}
            >
              {busyBinaries ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <RefreshCw size={14} />
              )}{' '}
              Update yt-dlp
            </button>
          </div>
        </div>

        {binaryProgress && (
          <div className="sync-live-box" style={{ marginTop: 12 }}>
            <div>{binaryProgress.message}</div>
            {binaryProgress.percent !== undefined && (
              <div className="progress-bar-track" style={{ marginTop: 6 }}>
                <div
                  className="progress-bar-fill"
                  style={{ width: `${binaryProgress.percent}%` }}
                />
              </div>
            )}
          </div>
        )}

        <div className="binary-status-list">
          {(['ytdlp', 'ffmpeg'] as const).map((key) => {
            const info = binaryStatus?.[key]
            const label = key === 'ytdlp' ? 'yt-dlp' : 'ffmpeg'
            const customField = key === 'ytdlp' ? 'customYtdlpPath' : 'customFfmpegPath'

            return (
              <div key={key} className="binary-row">
                <div className="binary-row-top">
                  <div className="binary-title">
                    {info?.found ? (
                      <CheckCircle2 size={16} className="ok-icon" />
                    ) : (
                      <XCircle size={16} className="err-icon" />
                    )}
                    <strong>{label}</strong>
                    <span className="badge">
                      {info?.found ? `${info.source.toUpperCase()} · ${info.version}` : 'Not Found'}
                    </span>
                  </div>
                </div>
                <div className="subtext">{info?.path || 'Not detected on system PATH'}</div>

                <div className="path-picker-row" style={{ marginTop: 8 }}>
                  <input
                    type="text"
                    placeholder={`Optional custom ${label} executable path...`}
                    value={settings[customField] || ''}
                    onChange={async (e) => {
                      await updateSettings({ [customField]: e.target.value })
                      await refreshBinaries()
                    }}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={async () => {
                      const file = await window.api.pickBinaryFile(`Select ${label} Executable`)
                      if (file) {
                        await updateSettings({ [customField]: file })
                        await refreshBinaries()
                      }
                    }}
                  >
                    Browse...
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Application Auto-Update Card */}
      <div className="card">
        <div className="card-row-between">
          <div>
            <h3>Application Updates</h3>
            <p className="subtext" style={{ marginTop: 4 }}>
              Installed Version: <strong>v{appUpdateStatus?.currentVersion || '1.0.0'}</strong> ·
              Source: <code>github.com/Phizzard/cratesync</code>
            </p>
          </div>

          <div className="header-actions">
            {appUpdateStatus?.stage === 'available' ? (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => window.api.downloadAppUpdate()}
              >
                <DownloadCloud size={15} /> Download v{appUpdateStatus.latestVersion}
              </button>
            ) : appUpdateStatus?.stage === 'downloaded' ? (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => window.api.installAppUpdate()}
              >
                {appUpdateStatus.downloadedFilePath
                  ? 'Open Downloaded Installer'
                  : 'Restart & Install Update'}
              </button>
            ) : (
              <button
                className="btn btn-secondary btn-sm"
                disabled={
                  appUpdateStatus?.stage === 'checking' ||
                  appUpdateStatus?.stage === 'downloading'
                }
                onClick={async () => {
                  const res = await window.api.checkForAppUpdates()
                  if (res.stage === 'not-available') {
                    pushToast(res.message || 'CrateSync is up to date!', 'info')
                  } else if (res.stage === 'error') {
                    pushToast(res.error || 'Update check failed', 'error')
                  }
                }}
              >
                {appUpdateStatus?.stage === 'checking' ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <RefreshCw size={14} />
                )}{' '}
                Check for App Updates
              </button>
            )}
          </div>
        </div>

        {appUpdateStatus?.message && (
          <p className="subtext" style={{ marginTop: 10 }}>
            {appUpdateStatus.message}
          </p>
        )}

        {appUpdateStatus?.stage === 'downloading' && (
          <div className="progress-bar-track" style={{ marginTop: 10 }}>
            <div
              className="progress-bar-fill"
              style={{ width: `${appUpdateStatus.downloadPercent ?? 0}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

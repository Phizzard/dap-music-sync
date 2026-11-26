import React, { useEffect } from 'react'
import {
  Compass,
  Disc3,
  Download,
  Library,
  Settings,
  Usb,
  X
} from 'lucide-react'
import { useAppStore, NavTab } from './state/useAppStore'
import { DiscoverView } from './components/DiscoverView'
import { LibraryView } from './components/LibraryView'
import { DapSyncView } from './components/DapSyncView'
import { QueueView } from './components/QueueView'
import { SettingsView } from './components/SettingsView'
import { PlayerBar } from './components/PlayerBar'

export const App: React.FC = () => {
  const {
    activeTab,
    setActiveTab,
    appUpdateStatus,
    tracks,
    downloadJobs,
    syncProgress,
    toasts,
    dismissToast,
    initialize
  } = useAppStore()

  useEffect(() => {
    initialize()
  }, [])

  const activeDownloadsCount = downloadJobs.filter(
    (j) => j.stage === 'queued' || j.stage === 'downloading' || j.stage === 'processing'
  ).length

  const navItems: Array<{
    id: NavTab
    label: string
    icon: React.ReactNode
    badge?: string | number
    badgeActive?: boolean
  }> = [
    { id: 'discover', label: 'Discover & URL', icon: <Compass size={18} /> },
    {
      id: 'library',
      label: 'My Library',
      icon: <Library size={18} />,
      badge: tracks.length > 0 ? tracks.length : undefined
    },
    {
      id: 'dap',
      label: 'DAP Sync',
      icon: <Usb size={18} />,
      badge: syncProgress.active ? 'SYNC' : undefined,
      badgeActive: syncProgress.active
    },
    {
      id: 'downloads',
      label: 'Downloads',
      icon: <Download size={18} />,
      badge: activeDownloadsCount > 0 ? activeDownloadsCount : undefined,
      badgeActive: activeDownloadsCount > 0
    },
    { id: 'settings', label: 'Settings', icon: <Settings size={18} /> }
  ]

  return (
    <div className="app-shell">
      <div className="workspace-row">
        {/* Left Navigation Sidebar */}
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-logo">
              <Disc3 size={22} />
            </div>
            <div>
              <div className="brand-name">DAP Music Sync</div>
              <div className="brand-tag">YT Music · Library · DAP</div>
            </div>
          </div>

          <nav className="sidebar-nav">
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`nav-btn ${activeTab === item.id ? 'active' : ''}`}
                onClick={() => setActiveTab(item.id)}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
                {item.badge !== undefined && (
                  <span className={`nav-badge ${item.badgeActive ? 'pulse' : ''}`}>
                    {item.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <div className="mini-tip">
              Paste any YouTube Music URL or search songs, preview instantly, and sync lossless
              folders to your DAP.
            </div>
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main className="main-content">
          {appUpdateStatus &&
            (appUpdateStatus.stage === 'available' ||
              appUpdateStatus.stage === 'downloading' ||
              appUpdateStatus.stage === 'downloaded') && (
              <div className="alert-banner info" style={{ maxWidth: 1160, margin: '0 auto 16px' }}>
                <div>
                  <strong>App Update:</strong>{' '}
                  {appUpdateStatus.message ||
                    `DAP Music Sync v${appUpdateStatus.latestVersion} is available!`}
                </div>
                <div className="header-actions">
                  {appUpdateStatus.stage === 'available' && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => window.api.downloadAppUpdate()}
                    >
                      Download v{appUpdateStatus.latestVersion}
                    </button>
                  )}
                  {appUpdateStatus.stage === 'downloading' && (
                    <span className="status-pill active">
                      Downloading {appUpdateStatus.downloadPercent ?? 0}%
                    </span>
                  )}
                  {appUpdateStatus.stage === 'downloaded' && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => window.api.installAppUpdate()}
                    >
                      {appUpdateStatus.downloadedFilePath
                        ? 'Open Downloaded Installer'
                        : 'Restart & Install Update'}
                    </button>
                  )}
                </div>
              </div>
            )}

          {activeTab === 'discover' && <DiscoverView />}
          {activeTab === 'library' && <LibraryView />}
          {activeTab === 'dap' && <DapSyncView />}
          {activeTab === 'downloads' && <QueueView />}
          {activeTab === 'settings' && <SettingsView />}
        </main>
      </div>

      {/* Persistent Audio Preview & Library Player */}
      <PlayerBar />

      {/* Toast Stack */}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <span>{t.text}</span>
            <button className="icon-btn" onClick={() => dismissToast(t.id)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

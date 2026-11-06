import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

import { EVENTS } from '@shared/ipc'
import type { UpdateStatus } from '@shared/types'

import { broadcast } from './broadcast'
import { logger } from './logger'

let initialized = false
let lastStatus: UpdateStatus = { state: 'idle' }

function publish(status: UpdateStatus): void {
  lastStatus = status
  broadcast(EVENTS.updateStatus, status)
}

export function currentUpdateStatus(): UpdateStatus {
  return lastStatus
}

function init(): void {
  if (initialized) return
  initialized = true
  autoUpdater.logger = null
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => publish({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => publish({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => publish({ state: 'not-available' }))
  autoUpdater.on('download-progress', (progress) =>
    publish({ state: 'downloading', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => publish({ state: 'downloaded', version: info.version }))
  autoUpdater.on('error', (error) => publish({ state: 'error', message: error.message }))
}

/** 开发态不检查更新；正式包才连 GitHub Releases */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    publish({ state: 'not-available', message: '开发模式不检查更新' })
    return
  }
  init()
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    logger.error('update check failed', error)
    publish({ state: 'error', message: '更新服务不可用' })
  }
}

export function downloadUpdate(): void {
  init()
  void autoUpdater.downloadUpdate().catch((error: unknown) => {
    logger.error('update download failed', error)
    publish({ state: 'error', message: '下载更新失败' })
  })
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}

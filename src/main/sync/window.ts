import path from 'node:path'

import { BrowserWindow, app, shell } from 'electron'

import { EVENTS } from '@shared/ipc'
import type { SyncTab } from '@shared/sync'

import { logger } from '../logger'
import { isDev, isSilent, registerTrustedWindow } from '../window'

let syncWindow: BrowserWindow | null = null

export function openSyncWindow(tab: SyncTab = 'git'): BrowserWindow {
  if (syncWindow && !syncWindow.isDestroyed()) {
    if (syncWindow.isMinimized()) syncWindow.restore()
    syncWindow.show()
    syncWindow.focus()
    syncWindow.webContents.send(EVENTS.syncTab, { tab })
    return syncWindow
  }

  const window = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 660,
    minHeight: 540,
    show: false,
    title: '同步 — Mini Diary',
    backgroundColor: '#fbfbfa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
      devTools: isDev(),
      backgroundThrottling: true
    }
  })

  // 与主窗口共用 trusted 集合：只有本窗口自己的 webContents
  registerTrustedWindow(window)

  syncWindow = window
  window.on('closed', () => {
    if (syncWindow === window) syncWindow = null
  })

  window.once('ready-to-show', () => {
    if (isSilent()) {
      app.dock?.hide()
      return
    }
    window.show()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const isDevUrl = devUrl ? url.startsWith(new URL(devUrl).origin) : false
    if (!isDevUrl && !url.startsWith('file://')) {
      event.preventDefault()
      logger.warn('sync window navigation blocked')
    }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    const url = new URL(devServerUrl)
    url.searchParams.set('window', 'sync')
    url.searchParams.set('tab', tab)
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: { window: 'sync', tab }
    })
  }

  return window
}

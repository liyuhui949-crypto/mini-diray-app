import path from 'node:path'

import { BrowserWindow, app, shell, type WebContents } from 'electron'

import { copy } from '@shared/copy'
import type { Preferences } from '@shared/types'

import { logger } from './logger'

const trusted = new Set<number>()

const COMPACT_BOUNDS = { width: 480, height: 600, minWidth: 400, minHeight: 480 }
let mainWindow: BrowserWindow | null = null
let expandedBounds: Electron.Rectangle | null = null
let expandedMaximized = false

export function isTrustedWebContents(webContents: WebContents): boolean {
  return trusted.has(webContents.id)
}

export function forgetWebContents(webContents: WebContents): void {
  trusted.delete(webContents.id)
}

/** 给额外窗口（同步窗口）注册 trusted，避免 IPC sender 校验拒绝 */
export function registerTrustedWindow(window: BrowserWindow): void {
  const id = window.webContents.id
  trusted.add(id)
  window.on('closed', () => trusted.delete(id))
}

export function isDev(): boolean {
  return !process.env['NODE_ENV'] || process.env['NODE_ENV'] !== 'production'
}

function allowedOrigin(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL']
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** 自动化测试用：窗口不在屏幕上出现，也不抢焦点 */
export function isSilent(): boolean {
  return process.env['MINIDIARY_SILENT'] === '1'
}

/** 锁定后只保留密码框需要的空间；解锁时恢复原来的窗口尺寸 */
export function setMainWindowLocked(locked: boolean): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (locked) {
    if (!window.isFullScreen()) expandedBounds = window.getNormalBounds()
    expandedMaximized = window.isMaximized()
    if (window.isMaximized()) window.unmaximize()
    window.setMinimumSize(COMPACT_BOUNDS.minWidth, COMPACT_BOUNDS.minHeight)
    window.setSize(COMPACT_BOUNDS.width, COMPACT_BOUNDS.height)
    window.center()
    return
  }
  window.setMinimumSize(960, 620)
  if (expandedBounds) {
    window.setBounds(expandedBounds)
    expandedBounds = null
  } else {
    window.setSize(1440, 920)
    window.center()
  }
  if (expandedMaximized) {
    expandedMaximized = false
    window.maximize()
  }
}

export function createMainWindow(preferences: Preferences): BrowserWindow {
  const silent = isSilent()
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    show: false,
    focusable: !silent,
    skipTaskbar: silent,
    paintWhenInitiallyHidden: true,
    title: copy.appName,
    backgroundColor: preferences.theme === 'dark' ? '#151513' : '#fbfbfa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: isDev(),
      backgroundThrottling: !silent
    }
  })

  registerTrustedWindow(window)
  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  window.once('ready-to-show', () => {
    if (silent) {
      // 测试环境：只渲染不显示，避免打断用户
      app.dock?.hide()
      return
    }
    window.show()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const dev = allowedOrigin()
    const isDevUrl = dev !== null && url.startsWith(dev)
    const isFile = url.startsWith('file://')
    if (!isDevUrl && !isFile) {
      event.preventDefault()
      logger.warn('navigation blocked')
    }
  })

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  // 生产环境禁止打开 devtools 快捷键（菜单里也只给开发态入口）
  window.webContents.on('before-input-event', (event, input) => {
    if (!isDev() && input.control && input.shift && input.key.toLowerCase() === 'i') {
      event.preventDefault()
    }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

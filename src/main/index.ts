import path from 'node:path'

import { BrowserWindow, app, dialog, nativeTheme, session } from 'electron'

import { EVENTS } from '@shared/ipc'

import { registerAttachmentScheme } from './attachments/protocol'
import { broadcast } from './broadcast'
import { AppContext } from './context'
import { registerPrintScheme } from './export/pdf'
import { registerIpcHandlers } from './ipc'
import { initLogger, logger } from './logger'
import { installApplicationMenu } from './menu'
import { installNetworkGuard } from './net-guard'
import { createMainWindow, setMainWindowLocked } from './window'

const DEV = !app.isPackaged

// 测试/开发隔离：用环境变量把 userData 指到临时目录（必须在 ready 之前设置）
const userDataOverride = process.env['MINIDIARY_USER_DATA']
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride))
}

// 协议必须在 app ready 之前注册
registerAttachmentScheme()
registerPrintScheme()

const pendingPackagePaths: string[] = []

function collectPackagePath(argv: readonly string[]): void {
  for (const argument of argv) {
    if (typeof argument !== 'string') continue
    if (!argument.toLowerCase().endsWith('.minidiary')) continue
    const resolved = path.resolve(argument)
    if (!pendingPackagePaths.includes(resolved)) pendingPackagePaths.push(resolved)
  }
}

function flushPendingPackages(): void {
  while (pendingPackagePaths.length > 0) {
    const next = pendingPackagePaths.shift()
    if (next) broadcast(EVENTS.openPackage, { path: next })
  }
}

function applyContentSecurityPolicy(): void {
  const devPolicy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' http://localhost:* ws://localhost:*",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: attachment:",
    "media-src 'self' attachment: blob:",
    "font-src 'self' data:",
    "connect-src 'self' http://localhost:* ws://localhost:*",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')

  const productionPolicy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: attachment:",
    "media-src 'self' attachment: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [DEV ? devPolicy : productionPolicy],
        'X-Content-Type-Options': ['nosniff']
      }
    })
  })

  // 只放行 HTML 全屏（视频播放器需要）；其余权限一律拒绝
  const allowed = new Set(['fullscreen'])
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowed.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => allowed.has(permission)
  )
}

let context: AppContext | null = null
let quitting = false

const singleInstance = app.requestSingleInstanceLock()

if (!singleInstance) {
  // 开发模式下最常见的原因是安装版还开着（两者共用同一个 userData 与 SingleInstanceLock）
  if (DEV) {
    console.error(
      '已有 Mini Diary 实例在运行（可能是安装版），开发预览未启动。先退出它，再执行 pnpm dev。'
    )
    dialog.showErrorBox(
      '无法启动开发预览',
      '已经有一个 Mini Diary 实例在运行，可能是安装版或另一个开发实例。\n请先退出它，再重新执行 pnpm dev。'
    )
  }
  app.quit()
} else {
  collectPackagePath(process.argv.slice(1))
  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (filePath.toLowerCase().endsWith('.minidiary')) {
      if (app.isReady()) broadcast(EVENTS.openPackage, { path: filePath })
      else pendingPackagePaths.push(filePath)
    }
  })

  app.on('second-instance', (_event, argv) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
    collectPackagePath(argv)
    flushPendingPackages()
  })

  app.whenReady().then(async () => {
    initLogger(DEV)
    applyContentSecurityPolicy()

    context = new AppContext(app.getVersion())
    await context.init()
    installNetworkGuard(session.defaultSession, () => context?.preferences.current.syncEnabled === true)

    registerIpcHandlers(context)
    createMainWindow(context.preferences.current)
    if ((await context.vaultStatus()) === 'locked') setMainWindowLocked(true)
    installApplicationMenu(context)

    nativeTheme.on('updated', () => {
      broadcast(EVENTS.themeChanged, {
        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        source: 'system'
      })
    })

    flushPendingPackages()
    logger.info('app ready', { version: context.appVersion, dev: DEV })

    app.on('activate', () => {
      void (async () => {
        if (BrowserWindow.getAllWindows().length !== 0 || !context) return
        createMainWindow(context.preferences.current)
        if ((await context.vaultStatus()) === 'locked') setMainWindowLocked(true)
      })()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting || !context) return
    if (!context.repository.isUnlocked) return
    event.preventDefault()
    quitting = true
    void context
      .flushForQuit()
      .catch(() => undefined)
      .finally(() => {
        app.quit()
      })
  })

  app.on('will-quit', () => {
    context?.dispose()
  })

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', error)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', reason)
  })
}

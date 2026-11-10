import type { Session } from 'electron'

/**
 * 同步关闭时禁止渲染进程/打印 session 发起 HTTP(S)。
 * 系统 git 子进程不受这里影响——它在同步开启时才会被启动。
 * 开发服务器（ELECTRON_RENDERER_URL）必须放行，否则 pnpm dev 无法加载。
 */
export function installNetworkGuard(target: Session, allowNetwork: () => boolean): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  let devOrigin: string | null = null
  if (devUrl) {
    try {
      devOrigin = new URL(devUrl).origin
    } catch {
      devOrigin = null
    }
  }

  target.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      if (allowNetwork()) {
        callback({ cancel: false })
        return
      }
      if (devOrigin && details.url.startsWith(devOrigin)) {
        callback({ cancel: false })
        return
      }
      callback({ cancel: true })
    }
  )
}

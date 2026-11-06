import { BrowserWindow } from 'electron'

import type { EventChannel, EventPayloads } from '@shared/ipc'

/** 向所有窗口广播事件；窗口销毁后自动跳过 */
export function broadcast<K extends EventChannel>(channel: K, payload: EventPayloads[K]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(channel, payload)
  }
}

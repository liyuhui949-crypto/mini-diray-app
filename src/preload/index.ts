import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type {
  EventChannel,
  EventPayloads,
  IpcChannel,
  IpcContract,
  IpcResult,
  MiniDiaryApi
} from '@shared/ipc'

function invoke<K extends IpcChannel>(
  channel: K,
  payload: IpcContract[K]['req']
): Promise<IpcResult<IpcContract[K]['res']>> {
  return ipcRenderer.invoke(channel, payload)
}

function on<K extends EventChannel>(
  channel: K,
  listener: (payload: EventPayloads[K]) => void
): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: EventPayloads[K]): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: MiniDiaryApi = {
  invoke: invoke as MiniDiaryApi['invoke'],
  on: on as MiniDiaryApi['on'],
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  platform: process.platform,
  version: process.versions.electron
}

contextBridge.exposeInMainWorld('miniDiary', api)

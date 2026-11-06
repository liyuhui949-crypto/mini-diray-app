import { AppError, type ErrorCode } from '@shared/errors'
import type { EventChannel, EventPayloads, IpcChannel, IpcContract } from '@shared/ipc'

/** 类型安全的 IPC 调用：失败时抛 AppError，界面只需 catch 后取 message */
export async function call<K extends IpcChannel>(
  channel: K,
  payload: IpcContract[K]['req']
): Promise<IpcContract[K]['res']> {
  const api = window.miniDiary
  if (!api) throw new AppError('UNKNOWN', '应用桥接未就绪')
  const result = await api.invoke(channel, payload)
  if (!result.ok) {
    throw new AppError(result.error.code as ErrorCode, result.error.message)
  }
  return result.data
}

export function subscribe<K extends EventChannel>(
  channel: K,
  listener: (payload: EventPayloads[K]) => void
): () => void {
  const api = window.miniDiary
  if (!api) return () => undefined
  return api.on(channel, listener)
}

export function pathForFile(file: File): string | null {
  const api = window.miniDiary
  if (!api) return null
  try {
    return api.pathForFile(file) || null
  } catch {
    return null
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message
  if (error instanceof Error) return error.message
  return '出了点问题，请重试'
}

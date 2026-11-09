import fs from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

import { preferencesSchema } from '@shared/schemas'
import type { Preferences } from '@shared/types'

import { logger } from './logger'
import { atomicWriteFile } from './vault/paths'

export const PREFERENCES_FILE = 'preferences.json'

export function defaultDiaryDir(): string {
  // 测试/开发隔离：允许把默认日记目录指到临时位置
  const override = process.env['MINIDIARY_DIARY_DIR']
  if (override && override.length > 0) return path.resolve(override)
  return path.join(app.getPath('documents'), 'Mini Diary')
}

export function defaultPreferences(diaryDir = defaultDiaryDir()): Preferences {
  return {
    version: 1,
    theme: 'system',
    hideTitle: false,
    allowFutureEntries: false,
    autoLockMinutes: 0,
    diaryDir,
    lastOpenedDate: null,
    lastImportDir: null,
    lastExportDir: null,
    sidebarCollapsed: false,
    listWidth: 312,
    annotationCollapsed: false,
    attachmentPreviewMode: 'entry'
  }
}

/**
 * 偏好只存本机路径与界面开关，不存任何密码/密钥。
 * 写入用原子替换，避免半截 JSON 让应用起不来。
 */
export class PreferencesStore {
  private cache: Preferences
  private readonly file: string
  private readonly fallback: Preferences

  constructor(options: { file?: string; defaultDiaryDir?: string } = {}) {
    this.file = options.file ?? path.join(app.getPath('userData'), PREFERENCES_FILE)
    this.fallback = defaultPreferences(options.defaultDiaryDir ?? defaultDiaryDir())
    this.cache = { ...this.fallback }
  }

  get current(): Preferences {
    return { ...this.cache }
  }

  get filePath(): string {
    return this.file
  }

  async load(): Promise<Preferences> {
    try {
      const text = await fs.readFile(this.file, 'utf8')
      const parsed = preferencesSchema.safeParse(JSON.parse(text))
      if (parsed.success) {
        this.cache = parsed.data
        return this.current
      }
      logger.warn('preferences invalid; falling back to defaults')
      this.cache = { ...this.fallback }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') logger.warn('preferences unreadable; falling back to defaults')
      this.cache = { ...this.fallback }
    }
    await this.save().catch(() => undefined)
    return this.current
  }

  async update(patch: Partial<Preferences>): Promise<Preferences> {
    const merged = { ...this.cache, ...patch, version: 1 as const }
    const next = preferencesSchema.parse(merged) as Preferences
    this.cache = next
    await this.save()
    return this.current
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    await atomicWriteFile(this.file, JSON.stringify(this.cache, null, 2), 0o600)
  }
}

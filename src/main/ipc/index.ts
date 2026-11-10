import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent
} from 'electron'

import { copy } from '@shared/copy'
import { todayLocalDate } from '@shared/date'
import { isWritableDate } from '@shared/writeGuard'
import { AppError, toErrorPayload } from '@shared/errors'
import {
  EVENTS,
  requestValidators,
  type IpcChannel,
  type IpcContract,
  type IpcResult
} from '@shared/ipc'
import type { ImportFormat, StorageStats, ThemeSource } from '@shared/types'
import { formatBytes } from '@shared/date'

import { scanOrphans } from '../attachments/orphans'
import { broadcast } from '../broadcast'
import type { AppContext } from '../context'
import { runExport } from '../export'
import { jobs } from '../jobs'
import { logger } from '../logger'
import { exportMigrationPackage } from '../migration/export'
import { defaultPackageFileName } from '../migration/package'
import { exportAttachmentPackage, importAttachmentPackage } from '../sync/attachmentPackage'
import { syncRoot } from '../sync/mirror'
import { ensureVaultDirs, removePath, vaultPaths } from '../vault/paths'
import { isTrustedWebContents, setMainWindowLocked } from '../window'

function resolveTheme(context: AppContext): ThemeSource {
  const { theme } = context.preferences.current
  if (theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return theme
}

function parentWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function showSave(
  event: IpcMainInvokeEvent,
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  const window = parentWindow(event)
  return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options)
}

function showOpen(
  event: IpcMainInvokeEvent,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  const window = parentWindow(event)
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
}

function isTrusted(event: IpcMainInvokeEvent): boolean {
  if (!isTrustedWebContents(event.sender)) return false
  const url = event.senderFrame?.url ?? ''
  if (url.startsWith('file://')) return true
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    try {
      return url.startsWith(new URL(devUrl).origin)
    } catch {
      return false
    }
  }
  return false
}

type Handler<K extends IpcChannel> = (
  payload: IpcContract[K]['req'],
  event: IpcMainInvokeEvent
) => Promise<IpcContract[K]['res']>

function register<K extends IpcChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, async (event, rawPayload): Promise<IpcResult<IpcContract[K]['res']>> => {
    if (!isTrusted(event)) {
      logger.warn('ipc rejected: untrusted sender', { channel })
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: '不可信的调用来源' } }
    }
    try {
      const validator = requestValidators[channel]
      const payload = (validator ? validator(rawPayload) : rawPayload) as IpcContract[K]['req']
      const data = await handler(payload, event)
      return { ok: true, data }
    } catch (error) {
      if (!(error instanceof AppError)) logger.error(`ipc failed: ${channel}`, error)
      return { ok: false, error: toErrorPayload(error) }
    }
  })
}

function timestampName(extension: string): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `Mini Diary 导出 ${stamp}.${extension}`
}

export function registerIpcHandlers(context: AppContext): void {
  const { repository, preferences, attachments } = context

  // ───────────────────────── app ─────────────────────────
  register('app:bootstrap', async () => ({
    prefs: preferences.current,
    vaultStatus: await context.vaultStatus(),
    theme: resolveTheme(context),
    version: context.appVersion,
    platform: process.platform,
    dev: !app.isPackaged
  }))

  register('app:flushAck', async ({ token }) => {
    context.ackFlush(token)
  })

  register('app:openDiaryDir', async () => {
    const dir = context.diaryDir
    await ensureVaultDirs(vaultPaths(dir))
    const error = await shell.openPath(dir)
    if (error) throw new AppError('IO_ERROR', '无法打开目录')
  })

  register('app:copyText', async ({ text }) => {
    clipboard.writeText(text)
  })

  register('shell:openExternal', async ({ url }) => {
    if (!url.startsWith('https:')) throw new AppError('INVALID_INPUT', '只允许打开 https 链接')
    await shell.openExternal(url)
  })

  register('system:openPrivacySettings', async ({ target }) => {
    if (process.platform !== 'darwin') {
      throw new AppError('UNSUPPORTED', '当前系统没有这个隐私权限设置')
    }
    const pane =
      target === 'localNetwork' ? 'Privacy_LocalNetwork' : 'Privacy_FilesAndFolders'
    await shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${pane}`
    )
  })

  // ───────────────────────── vault ─────────────────────────
  register('vault:create', async ({ password }) => {
    const snapshot = await repository.create(password)
    await ensureVaultDirs(vaultPaths(context.diaryDir))
    setMainWindowLocked(false)
    return snapshot
  })

  register('vault:unlock', async ({ password }) => {
    const snapshot = await repository.unlock(password)
    setMainWindowLocked(false)
    return snapshot
  })

  register('vault:snapshot', async () => repository.getSnapshot())

  register('vault:lock', async () => {
    await context.lock('manual')
  })

  register('vault:changePassword', async ({ currentPassword, newPassword }) => {
    await repository.changePassword(currentPassword, newPassword)
  })

  register('vault:moveDirectory', async ({ targetDir }) => {
    if (!path.isAbsolute(targetDir)) throw new AppError('INVALID_INPUT', '目录必须是绝对路径')
    const result = await repository.moveDirectory(targetDir)
    await context.sync.clearToken().catch(() => undefined)
    await preferences.update({
      diaryDir: result.diaryDir,
      syncRepo: null,
      syncLastAt: null,
      syncLastResult: null,
      syncLastMessage: null
    })
    context.applyDiaryDir(result.diaryDir)
    return result
  })

  register('vault:reset', async ({ password }) => {
    const snapshot = await repository.reset(password)
    await attachments.cleanupParts()
    // 清空数据后本地同步镜像和令牌没有意义；远端仓库保持不动
    await removePath(syncRoot(context.diaryDir)).catch(() => undefined)
    await context.sync.clearToken().catch(() => undefined)
    await preferences.update({
      syncRepo: null,
      syncLastAt: null,
      syncLastResult: null,
      syncLastMessage: null
    })
    broadcast(EVENTS.attachmentsChanged, { missing: 0 })
    broadcast(EVENTS.vaultReset, snapshot)
    return snapshot
  })

  // ───────────────────────── entries ─────────────────────────
  // 可写性铁律：只有今天能写；allowFutureEntries 打开时未来也可写；历史正文封存
  const assertWritableDate = (date: string): void => {
    const writable = isWritableDate(date, {
      today: todayLocalDate(),
      allowFutureEntries: preferences.current.allowFutureEntries,
      allowHistory: process.env['MINIDIARY_ALLOW_HISTORY_WRITE'] === '1'
    })
    if (!writable) throw new AppError('INVALID_DATE', '只能写今天；历史正文已封存')
  }

  register('entry:save', async ({ entry }) => {
    assertWritableDate(entry.date)
    return repository.saveEntry(entry)
  })
  // ───────────────────────── annotations ─────────────────────────
  register('annotation:add', async ({ date, quote, tag, body }) => {
    const result = await repository.addAnnotation({ date, quote, tag, body })
    return { ...result, revision: repository.currentRevision }
  })

  // ───────────────────────── attachments ─────────────────────────
  const addAttachmentFromPath = async (sourcePath: string): Promise<IpcContract['attachment:addFromPath']['res']> => {
    if (!path.isAbsolute(sourcePath)) throw new AppError('INVALID_INPUT', '附件路径必须是绝对路径')
    const job = jobs.create('attachment')
    try {
      const attachment = await attachments.addFromFile(sourcePath, {
        signal: job.signal,
        onProgress: ({ bytesDone, bytesTotal }) => {
          job.report(bytesTotal === 0 ? 0 : bytesDone / bytesTotal, `加密写入 ${formatBytes(bytesDone)}`, {
            bytesDone,
            bytesTotal
          })
        }
      })
      job.done({ path: attachment.id })
      return attachment
    } catch (error) {
      job.fail(error instanceof AppError ? error.message : '附件写入失败')
      throw error
    }
  }

  register('attachment:addFromPath', async ({ sourcePath }) => addAttachmentFromPath(sourcePath))

  register('attachment:addFromDialog', async (_payload, event) => {
    const result = await showOpen(event, {
      title: copy.attachments.add,
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'] },
        { name: '音频', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'] },
        { name: '视频', extensions: ['mp4', 'm4v', 'mov', 'webm'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    if (!filePath) return null
    return addAttachmentFromPath(filePath)
  })

  register('attachment:addBytes', async ({ name, mime, bytes }) => attachments.addFromBytes({ name, mime, bytes }))

  register('attachment:saveAs', async ({ id }, event) => {
    const found = repository.findAttachment(id)
    if (!found) throw new AppError('NOT_FOUND')
    const result = await showSave(event, {
      title: copy.attachments.saveAsTitle,
      defaultPath: found.attachment.name,
      buttonLabel: '导出'
    })
    if (result.canceled || !result.filePath) return { path: null }
    await attachments.exportTo(found.attachment, result.filePath)
    return { path: result.filePath }
  })

  register('attachment:delete', async () => {
    // 只删除条目引用；blob 留到“清理未引用附件”时再释放
  })

  register('attachment:cancel', async ({ jobId }) => {
    jobs.cancel(jobId)
  })

  register('attachment:orphans', async () => {
    const { items } = await scanOrphans(repository, attachments)
    return { items }
  })

  register('attachment:cleanup', async ({ dryRun, ids }) => {
    const { items, bytes } = await scanOrphans(repository, attachments)
    const orphanIds = items.map((item) => item.id)

    if (dryRun) return { count: orphanIds.length, bytes, ids: orphanIds }

    const targets =
      ids && ids.length > 0 ? orphanIds.filter((id) => ids.includes(id)) : orphanIds
    const sizeById = new Map(items.map((item) => [item.id, item.size]))
    let removedBytes = 0
    for (const id of targets) {
      removedBytes += sizeById.get(id) ?? 0
      await attachments.remove(id)
    }
    logger.info('unreferenced attachments removed', { count: targets.length })
    return { count: targets.length, bytes: removedBytes, ids: targets }
  })

  // ───────────────────────── preferences ─────────────────────────
  register('prefs:read', async () => preferences.current)

  register('prefs:update', async (patch) => {
    if (patch.diaryDir) throw new AppError('INVALID_INPUT', '目录变更请使用迁移流程')
    const previous = preferences.current
    const next = await preferences.update(patch)
    broadcast(EVENTS.prefsChanged, next)
    if (previous.theme !== next.theme) {
      broadcast(EVENTS.themeChanged, { theme: resolveTheme(context), source: 'preference' })
    }
    return next
  })

  // ───────────────────────── dialogs ─────────────────────────
  register('dialog:pickDirectory', async ({ purpose }, event) => {
    const result = await showOpen(event, {
      title: purpose,
      properties: ['openDirectory', 'createDirectory']
    })
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
  })

  register('dialog:openFile', async ({ purpose, format }, event) => {
    const filters =
      purpose === 'migration'
        ? [{ name: 'Mini Diary 迁移包', extensions: ['minidiary'] }]
        : importFilters(format)
    const result = await showOpen(event, {
      title: purpose === 'migration' ? copy.migration.importTitle : copy.importDialog.title,
      properties: ['openFile'],
      filters
    })
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
  })

  // ───────────────────────── migration ─────────────────────────
  register('migration:export', async ({ packagePassword, packageKey }, event) => {
    const directory = preferences.current.lastExportDir ?? app.getPath('documents')
    const result = await showSave(event, {
      title: copy.migration.exportTitle,
      defaultPath: path.join(directory, defaultPackageFileName()),
      filters: [{ name: 'Mini Diary 迁移包', extensions: ['minidiary'] }]
    })
    if (result.canceled || !result.filePath) return { path: null, summary: null }

    const job = jobs.create('migration-export')
    try {
      const exported = await exportMigrationPackage(
        { repository, store: attachments, appVersion: context.appVersion },
        {
          targetPath: result.filePath,
          packagePassword,
          packageKey,
          preferences: preferences.current,
          job
        }
      )
      job.done({ path: exported.path })
      await preferences.update({ lastExportDir: path.dirname(exported.path) })
      return { path: exported.path, summary: exported.summary }
    } catch (error) {
      job.fail(error instanceof AppError ? error.message : '导出失败')
      throw error
    }
  })

  register('migration:preview', async ({ filePath, packagePassword, packageKey }) =>
    context.migrationImport.preview(filePath, packagePassword, packageKey)
  )

  register('migration:import', async ({ token, mode }) => {
    const job = jobs.create('migration-import')
    try {
      const result = await context.migrationImport.run({ token, mode, job })
      if (result.prefs) {
        const next = await preferences.update({
          theme: result.prefs.theme,
          hideTitle: result.prefs.hideTitle,
          allowFutureEntries: result.prefs.allowFutureEntries,
          autoLockMinutes: result.prefs.autoLockMinutes
        })
        broadcast(EVENTS.prefsChanged, next)
      }
      return {
        revision: result.revision,
        entries: result.entries,
        attachments: result.attachments,
        merged: result.merged
      }
    } catch (error) {
      job.fail(error instanceof AppError ? error.message : '导入失败')
      throw error
    }
  })

  register('migration:cancel', async ({ jobId }) => {
    jobs.cancel(jobId)
  })

  // ───────────────────────── external import / export ─────────────────────────
  register('import:preview', async ({ format, filePath }) => context.externalImport.preview(format, filePath))

  register('import:commit', async ({ token }) => context.externalImport.commit(token))

  register('import:cancel', async ({ token }) => {
    context.externalImport.cancel(token)
  })

  register('export:run', async ({ format, includeAttachments, html }, event) => {
    const directory = preferences.current.lastExportDir ?? app.getPath('documents')
    let targetPath: string | null = null

    if (format === 'markdown') {
      const result = await showOpen(event, {
        title: '选择导出目录',
        defaultPath: directory,
        properties: ['openDirectory', 'createDirectory']
      })
      targetPath = result.canceled ? null : (result.filePaths[0] ?? null)
    } else {
      const extension = format === 'miniDiaryJson' ? 'json' : format === 'dayOneTxt' ? 'txt' : 'pdf'
      const result = await showSave(event, {
        title: copy.exportDialog.title,
        defaultPath: path.join(directory, timestampName(extension)),
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
      })
      targetPath = result.canceled ? null : result.filePath
    }
    if (!targetPath) return { path: null }

    const job = jobs.create('export')
    try {
      const exported = await runExport(
        {
          repository,
          store: attachments,
          appVersion: context.appVersion,
          attachmentHandler: (request) => context.attachmentProtocol.handleRequest(request)
        },
        {
          format,
          targetPath,
          includeAttachments: includeAttachments ?? true,
          html,
          job
        }
      )
      job.done({ path: exported.path })
      await preferences.update({ lastExportDir: path.dirname(exported.path) })
      return { path: exported.path }
    } catch (error) {
      job.fail(error instanceof AppError ? error.message : '导出失败')
      throw error
    }
  })

  // ───────────────────────── stats ─────────────────────────
  // ───────────────────────── git sync / attachment package ─────────────────────────
  register('sync:status', async () => context.sync.status())

  register('sync:configure', async (payload) => context.sync.configure(payload))

  register('sync:setEnabled', async ({ enabled }) => context.sync.setEnabled(enabled))

  register('sync:test', async () => context.sync.test())

  register('sync:push', async () => context.sync.push())

  register('sync:pull', async () => {
    // 先让主窗口把未保存的草稿 flush 到 vault，避免拉取后 loadSnapshot 覆盖草稿
    const flushToken = randomUUID()
    broadcast(EVENTS.flushRequest, { reason: 'switch', token: flushToken })
    await context.waitForFlush(flushToken, 2000)
    const result = await context.sync.pull()
    const missing = (await context.sync.missingAttachments()).length
    broadcast(EVENTS.attachmentsChanged, { missing })
    broadcast(EVENTS.syncApplied, repository.getSnapshot())
    return result
  })

  register('sync:missingAttachments', async () => context.sync.missingAttachments())

  register('attachment:exportPackage', async (payload, event) => {
    const result = await exportAttachmentPackage(
      repository,
      path.join(context.diaryDir, 'attachments'),
      parentWindow(event),
      payload
    )
    if (result.path) await preferences.update({ lastExportDir: path.dirname(result.path) })
    return result
  })

  register('attachment:importPackage', async (payload, event) => {
    const result = await importAttachmentPackage(
      repository,
      path.join(context.diaryDir, 'attachments'),
      parentWindow(event),
      payload
    )
    const missing = (await context.sync.missingAttachments()).length
    broadcast(EVENTS.attachmentsChanged, { missing })
    return { ...result, missing }
  })

  register('stats:storage', async (): Promise<StorageStats> => {
    const snapshot = repository.isUnlocked ? repository.getSnapshot() : null
    const scan = await scanOrphans(repository, attachments, { sniff: false })
    const vaultStats = await fs.stat(vaultPaths(context.diaryDir).vaultFile).catch(() => null)
    return {
      entryCount: snapshot?.entries.length ?? 0,
      attachmentCount: scan.totalCount,
      attachmentBytes: scan.totalBytes,
      orphanCount: scan.items.length,
      orphanBytes: scan.bytes,
      vaultBytes: vaultStats?.size ?? 0
    }
  })

}

function importFilters(format?: ImportFormat): Array<{ name: string; extensions: string[] }> {
  switch (format) {
    case 'dayOneJson':
      return [{ name: 'Day One JSON', extensions: ['json'] }]
    case 'jrnlJson':
      return [{ name: 'jrnl JSON', extensions: ['json'] }]
    case 'miniDiaryJson':
      return [{ name: 'Mini Diary JSON', extensions: ['json'] }]
    case 'dayOneTxt':
      return [{ name: 'Day One TXT', extensions: ['txt'] }]
    default:
      return [
        { name: '所有支持的格式', extensions: ['json', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
  }
}

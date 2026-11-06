import fs from 'node:fs/promises'
import path from 'node:path'

import { logger } from '../logger'
import { atomicWriteFile, copyDirectory, pathExists, removePath, vaultPaths } from './paths'

/**
 * 临时回滚点：高风险操作（改密、格式迁移、导入、整库迁移）前的逃生通道。
 * 它不是备份功能——不进入 UI、不轮转、成功后立即删除，
 * 应用启动时清理超过 24 小时的残留。
 */
export const STALE_ROLLBACK_MS = 24 * 60 * 60 * 1000

export interface RollbackPoint {
  jobId: string
  dir: string
  hasAttachments: boolean
}

function rollbackDir(diaryDir: string, jobId: string): string {
  return path.join(vaultPaths(diaryDir).migrationDir, `rollback-${jobId}`)
}

/** 保留当前库的密文副本；attachments=true 时连附件目录一起复制 */
export async function createRollbackPoint(
  diaryDir: string,
  jobId: string,
  options: { attachments?: boolean } = {}
): Promise<RollbackPoint> {
  const paths = vaultPaths(diaryDir)
  const dir = rollbackDir(diaryDir, jobId)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })

  const vaultBackup = path.join(dir, 'diary.vault')
  if (await pathExists(paths.vaultFile)) {
    const content = await fs.readFile(paths.vaultFile)
    await atomicWriteFile(vaultBackup, content)
  }

  let hasAttachments = false
  if (options.attachments && (await pathExists(paths.attachmentsDir))) {
    await copyDirectory(paths.attachmentsDir, path.join(dir, 'attachments'))
    hasAttachments = true
  }

  await atomicWriteFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({ jobId, createdAt: new Date().toISOString(), hasAttachments }),
    0o600
  )
  logger.info('rollback point created', { jobId, hasAttachments })
  return { jobId, dir, hasAttachments }
}

/** 把回滚点写回库目录（覆盖式恢复） */
export async function restoreRollbackPoint(diaryDir: string, jobId: string): Promise<boolean> {
  const paths = vaultPaths(diaryDir)
  const dir = rollbackDir(diaryDir, jobId)
  if (!(await pathExists(dir))) return false

  const vaultBackup = path.join(dir, 'diary.vault')
  if (await pathExists(vaultBackup)) {
    const content = await fs.readFile(vaultBackup)
    await atomicWriteFile(paths.vaultFile, content)
  }

  const attachmentsBackup = path.join(dir, 'attachments')
  if (await pathExists(attachmentsBackup)) {
    await removePath(paths.attachmentsDir)
    await copyDirectory(attachmentsBackup, paths.attachmentsDir)
  }

  logger.warn('rollback point restored', { jobId })
  return true
}

export async function deleteRollbackPoint(diaryDir: string, jobId: string): Promise<void> {
  await removePath(rollbackDir(diaryDir, jobId))
}

/** 启动时清理：超过 24 小时的 rollback-* / staging-* / *.part 一律删除 */
export async function cleanupStaleArtifacts(diaryDir: string, now = Date.now()): Promise<number> {
  const paths = vaultPaths(diaryDir)
  let removed = 0

  const migrationDir = paths.migrationDir
  if (await pathExists(migrationDir)) {
    const entries = await fs.readdir(migrationDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!/^(rollback|staging)-/.test(entry.name)) continue
      const target = path.join(migrationDir, entry.name)
      const stats = await fs.stat(target).catch(() => null)
      if (!stats) continue
      if (now - stats.mtimeMs > STALE_ROLLBACK_MS) {
        await removePath(target)
        removed += 1
      }
    }
  }

  const attachmentDir = paths.attachmentsDir
  if (await pathExists(attachmentDir)) {
    const entries = await fs.readdir(attachmentDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.name.endsWith('.part')) continue
      const target = path.join(attachmentDir, entry.name)
      const stats = await fs.stat(target).catch(() => null)
      if (!stats) continue
      if (now - stats.mtimeMs > STALE_ROLLBACK_MS) {
        await removePath(target)
        removed += 1
      }
    }
  }

  if (removed > 0) logger.info('stale artifacts cleaned', { removed })
  return removed
}

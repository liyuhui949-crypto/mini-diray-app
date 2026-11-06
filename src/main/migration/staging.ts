import fs from 'node:fs/promises'
import path from 'node:path'

import { AppError } from '@shared/errors'

import { logger } from '../logger'
import { ensureVaultDirs, pathExists, removePath, vaultPaths } from '../vault/paths'

/**
 * 导入的落点：同盘的 staging 目录 → 校验通过后才原子切入正式目录。
 * 任何一步失败都保留原库不动。
 */

export interface StagingPaths {
  root: string
  vaultFile: string
  attachmentsDir: string
}

export async function createStagingDir(diaryDir: string, jobId: string): Promise<StagingPaths> {
  const migrationDir = path.join(vaultPaths(diaryDir).migrationDir)
  const root = path.join(migrationDir, `staging-${jobId}`)
  await removePath(root).catch(() => undefined)
  const paths = vaultPaths(root)
  await ensureVaultDirs(paths)
  return { root, vaultFile: paths.vaultFile, attachmentsDir: paths.attachmentsDir }
}

export interface SwitchResult {
  rollbackDir: string | null
}

/**
 * 把 staging 的 diary.vault + attachments 换进正式目录。
 * 旧内容先整体搬到 `migration/rollback-<jobId>/`，成功后由 finalizeSwitch 删除。
 */
export async function switchStagingIntoPlace(
  diaryDir: string,
  staging: StagingPaths,
  jobId: string
): Promise<SwitchResult> {
  const target = vaultPaths(diaryDir)
  const migrationDir = target.migrationDir
  const hasCurrentVault = await pathExists(target.vaultFile)
  const hasCurrentAttachments = await pathExists(target.attachmentsDir)

  if (!(await pathExists(staging.vaultFile))) {
    throw new AppError('IO_ERROR', '导入暂存目录缺少日记库文件')
  }

  let rollbackDir: string | null = null
  if (hasCurrentVault || hasCurrentAttachments) {
    rollbackDir = path.join(migrationDir, `rollback-${jobId}`)
    await removePath(rollbackDir).catch(() => undefined)
    await fs.mkdir(rollbackDir, { recursive: true, mode: 0o700 })
  }

  let vaultBackedUp = false
  let attachmentsBackedUp = false
  let vaultInstalled = false
  let attachmentsInstalled = false

  try {
    // 只保证库目录存在；attachments 目录留给后面 rename 进来，避免空目录替换的边界问题
    await fs.mkdir(target.dir, { recursive: true, mode: 0o700 })
    if (rollbackDir && hasCurrentVault) {
      await fs.rename(target.vaultFile, path.join(rollbackDir, 'diary.vault'))
      vaultBackedUp = true
    }
    if (rollbackDir && hasCurrentAttachments) {
      await fs.rename(target.attachmentsDir, path.join(rollbackDir, 'attachments'))
      attachmentsBackedUp = true
    }

    await fs.rename(staging.vaultFile, target.vaultFile)
    vaultInstalled = true

    if (await pathExists(staging.attachmentsDir)) {
      await fs.rename(staging.attachmentsDir, target.attachmentsDir)
      attachmentsInstalled = true
    } else {
      await fs.mkdir(target.attachmentsDir, { recursive: true, mode: 0o700 })
    }
  } catch (error) {
    // 反向恢复：先把新文件挪走，再把旧文件挪回来
    if (attachmentsInstalled) {
      await fs.rename(target.attachmentsDir, path.join(staging.root, 'attachments')).catch(() => undefined)
    }
    if (vaultInstalled) {
      await fs.rename(target.vaultFile, path.join(staging.root, 'diary.vault')).catch(() => undefined)
    }
    if (attachmentsBackedUp && rollbackDir) {
      await fs.rename(path.join(rollbackDir, 'attachments'), target.attachmentsDir).catch(() => undefined)
    }
    if (vaultBackedUp && rollbackDir) {
      await fs.rename(path.join(rollbackDir, 'diary.vault'), target.vaultFile).catch(() => undefined)
    }
    logger.error('migration switch failed; rolled back', error)
    throw new AppError('IO_ERROR', '导入切换失败，原库已恢复')
  }

  return { rollbackDir }
}

export async function restoreFromRollback(
  diaryDir: string,
  rollbackDir: string
): Promise<void> {
  const target = vaultPaths(diaryDir)
  const backupVault = path.join(rollbackDir, 'diary.vault')
  const backupAttachments = path.join(rollbackDir, 'attachments')
  if (await pathExists(backupVault)) {
    await removePath(target.vaultFile)
    await fs.rename(backupVault, target.vaultFile)
  }
  if (await pathExists(backupAttachments)) {
    await removePath(target.attachmentsDir)
    await fs.rename(backupAttachments, target.attachmentsDir)
  }
}

export async function finalizeSwitch(rollbackDir: string | null): Promise<void> {
  if (!rollbackDir) return
  await removePath(rollbackDir)
}

export async function cleanupStaging(staging: StagingPaths): Promise<void> {
  await removePath(staging.root)
}

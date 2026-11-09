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
  annotationsDir: string
}

export async function createStagingDir(diaryDir: string, jobId: string): Promise<StagingPaths> {
  const migrationDir = path.join(vaultPaths(diaryDir).migrationDir)
  const root = path.join(migrationDir, `staging-${jobId}`)
  await removePath(root).catch(() => undefined)
  const paths = vaultPaths(root)
  await ensureVaultDirs(paths)
  const annotationsDir = path.join(root, 'annotations')
  await fs.mkdir(annotationsDir, { recursive: true, mode: 0o700 })
  return {
    root,
    vaultFile: paths.vaultFile,
    attachmentsDir: paths.attachmentsDir,
    annotationsDir
  }
}

export interface SwitchResult {
  rollbackDir: string | null
}

/**
 * 把 staging 的 diary.vault 与 attachments 整体换进正式目录（用于"没有库/库被锁定"的整库导入）。
 * 旧库先搬到 `migration/rollback-<jobId>/`；失败时反向恢复，成功后由 finalizeSwitch 删除。
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
  const annotationsDir = path.join(diaryDir, 'annotations')
  const hasCurrentAnnotations = await pathExists(annotationsDir)

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
  let annotationsBackedUp = false
  let vaultInstalled = false

  try {
    await fs.mkdir(target.dir, { recursive: true, mode: 0o700 })

    if (rollbackDir && hasCurrentVault) {
      await fs.rename(target.vaultFile, path.join(rollbackDir, 'diary.vault'))
      vaultBackedUp = true
    }
    if (rollbackDir && hasCurrentAttachments) {
      await fs.rename(target.attachmentsDir, path.join(rollbackDir, 'attachments'))
      attachmentsBackedUp = true
    }
    if (rollbackDir && hasCurrentAnnotations) {
      await fs.rename(annotationsDir, path.join(rollbackDir, 'annotations'))
      annotationsBackedUp = true
    }

    // 旧附件目录已搬走；保险起见清掉可能存在的空目录，再整体换成 staging 的
    if (await pathExists(target.attachmentsDir)) await removePath(target.attachmentsDir)
    await fs.rename(staging.attachmentsDir, target.attachmentsDir)

    // 批注目录整体换入（包内没有批注时就是一个空目录）
    await fs.rm(annotationsDir, { recursive: true, force: true })
    await fs.rename(staging.annotationsDir, annotationsDir).catch(async () => {
      await fs.mkdir(annotationsDir, { recursive: true, mode: 0o700 })
    })

    // 最后换 vault：即使中途断电，最坏情况是多出几个未被引用的附件
    await fs.rename(staging.vaultFile, target.vaultFile)
    vaultInstalled = true
  } catch (error) {
    if (vaultInstalled) {
      await fs.rename(target.vaultFile, path.join(staging.root, 'diary.vault')).catch(() => undefined)
    }
    if (attachmentsBackedUp && rollbackDir) {
      await fs.rename(path.join(rollbackDir, 'attachments'), target.attachmentsDir).catch(() => undefined)
    }
    if (annotationsBackedUp && rollbackDir) {
      await fs.rm(annotationsDir, { recursive: true, force: true }).catch(() => undefined)
      await fs.rename(path.join(rollbackDir, 'annotations'), annotationsDir).catch(() => undefined)
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
  const backupAnnotations = path.join(rollbackDir, 'annotations')
  const annotationsDir = path.join(diaryDir, 'annotations')
  if (await pathExists(backupAnnotations)) {
    await removePath(annotationsDir)
    await fs.rename(backupAnnotations, annotationsDir)
  }
}

export async function finalizeSwitch(rollbackDir: string | null): Promise<void> {
  if (!rollbackDir) return
  await removePath(rollbackDir)
}

export async function cleanupStaging(staging: StagingPaths): Promise<void> {
  await removePath(staging.root)
}

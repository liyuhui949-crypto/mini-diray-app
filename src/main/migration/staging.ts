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

export type SwitchMode = 'replace' | 'merge'

export interface SwitchResult {
  rollbackDir: string | null
}

/**
 * 把 staging 的 diary.vault（以及附件）换进正式目录。
 *
 * - `replace`：旧库的 vault 与 attachments 一起搬到 `migration/rollback-<jobId>/`，
 *   再把 staging 的整目录换进来；
 * - `merge`：只备份并替换 vault，staging 里的新附件逐个搬进现有 attachments 目录，
 *   原有附件原地保留（合并时它们仍被保留的条目引用）。
 *
 * 失败时反向恢复；成功后由 finalizeSwitch 删掉回滚目录。
 */
export async function switchStagingIntoPlace(
  diaryDir: string,
  staging: StagingPaths,
  jobId: string,
  mode: SwitchMode = 'replace'
): Promise<SwitchResult> {
  const target = vaultPaths(diaryDir)
  const migrationDir = target.migrationDir
  const hasCurrentVault = await pathExists(target.vaultFile)
  const hasCurrentAttachments = await pathExists(target.attachmentsDir)

  if (!(await pathExists(staging.vaultFile))) {
    throw new AppError('IO_ERROR', '导入暂存目录缺少日记库文件')
  }

  let rollbackDir: string | null = null
  if (hasCurrentVault || (mode === 'replace' && hasCurrentAttachments)) {
    rollbackDir = path.join(migrationDir, `rollback-${jobId}`)
    await removePath(rollbackDir).catch(() => undefined)
    await fs.mkdir(rollbackDir, { recursive: true, mode: 0o700 })
  }

  const movedIn: string[] = []
  let vaultBackedUp = false
  let attachmentsBackedUp = false
  let vaultInstalled = false

  try {
    await fs.mkdir(target.dir, { recursive: true, mode: 0o700 })

    if (rollbackDir && hasCurrentVault) {
      await fs.rename(target.vaultFile, path.join(rollbackDir, 'diary.vault'))
      vaultBackedUp = true
    }
    if (mode === 'replace' && rollbackDir && hasCurrentAttachments) {
      await fs.rename(target.attachmentsDir, path.join(rollbackDir, 'attachments'))
      attachmentsBackedUp = true
    }

    if (mode === 'replace') {
      // 旧附件目录已搬走；保险起见清掉可能存在的空目录，再整体换成 staging 的
      if (await pathExists(target.attachmentsDir)) await removePath(target.attachmentsDir)
      await fs.rename(staging.attachmentsDir, target.attachmentsDir)
    } else {
      await fs.mkdir(target.attachmentsDir, { recursive: true, mode: 0o700 })
      const files = await fs.readdir(staging.attachmentsDir).catch(() => [] as string[])
      for (const file of files) {
        await fs.rename(
          path.join(staging.attachmentsDir, file),
          path.join(target.attachmentsDir, file)
        )
        movedIn.push(file)
      }
    }

    // 最后换 vault：即使中途断电，最坏情况是多出几个未被引用的附件
    await fs.rename(staging.vaultFile, target.vaultFile)
    vaultInstalled = true
  } catch (error) {
    for (const file of movedIn) {
      await fs.rm(path.join(target.attachmentsDir, file), { force: true }).catch(() => undefined)
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

import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { AppError } from '@shared/errors'

export const VAULT_FILE = 'diary.vault'
export const ATTACHMENTS_DIR = 'attachments'
export const MIGRATION_DIR = 'migration'

export interface VaultPaths {
  dir: string
  vaultFile: string
  attachmentsDir: string
  migrationDir: string
}

export function vaultPaths(dir: string): VaultPaths {
  const resolved = path.resolve(dir)
  return {
    dir: resolved,
    vaultFile: path.join(resolved, VAULT_FILE),
    attachmentsDir: path.join(resolved, ATTACHMENTS_DIR),
    migrationDir: path.join(resolved, MIGRATION_DIR)
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export async function ensureVaultDirs(paths: VaultPaths): Promise<void> {
  await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 })
  await fs.mkdir(paths.attachmentsDir, { recursive: true, mode: 0o700 })
}

/** 目录内仅允许 UUID.mdat 与临时 .part 文件 */
export function isManagedAttachmentName(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mdat(\.part)?$/i.test(
    name
  )
}

/**
 * 路径必须位于 root 内部（用 realpath 解析符号链接后再比较）。
 * 用于所有来自渲染进程或迁移包的路径参数。
 */
export async function assertPathInside(root: string, target: string): Promise<string> {
  const realRoot = await fs.realpath(root)
  let realTarget: string
  try {
    realTarget = await fs.realpath(target)
  } catch {
    realTarget = path.resolve(target)
  }
  const relative = path.relative(realRoot, realTarget)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('PERMISSION_DENIED', '目标路径不在允许的目录内')
  }
  return realTarget
}

async function fsyncDirectory(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Windows 上目录句柄无法 fsync，忽略
  }
}

/** 原子写入：临时文件 → fsync → rename → fsync 目录 */
export async function atomicWriteFile(
  filePath: string,
  data: Buffer | string,
  mode = 0o600
): Promise<void> {
  const dir = path.dirname(filePath)
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(tempPath, 'w', mode)
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    if (handle) await handle.close()
  }
  try {
    await fs.rename(tempPath, filePath)
    await fs.chmod(filePath, mode).catch(() => undefined)
    await fsyncDirectory(dir)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 递归复制（不保留符号链接，符号链接直接跳过） */
export async function copyDirectory(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true, mode: 0o700 })
  const entries = await fs.readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await copyDirectory(source, target)
    } else if (entry.isFile()) {
      await fs.copyFile(source, target)
      await fs.chmod(target, 0o600).catch(() => undefined)
    }
  }
}

/** 跨设备时 rename 会失败，退化为复制 + 删除 */
export async function movePath(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw error
    await fs.cp(from, to, { recursive: true, force: true })
    await fs.rm(from, { recursive: true, force: true })
  }
}

export async function removePath(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true })
}

export async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.stat(target)
  } catch {
    return null
  }
}

export async function freeSpaceCheck(dir: string, requiredBytes: number): Promise<void> {
  try {
    const stats = await fs.statfs(dir)
    const available = Number(stats.bavail) * Number(stats.bsize)
    if (Number.isFinite(available) && available > 0 && available < requiredBytes) {
      throw new AppError('NOT_ENOUGH_SPACE')
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    // statfs 在部分平台不可用时不阻塞流程
  }
}

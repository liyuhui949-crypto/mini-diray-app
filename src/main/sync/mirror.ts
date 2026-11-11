import fs from 'node:fs/promises'
import path from 'node:path'

import { AppError } from '@shared/errors'
import { diaryEntrySchema } from '@shared/schemas'
import type { Annotation, DiaryEntry, LocalDate } from '@shared/types'

import { parseAnnotationText } from '../vault/annotations'
import { decryptGcm, encryptGcm } from '../vault/crypto'
import { atomicWriteFile, removePath } from '../vault/paths'
import type { VaultRepository } from '../vault/repository'

/**
 * Git 同步镜像：本地日记库仍然是单个 diary.vault，这里只生成可提交的派生文件。
 * 今天（含今天的批注）永远不写入镜像，避免把未封存的当天内容推到远端。
 */
const SYNC_DIR = '.sync'
const SYNC_FORMAT = 1
const SYNC_META = 'sync.json'
const ENTRIES_DIR = 'entries'
const ANNOTATIONS_DIR = 'annotations'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface SyncMeta {
  format: number
  vaultId: string
}

function syncAad(vaultId: string, date: string): string {
  return `MINIDIARY|sync-entry|1|${vaultId}|${date}`
}

export function syncRoot(diaryDir: string): string {
  return path.join(diaryDir, SYNC_DIR)
}

export function syncEntriesDir(root: string): string {
  return path.join(root, ENTRIES_DIR)
}

function syncAnnotationsDir(root: string): string {
  return path.join(root, ANNOTATIONS_DIR)
}

function entryFileName(date: string): string {
  return `${date}.ink`
}

async function ensureDirs(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  await fs.mkdir(syncEntriesDir(root), { recursive: true, mode: 0o700 })
  await fs.mkdir(syncAnnotationsDir(root), { recursive: true, mode: 0o700 })
}

async function readMeta(root: string): Promise<SyncMeta | null> {
  const file = path.join(root, SYNC_META)
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as SyncMeta).format === SYNC_FORMAT &&
      typeof (parsed as SyncMeta).vaultId === 'string'
    ) {
      return parsed as SyncMeta
    }
  } catch {
    // 没有 meta 或损坏，下面按缺失处理
  }
  return null
}

async function ensureMeta(root: string, vaultId: string): Promise<void> {
  const existing = await readMeta(root)
  if (existing) {
    if (existing.vaultId !== vaultId) throw new AppError('SYNC_VAULT_MISMATCH')
    return
  }
  await atomicWriteFile(
    path.join(root, SYNC_META),
    JSON.stringify({ format: SYNC_FORMAT, vaultId }, null, 2),
    0o600
  )
}

async function decryptEntryFile(
  filePath: string,
  key: Buffer,
  vaultId: string
): Promise<DiaryEntry | null> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      format?: number
      vaultId?: string
      date?: string
      block?: { alg?: string; iv?: string; ciphertext?: string; tag?: string }
    }
    if (raw.format !== SYNC_FORMAT || raw.vaultId !== vaultId || !raw.date || !raw.block) return null
    if (!DATE_RE.test(raw.date) || path.basename(filePath) !== entryFileName(raw.date)) return null
    const plaintext = decryptGcm(key, raw.block as never, syncAad(vaultId, raw.date))
    const parsed = diaryEntrySchema.safeParse(JSON.parse(plaintext.toString('utf8')))
    return parsed.success ? (parsed.data as DiaryEntry) : null
  } catch {
    return null
  }
}

async function writeEntryFile(
  root: string,
  key: Buffer,
  vaultId: string,
  entry: DiaryEntry
): Promise<void> {
  const block = encryptGcm(
    key,
    Buffer.from(JSON.stringify(entry), 'utf8'),
    syncAad(vaultId, entry.date)
  )
  const payload = JSON.stringify({
    format: SYNC_FORMAT,
    vaultId,
    date: entry.date,
    block
  })
  await atomicWriteFile(path.join(syncEntriesDir(root), entryFileName(entry.date)), payload, 0o600)
}

function dateFromEntryName(name: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.ink$/.exec(name)
  return match?.[1] ?? null
}

function dateFromAnnotationName(name: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.ann$/.exec(name)
  return match?.[1] ?? null
}

export async function readMirrorVaultId(root: string): Promise<string | null> {
  return (await readMeta(root))?.vaultId ?? null
}

/**
 * 从 vault 生成/更新镜像。
 * - 只写今天以前的条目与批注；
 * - 解密后发现内容没变就不重写，保证 git 看到的只有真正变化的文件（M）。
 */
export async function buildMirror(
  repository: VaultRepository,
  today: LocalDate
): Promise<{ root: string; changed: number }> {
  const root = syncRoot(repository.vaultDir)
  const vaultId = repository.getVaultId()
  await ensureDirs(root)
  await ensureMeta(root, vaultId)

  const key = repository.getSyncKey()
  let changed = 0

  for (const entry of repository.getSyncEntries(today)) {
    const file = path.join(syncEntriesDir(root), entryFileName(entry.date))
    const existing = await decryptEntryFile(file, key, vaultId)
    if (existing && JSON.stringify(existing) === JSON.stringify(entry)) continue
    await writeEntryFile(root, key, vaultId, entry)
    changed += 1
  }

  // 今天/未来日期的条目一律不留在镜像里
  const entryNames = await fs.readdir(syncEntriesDir(root)).catch(() => [] as string[])
  for (const name of entryNames) {
    const date = dateFromEntryName(name)
    if (!date || date >= today) {
      await removePath(path.join(syncEntriesDir(root), name))
      changed += 1
    }
  }

  const annotationDir = path.join(repository.vaultDir, 'annotations')
  const annotationFiles = await fs.readdir(annotationDir).catch(() => [] as string[])
  for (const name of annotationFiles) {
    const date = dateFromAnnotationName(name)
    if (!date || date >= today) continue
    const source = path.join(annotationDir, name)
    const target = path.join(syncAnnotationsDir(root), name)
    const [sourceBytes, targetBytes] = await Promise.all([
      fs.readFile(source).catch(() => null),
      fs.readFile(target).catch(() => null)
    ])
    if (!sourceBytes) continue
    if (targetBytes && sourceBytes.equals(targetBytes)) continue
    await atomicWriteFile(target, sourceBytes, 0o600)
    changed += 1
  }

  const mirrorAnnotationNames = await fs
    .readdir(syncAnnotationsDir(root))
    .catch(() => [] as string[])
  for (const name of mirrorAnnotationNames) {
    const date = dateFromAnnotationName(name)
    if (!date || date >= today) {
      await removePath(path.join(syncAnnotationsDir(root), name))
      changed += 1
    }
  }

  return { root, changed }
}

export async function readMirror(
  repository: VaultRepository,
  today: LocalDate
): Promise<{ entries: DiaryEntry[]; annotations: Record<string, Annotation[]> }> {
  const root = syncRoot(repository.vaultDir)
  const vaultId = repository.getVaultId()
  const meta = await readMeta(root)
  if (!meta) return { entries: [], annotations: {} }
  if (meta.vaultId !== vaultId) throw new AppError('SYNC_VAULT_MISMATCH')

  const key = repository.getSyncKey()
  const entries: DiaryEntry[] = []
  const names = await fs.readdir(syncEntriesDir(root)).catch(() => [] as string[])
  for (const name of names) {
    const date = dateFromEntryName(name)
    if (!date || date >= today) continue
    const entry = await decryptEntryFile(path.join(syncEntriesDir(root), name), key, vaultId)
    if (!entry) throw new AppError('SYNC_MIRROR_CORRUPT')
    entries.push(entry)
  }
  entries.sort((a, b) => (a.date < b.date ? -1 : 1))

  const annotations: Record<string, Annotation[]> = {}
  const annotationKey = repository.getAnnotationKey()
  const annotationNames = await fs
    .readdir(syncAnnotationsDir(root))
    .catch(() => [] as string[])
  for (const name of annotationNames) {
    const date = dateFromAnnotationName(name)
    if (!date || date >= today) continue
    const text = await fs.readFile(path.join(syncAnnotationsDir(root), name), 'utf8')
    let records: Annotation[]
    try {
      records = parseAnnotationText(date, text, annotationKey)
    } catch {
      throw new AppError('SYNC_MIRROR_CORRUPT')
    }
    if (records.length > 0) annotations[date] = records
  }

  return { entries, annotations }
}

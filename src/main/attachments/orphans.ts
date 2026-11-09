import path from 'node:path'

import type { AttachmentKind, OrphanAttachment } from '@shared/types'

import type { VaultRepository } from '../vault/repository'
import { detectType } from './format'
import type { AttachmentStore } from './store'

const HEAD_SNIFF_BYTES = 4096

interface OrphanScanResult {
  /** 没有被任何 entry 引用的附件 */
  items: OrphanAttachment[]
  bytes: number
  /** attachments 目录里的文件总数与总体积（含被引用的） */
  totalCount: number
  totalBytes: number
}

/**
 * 从未引用附件的明文头部推断类型（没有原始文件名，只能靠魔数）。
 * 代理层与附件库共用这一份，避免各自写一遍嗅探。
 */
export async function detectPlainType(
  store: AttachmentStore,
  id: string,
  meta: { size: number; totalChunks: number; chunkSize: number }
): Promise<{ kind: AttachmentKind; mime: string }> {
  if (meta.size <= 0) return { kind: 'file', mime: 'application/octet-stream' }
  const head = await store.readBytes(id, meta, 0, Math.min(meta.size, HEAD_SNIFF_BYTES))
  return detectType('', head)
}

/**
 * 扫一遍 attachments 目录：既返回未引用附件，也返回全量计数。
 * `sniff: false` 时不做解密嗅探（统计页只需要数字，避免多余解密）。
 */
export async function scanOrphans(
  repository: VaultRepository,
  store: AttachmentStore,
  options: { sniff?: boolean } = {}
): Promise<OrphanScanResult> {
  const referenced = new Set(
    repository.isUnlocked
      ? repository
          .getSnapshot()
          .entries.flatMap((entry) => entry.attachments.map((item) => item.id))
      : []
  )
  const files = await store.listFiles()
  const items: OrphanAttachment[] = []
  let bytes = 0
  let totalBytes = 0

  for (const file of files) {
    const id = path.basename(file, '.mdat')
    const meta = await store.describe(id)
    totalBytes += meta.size
    if (referenced.has(id)) continue

    let kind: AttachmentKind = 'file'
    if (options.sniff !== false) {
      try {
        kind = (await detectPlainType(store, id, meta)).kind
      } catch {
        kind = 'file'
      }
    }
    items.push({ id, size: meta.size, kind })
    bytes += meta.size
  }

  return { items, bytes, totalCount: files.length, totalBytes }
}

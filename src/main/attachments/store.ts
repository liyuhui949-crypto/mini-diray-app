import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import { AppError } from '@shared/errors'
import type { Attachment, AttachmentKind } from '@shared/types'

import { logger } from '../logger'
import { randomUuid, sha256Hex } from '../vault/crypto'
import { ATTACHMENTS_DIR, atomicWriteFile, vaultPaths, type VaultPaths } from '../vault/paths'
import {
  DEFAULT_CHUNK_SIZE,
  MDAT_HEADER_SIZE,
  MDAT_TAG_SIZE,
  buildHeader,
  chunkCipherOffset,
  decryptChunk,
  deriveFileKey,
  detectType,
  encryptChunk,
  expectedFileSize,
  parseHeader,
  planRangeChunks,
  totalChunksFor,
  uuidHexToBytes,
  verifyHeaderTag,
  writeHeaderTag,
  type MdatHeader
} from './format'
import { encryptMdatStream } from './stream'

export const SIZE_LIMITS: Record<AttachmentKind, number> = {
  image: 50 * 1024 * 1024,
  audio: 500 * 1024 * 1024,
  video: 2 * 1024 * 1024 * 1024,
  file: 2 * 1024 * 1024 * 1024
}

const HEAD_SNIFF_BYTES = 4096

export interface AddProgress {
  bytesDone: number
  bytesTotal: number
}

export interface AddOptions {
  onProgress?: (progress: AddProgress) => void
  signal?: AbortSignal
  /** 已知 MIME（来自拖拽/剪贴板），作为嗅探失败后的兜底 */
  mimeHint?: string
  /** 覆盖文件名（粘贴图片时没有真实文件名） */
  nameOverride?: string
}

interface Sniffed {
  name: string
  size: number
  kind: AttachmentKind
  mime: string
}

function sanitizeFileName(raw: string): string {
  const base = raw.replace(/[/\\?%*:|"<>]/g, '_').replace(/^\.+/, '').trim()
  return (base.length > 0 ? base : 'attachment').slice(0, 255)
}

async function readHead(filePath: string, length = HEAD_SNIFF_BYTES): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function assertWithinLimit(size: number, kind: AttachmentKind): void {
  const limit = SIZE_LIMITS[kind]
  if (size <= 0) throw new AppError('INVALID_INPUT', '空文件不能作为附件')
  if (size > limit) {
    const label = kind === 'image' ? '图片 50 MB' : kind === 'audio' ? '音频 500 MB' : '2 GB'
    throw new AppError('INVALID_INPUT', `文件超过${label}上限`)
  }
}

/**
 * 附件仓库：所有读写都是流式的，任何时刻都不把整个附件读进内存。
 * 密钥来自 VaultRepository（DEK 派生），锁定后立即不可读。
 */
export class AttachmentStore {
  private readonly paths: VaultPaths
  private readonly keyProvider: () => Buffer

  constructor(diaryDir: string, keyProvider: () => Buffer) {
    this.paths = vaultPaths(diaryDir)
    this.keyProvider = keyProvider
  }

  setDiaryDir(dir: string): void {
    Object.assign(this.paths, vaultPaths(dir))
  }

  private filePath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('INVALID_INPUT', '非法附件 ID')
    return path.join(this.paths.attachmentsDir, `${id}.mdat`)
  }

  private get attachmentKey(): Buffer {
    return this.keyProvider()
  }

  async sniff(sourcePath: string): Promise<Sniffed> {
    const stats = await fs.stat(sourcePath).catch(() => {
      throw new AppError('NOT_FOUND', '源文件不存在')
    })
    if (!stats.isFile()) throw new AppError('INVALID_INPUT', '只能添加文件')
    const head = await readHead(sourcePath)
    const name = sanitizeFileName(path.basename(sourcePath))
    const detected = detectType(name, head)
    assertWithinLimit(stats.size, detected.kind)
    return { name, size: stats.size, kind: detected.kind, mime: detected.mime }
  }

  /** 从路径流式加密写入；先写 .part，成功后才 rename */
  async addFromFile(sourcePath: string, options: AddOptions = {}): Promise<Attachment> {
    const sniffed = await this.sniff(sourcePath)
    return this.writeFromFile(sourcePath, {
      ...sniffed,
      nameOverride: options.nameOverride
    }, options)
  }

  /** 粘贴图片：字节已在内存（≤50MB），同样走分块加密 */
  async addFromBytes(input: { name: string; mime: string; bytes: Uint8Array }): Promise<Attachment> {
    const bytes = Buffer.from(input.bytes)
    if (bytes.length === 0) throw new AppError('INVALID_INPUT', '空文件不能作为附件')
    const name = sanitizeFileName(input.name)
    const detected = detectType(name, bytes.subarray(0, HEAD_SNIFF_BYTES), input.mime)
    assertWithinLimit(bytes.length, detected.kind)
    return this.writeFromBuffer(bytes, { name, kind: detected.kind, mime: detected.mime })
  }

  private async writeFromFile(
    sourcePath: string,
    meta: { name: string; size: number; kind: AttachmentKind; mime: string; nameOverride?: string },
    options: AddOptions
  ): Promise<Attachment> {
    const id = randomUuid()
    const fileId = uuidHexToBytes(id)
    const chunkSize = DEFAULT_CHUNK_SIZE
    const totalChunks = totalChunksFor(meta.size, chunkSize)
    const { header, fileKeyHeader } = buildHeader({ fileId, plaintextSize: meta.size, chunkSize })
    const fileKey = deriveFileKey(this.attachmentKey, fileId)
    writeHeaderTag(header, fileKey)

    const targetPath = this.filePath(id)
    const partPath = `${targetPath}.part`
    const name = sanitizeFileName(options.nameOverride ?? meta.name)
    await fs.mkdir(this.paths.attachmentsDir, { recursive: true, mode: 0o700 })

    const hash = createHash('sha256')
    const source = await fs.open(sourcePath, 'r')
    const destination = await fs.open(partPath, 'w', 0o600)
    let done = 0
    try {
      await destination.write(header, 0, header.length, 0)
      let offset = MDAT_HEADER_SIZE
      const buffer = Buffer.alloc(chunkSize)
      for (let index = 0; index < totalChunks; index++) {
        if (options.signal?.aborted) throw new AppError('CANCELLED')
        const length =
          index === totalChunks - 1 ? meta.size - chunkSize * (totalChunks - 1) : chunkSize
        const plaintext = await readFully(source, buffer, length, index * chunkSize)
        if (plaintext.length !== length) throw new AppError('IO_ERROR', '源文件读取不完整')
        hash.update(plaintext)
        const ciphertext = encryptChunk(fileKey, fileKeyHeader, index, plaintext)
        await destination.write(ciphertext, 0, ciphertext.length, offset)
        offset += ciphertext.length
        done += length
        options.onProgress?.({ bytesDone: done, bytesTotal: meta.size })
      }
      await destination.sync()
    } catch (error) {
      await destination.close().catch(() => undefined)
      await source.close().catch(() => undefined)
      await fs.rm(partPath, { force: true }).catch(() => undefined)
      throw error
    }
    await destination.close()
    await source.close()
    await fs.rename(partPath, targetPath)
    await fs.chmod(targetPath, 0o600).catch(() => undefined)

    const attachment: Attachment = {
      id,
      name,
      mime: meta.mime,
      kind: meta.kind,
      size: meta.size,
      sha256: hash.digest('hex'),
      chunkSize,
      totalChunks,
      createdAt: new Date().toISOString()
    }
    logger.info('attachment written', { id, kind: meta.kind, bytes: meta.size })
    return attachment
  }

  private async writeFromBuffer(
    bytes: Buffer,
    meta: { name: string; kind: AttachmentKind; mime: string }
  ): Promise<Attachment> {
    const id = randomUuid()
    const fileId = uuidHexToBytes(id)
    const chunkSize = DEFAULT_CHUNK_SIZE
    const totalChunks = totalChunksFor(bytes.length, chunkSize)
    const { header, fileKeyHeader } = buildHeader({ fileId, plaintextSize: bytes.length, chunkSize })
    const fileKey = deriveFileKey(this.attachmentKey, fileId)
    writeHeaderTag(header, fileKey)

    const parts: Buffer[] = [header]
    for (let index = 0; index < totalChunks; index++) {
      const start = index * chunkSize
      const plaintext = bytes.subarray(start, Math.min(start + chunkSize, bytes.length))
      parts.push(encryptChunk(fileKey, fileKeyHeader, index, plaintext))
    }
    const targetPath = this.filePath(id)
    const partPath = `${targetPath}.part`
    await fs.mkdir(this.paths.attachmentsDir, { recursive: true, mode: 0o700 })
    try {
      await atomicWriteFile(partPath, Buffer.concat(parts))
      await fs.rename(partPath, targetPath)
      await fs.chmod(targetPath, 0o600).catch(() => undefined)
    } catch (error) {
      await fs.rm(partPath, { force: true }).catch(() => undefined)
      throw error
    }

    return {
      id,
      name: sanitizeFileName(meta.name),
      mime: meta.mime,
      kind: meta.kind,
      size: bytes.length,
      sha256: sha256Hex(bytes),
      chunkSize,
      totalChunks,
      createdAt: new Date().toISOString()
    }
  }

  private async readHeader(id: string, expected?: { size: number; totalChunks: number; chunkSize: number }): Promise<{ header: MdatHeader; fileKey: Buffer; handle: fs.FileHandle }> {
    const filePath = this.filePath(id)
    const handle = await fs.open(filePath, 'r').catch(() => {
      throw new AppError('NOT_FOUND', '附件文件不存在')
    })
    try {
      const buffer = Buffer.alloc(MDAT_HEADER_SIZE)
      const { bytesRead } = await handle.read(buffer, 0, MDAT_HEADER_SIZE, 0)
      if (bytesRead !== MDAT_HEADER_SIZE) throw new AppError('CORRUPT_VAULT', '附件头不完整')
      const header = parseHeader(buffer)
      const fileKey = deriveFileKey(this.attachmentKey, header.fileId)
      if (!verifyHeaderTag(buffer, fileKey)) throw new AppError('CORRUPT_VAULT', '附件头校验失败')
      if (expected) {
        if (
          expected.size !== header.plaintextSize ||
          expected.totalChunks !== header.totalChunks ||
          expected.chunkSize !== header.chunkSize
        ) {
          throw new AppError('CORRUPT_VAULT', '附件元数据与文件不一致')
        }
      }
      return { header, fileKey, handle }
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  /** 读取明文的任意区间 [start, end)，按需解密相关分块 */
  async *readRange(
    id: string,
    expected: { size: number; totalChunks: number; chunkSize: number },
    start: number,
    end: number,
    signal?: AbortSignal
  ): AsyncGenerator<Buffer> {
    if (start < 0 || end > expected.size || start >= end) {
      throw new AppError('INVALID_INPUT', 'Range 越界')
    }
    const { header, fileKey, handle } = await this.readHeader(id, expected)
    try {
      const plans = planRangeChunks(header, start, end)
      for (const plan of plans) {
        if (signal?.aborted) throw new AppError('CANCELLED')
        const offset = chunkCipherOffset(header.chunkSize, plan.index)
        const plainLength = header.totalChunks - 1 === plan.index
          ? header.plaintextSize - header.chunkSize * (header.totalChunks - 1)
          : header.chunkSize
        const buffer = Buffer.alloc(plainLength + MDAT_TAG_SIZE)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (bytesRead !== buffer.length) throw new AppError('CORRUPT_VAULT', '附件被截断')
        const plaintext = decryptChunk(fileKey, header, plan.index, buffer)
        yield plaintext.subarray(plan.from, plan.to)
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  /** 完整明文流（导出/PDF 用） */
  streamPlaintext(
    id: string,
    expected: { size: number; totalChunks: number; chunkSize: number },
    signal?: AbortSignal
  ): Readable {
    return Readable.from(this.readRange(id, expected, 0, Math.max(1, expected.size), signal))
  }

  /** 只读一段明文到内存（小范围预览用） */
  async readBytes(
    id: string,
    expected: { size: number; totalChunks: number; chunkSize: number },
    start: number,
    end: number
  ): Promise<Buffer> {
    const parts: Buffer[] = []
    for await (const chunk of this.readRange(id, expected, start, end)) parts.push(chunk)
    return Buffer.concat(parts)
  }

  /** 流式校验 SHA-256，不改动文件 */
  async verify(attachment: Pick<Attachment, 'id' | 'size' | 'totalChunks' | 'chunkSize' | 'sha256'>): Promise<boolean> {
    const hash = createHash('sha256')
    try {
      for await (const chunk of this.readRange(
        attachment.id,
        { size: attachment.size, totalChunks: attachment.totalChunks, chunkSize: attachment.chunkSize },
        0,
        Math.max(1, attachment.size)
      )) {
        hash.update(chunk)
      }
    } catch {
      return false
    }
    return hash.digest('hex') === attachment.sha256
  }

  /** 删除附件密文（清理未引用附件时使用） */
  async remove(id: string): Promise<void> {
    await fs.rm(this.filePath(id), { force: true })
  }

  async listFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.paths.attachmentsDir).catch(() => [] as string[])
    return entries.filter((name) => name.endsWith('.mdat') && !name.endsWith('.part'))
  }

  /** 清理残留的 .part 临时文件（启动与取消任务时调用） */
  async cleanupParts(): Promise<number> {
    const entries = await fs.readdir(this.paths.attachmentsDir).catch(() => [] as string[])
    let removed = 0
    for (const name of entries) {
      if (!name.endsWith('.part')) continue
      await fs.rm(path.join(this.paths.attachmentsDir, name), { force: true }).catch(() => undefined)
      removed += 1
    }
    return removed
  }

  async sizeOf(id: string): Promise<number> {
    const stats = await fs.stat(this.filePath(id)).catch(() => null)
    return stats?.size ?? 0
  }

  async totalBytes(): Promise<number> {
    const files = await this.listFiles()
    let total = 0
    for (const file of files) {
      const stats = await fs.stat(path.join(this.paths.attachmentsDir, file)).catch(() => null)
      if (stats) total += stats.size
    }
    return total
  }

  /**
   * 把明文流重新加密成一个新的 MDAT 文件（迁移 replace/merge 时为附件换 ID 或换密钥）。
   * 明文分块直接写密文到 .part，成功后 rename。
   */
  async encryptFromReadable(input: {
    id: string
    size: number
    source: AsyncIterable<Buffer>
    chunkSize?: number
    signal?: AbortSignal
    onBytes?: (bytes: number) => void
  }): Promise<{ sha256: string; totalChunks: number; chunkSize: number }> {
    const targetPath = this.filePath(input.id)
    const partPath = `${targetPath}.part`
    await fs.mkdir(this.paths.attachmentsDir, { recursive: true, mode: 0o700 })

    const generator = encryptMdatStream(input.source, {
      attachmentKey: this.attachmentKey,
      fileId: input.id,
      size: input.size,
      ...(input.chunkSize ? { chunkSize: input.chunkSize } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    })

    const handle = await fs.open(partPath, 'w', 0o600)
    let result: { sha256: string; totalChunks: number; chunkSize: number } | null = null
    try {
      for (;;) {
        const next = await generator.next()
        if (next.done) {
          result = next.value
          break
        }
        const chunk = next.value
        await handle.write(chunk, 0, chunk.length)
        input.onBytes?.(chunk.length)
      }
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await fs.rm(partPath, { force: true }).catch(() => undefined)
      throw error
    }
    await handle.close()
    await fs.rename(partPath, targetPath)
    await fs.chmod(targetPath, 0o600).catch(() => undefined)
    if (!result) throw new AppError('IO_ERROR', '附件加密失败')
    return result
  }

  /** 迁移导入时需要把外部 .mdat 原样复制进来（密文不变） */
  async importRawFile(id: string, source: Readable): Promise<number> {
    const targetPath = this.filePath(id)
    const partPath = `${targetPath}.part`
    await fs.mkdir(this.paths.attachmentsDir, { recursive: true, mode: 0o700 })
    const hash = createHash('sha256')
    const handle = await fs.open(partPath, 'w', 0o600)
    let size = 0
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        hash.update(buffer)
        await handle.write(buffer, 0, buffer.length)
        size += buffer.length
      }
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await fs.rm(partPath, { force: true }).catch(() => undefined)
      throw error
    }
    await handle.close()
    await fs.rename(partPath, targetPath)
    await fs.chmod(targetPath, 0o600).catch(() => undefined)
    return size
  }

  /** 解密一个附件到目标路径（流式），用于「另存为 / 导出」 */
  async exportTo(
    attachment: Pick<Attachment, 'id' | 'size' | 'totalChunks' | 'chunkSize'>,
    targetPath: string
  ): Promise<void> {
    const handle = await fs.open(targetPath, 'w', 0o600)
    try {
      for await (const chunk of this.readRange(
        attachment.id,
        { size: attachment.size, totalChunks: attachment.totalChunks, chunkSize: attachment.chunkSize },
        0,
        Math.max(1, attachment.size)
      )) {
        await handle.write(chunk, 0, chunk.length)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /** 供 protocol handler 做 Range 响应头 */
  async inspect(
    id: string,
    expected: { size: number; totalChunks: number; chunkSize: number }
  ): Promise<{ header: MdatHeader }> {
    const { header, handle } = await this.readHeader(id, expected)
    await handle.close().catch(() => undefined)
    return { header }
  }

  static expectedFileSize = expectedFileSize
  static readonly attachmentsDirName = ATTACHMENTS_DIR
}

/** 把位置读满：磁盘读取可能少于请求长度 */
async function readFully(
  handle: fs.FileHandle,
  buffer: Buffer,
  length: number,
  position: number
): Promise<Buffer> {
  const target = buffer.subarray(0, length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(target, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return target.subarray(0, filled)
}

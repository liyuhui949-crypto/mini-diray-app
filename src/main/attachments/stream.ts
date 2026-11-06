import { createHash } from 'node:crypto'

import { AppError } from '@shared/errors'

import {
  DEFAULT_CHUNK_SIZE,
  MDAT_HEADER_SIZE,
  MDAT_TAG_SIZE,
  buildHeader,
  chunkPlainLength,
  decryptChunk,
  deriveFileKey,
  encryptChunk,
  parseHeader,
  totalChunksFor,
  uuidHexToBytes,
  verifyHeaderTag,
  writeHeaderTag,
  type MdatHeader
} from './format'

function isAsyncIterable(value: unknown): value is AsyncIterable<Buffer> {
  return typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
}

/** 从异步字节流里按需读满 N 字节；不足即视为流被截断 */
export class AsyncByteReader {
  private readonly iterator: AsyncIterator<Buffer>
  private pending: Buffer = Buffer.alloc(0)
  private exhausted = false

  constructor(source: AsyncIterable<Buffer> | Iterable<Buffer>) {
    if (isAsyncIterable(source)) {
      this.iterator = source[Symbol.asyncIterator]()
    } else {
      this.iterator = (async function* () {
        for (const chunk of source) yield chunk
      })()
    }
  }

  async readExact(length: number): Promise<Buffer> {
    const parts: Buffer[] = []
    let collected = 0
    while (collected < length) {
      if (this.pending.length > 0) {
        const take = Math.min(this.pending.length, length - collected)
        parts.push(this.pending.subarray(0, take))
        this.pending = this.pending.subarray(take)
        collected += take
        continue
      }
      if (this.exhausted) throw new AppError('CORRUPT_VAULT', '附件数据被截断')
      const next = await this.iterator.next()
      if (next.done) {
        this.exhausted = true
        continue
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array)
      if (chunk.length > 0) this.pending = chunk
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
  }

  async readAll(): Promise<Buffer> {
    const parts: Buffer[] = []
    if (this.pending.length > 0) {
      parts.push(this.pending)
      this.pending = Buffer.alloc(0)
    }
    while (!this.exhausted) {
      const next = await this.iterator.next()
      if (next.done) {
        this.exhausted = true
        break
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array)
      parts.push(chunk)
    }
    return Buffer.concat(parts)
  }
}

export interface MdatMeta {
  size: number
  chunkSize: number
  totalChunks: number
}

/**
 * 解密一个 MDAT 密文流（迁移导入时从 ZIP 里读出来）。
 * 逐块校验 GCM，任何篡改/截断都会抛错。
 */
export async function* decryptMdatStream(
  source: AsyncIterable<Buffer>,
  attachmentKey: Buffer,
  expected: MdatMeta,
  options: { onBytes?: (bytes: number) => void; signal?: AbortSignal } = {}
): AsyncGenerator<Buffer> {
  const reader = new AsyncByteReader(source)
  const headerBuffer = await reader.readExact(MDAT_HEADER_SIZE)
  const header = parseHeader(headerBuffer)
  const fileKey = deriveFileKey(attachmentKey, header.fileId)
  if (!verifyHeaderTag(headerBuffer, fileKey)) {
    throw new AppError('CORRUPT_VAULT', '附件头校验失败')
  }
  if (
    header.plaintextSize !== expected.size ||
    header.chunkSize !== expected.chunkSize ||
    header.totalChunks !== expected.totalChunks
  ) {
    throw new AppError('CORRUPT_VAULT', '附件元数据与文件不一致')
  }

  let emitted = 0
  for (let index = 0; index < header.totalChunks; index++) {
    if (options.signal?.aborted) throw new AppError('CANCELLED')
    const plainLength = chunkPlainLength(header, index)
    const ciphertext = await reader.readExact(plainLength + MDAT_TAG_SIZE)
    const plaintext = decryptChunk(fileKey, header, index, ciphertext)
    emitted += plaintext.length
    options.onBytes?.(plaintext.length)
    yield plaintext
  }

  if (emitted !== header.plaintextSize) throw new AppError('CORRUPT_VAULT', '附件长度不一致')
}

export interface EncryptStreamOptions {
  attachmentKey: Buffer
  fileId: string
  size: number
  chunkSize?: number
  noncePrefix?: Buffer
  signal?: AbortSignal
}

/**
 * 把明文流重新加密为 MDAT（迁移 merge / replace 已有库时重新加密附件）。
 * 返回：首个 yield 是 64 字节头，其余是各分块密文；通过生成器返回值拿到 sha256。
 */
export async function* encryptMdatStream(
  source: AsyncIterable<Buffer>,
  options: EncryptStreamOptions
): AsyncGenerator<Buffer, { sha256: string; totalChunks: number; chunkSize: number }, void> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  const fileId = uuidHexToBytes(options.fileId)
  const { header, fileKeyHeader } = buildHeader({
    fileId,
    plaintextSize: options.size,
    chunkSize,
    noncePrefix: options.noncePrefix
  })
  const fileKey = deriveFileKey(options.attachmentKey, fileId)
  writeHeaderTag(header, fileKey)

  const hash = createHash('sha256')
  const reader = new AsyncByteReader(source)
  yield header

  const totalChunks = totalChunksFor(options.size, chunkSize)
  for (let index = 0; index < totalChunks; index++) {
    if (options.signal?.aborted) throw new AppError('CANCELLED')
    const length = chunkPlainLength(fileKeyHeader, index)
    const plaintext = await reader.readExact(length)
    hash.update(plaintext)
    yield encryptChunk(fileKey, fileKeyHeader, index, plaintext)
  }

  return { sha256: hash.digest('hex'), totalChunks, chunkSize }
}

export type { MdatHeader }

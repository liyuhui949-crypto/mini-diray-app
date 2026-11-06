import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'

import { AppError } from '@shared/errors'
import type { AttachmentKind } from '@shared/types'

/**
 * MDAT v1：分块 AEAD 容器。
 *
 * 偏移  字段            长度
 * 0     magic "MDAT"     4
 * 4     version          1   (=1)
 * 5     flags            1
 * 6     headerSize       2   (=64)
 * 8     fileId          16   UUID 原始字节
 * 24    chunkSize        4
 * 28    totalChunks      4
 * 32    plaintextSize    8
 * 40    noncePrefix      8
 * 48    headerTag       16   HMAC-SHA256(fileKey, header[0..48]) 截断
 *
 * 每个分块：nonce = noncePrefix(8) || uint32be(i)
 *           AAD   = header[0..48] || uint32be(i) || uint32be(chunkPlainLength)
 *           密文  = AES-256-GCM(plaintext) || 16B tag
 *
 * 选它的原因：2GB 视频不能整体读入内存；视频 seek 需要随机访问；
 * 分块 AEAD 同时满足流式、随机读与完整性校验。
 */

export const MDAT_MAGIC = 'MDAT'
export const MDAT_VERSION = 1
export const MDAT_HEADER_SIZE = 64
export const MDAT_TAG_SIZE = 16
export const MDAT_TAG_OFFSET = 48
export const DEFAULT_CHUNK_SIZE = 1024 * 1024
export const MAX_HEADER_CHUNK_SIZE = 16 * 1024 * 1024

export interface MdatHeader {
  version: number
  flags: number
  headerSize: number
  fileId: Buffer
  chunkSize: number
  totalChunks: number
  plaintextSize: number
  noncePrefix: Buffer
  /** header[0..48]，作为所有分块的 AAD 前缀 */
  prefix: Buffer
}

export function uuidBytesToHex(bytes: Buffer): string {
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function uuidHexToBytes(uuid: string): Buffer {
  const clean = uuid.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(clean)) throw new AppError('INVALID_INPUT', '非法附件 ID')
  return Buffer.from(clean, 'hex')
}

/** fileKey = HKDF-SHA256(attachmentKey, salt=fileId, info="mdat-v1") */
export function deriveFileKey(attachmentKey: Buffer, fileId: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', attachmentKey, fileId, Buffer.from('mdat-v1', 'utf8'), 32))
}

export function totalChunksFor(plaintextSize: number, chunkSize = DEFAULT_CHUNK_SIZE): number {
  if (plaintextSize <= 0) return 0
  return Math.ceil(plaintextSize / chunkSize)
}

export function chunkPlainLength(
  header: Pick<MdatHeader, 'chunkSize' | 'plaintextSize' | 'totalChunks'>,
  index: number
): number {
  if (index < 0 || index >= header.totalChunks) return 0
  if (index === header.totalChunks - 1) {
    return header.plaintextSize - header.chunkSize * (header.totalChunks - 1)
  }
  return header.chunkSize
}

/** 分块 i 的密文在文件中的偏移 */
export function chunkCipherOffset(chunkSize: number, index: number): number {
  return MDAT_HEADER_SIZE + index * (chunkSize + MDAT_TAG_SIZE)
}

/** 整个文件应有的字节数 */
export function expectedFileSize(plaintextSize: number, chunkSize = DEFAULT_CHUNK_SIZE): number {
  const chunks = totalChunksFor(plaintextSize, chunkSize)
  return MDAT_HEADER_SIZE + plaintextSize + chunks * MDAT_TAG_SIZE
}

export interface BuildHeaderOptions {
  fileId: Buffer
  plaintextSize: number
  chunkSize?: number
  noncePrefix?: Buffer
}

export function buildHeader(options: BuildHeaderOptions): { header: Buffer; fileKeyHeader: MdatHeader } {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  if (chunkSize <= 0 || chunkSize > MAX_HEADER_CHUNK_SIZE) {
    throw new AppError('INVALID_INPUT', '分块大小不合法')
  }
  if (options.plaintextSize <= 0) throw new AppError('INVALID_INPUT', '空文件不能作为附件')
  if (options.fileId.length !== 16) throw new AppError('INVALID_INPUT', '附件 ID 长度错误')

  const totalChunks = totalChunksFor(options.plaintextSize, chunkSize)
  if (totalChunks > 0xffffffff) throw new AppError('INVALID_INPUT', '文件过大')

  const prefix = Buffer.alloc(MDAT_TAG_OFFSET)
  prefix.write(MDAT_MAGIC, 0, 'ascii')
  prefix.writeUInt8(MDAT_VERSION, 4)
  prefix.writeUInt8(0, 5) // flags
  prefix.writeUInt16BE(MDAT_HEADER_SIZE, 6)
  options.fileId.copy(prefix, 8)
  prefix.writeUInt32BE(chunkSize, 24)
  prefix.writeUInt32BE(totalChunks, 28)
  prefix.writeBigUInt64BE(BigInt(options.plaintextSize), 32)
  const noncePrefix = options.noncePrefix ?? randomBytes(8)
  if (noncePrefix.length !== 8) throw new AppError('INVALID_INPUT', 'nonce 前缀长度错误')
  noncePrefix.copy(prefix, 40)

  const header = Buffer.concat([prefix, Buffer.alloc(MDAT_TAG_SIZE)])
  return {
    header,
    fileKeyHeader: {
      version: MDAT_VERSION,
      flags: 0,
      headerSize: MDAT_HEADER_SIZE,
      fileId: Buffer.from(options.fileId),
      chunkSize,
      totalChunks,
      plaintextSize: options.plaintextSize,
      noncePrefix: Buffer.from(noncePrefix),
      prefix
    }
  }
}

export function writeHeaderTag(header: Buffer, fileKey: Buffer): void {
  const tag = createHmac('sha256', fileKey).update(header.subarray(0, MDAT_TAG_OFFSET)).digest().subarray(0, MDAT_TAG_SIZE)
  tag.copy(header, MDAT_TAG_OFFSET)
}

export function parseHeader(buffer: Buffer): MdatHeader {
  if (buffer.length < MDAT_HEADER_SIZE) throw new AppError('CORRUPT_VAULT', '附件头不完整')
  if (buffer.subarray(0, 4).toString('ascii') !== MDAT_MAGIC) {
    throw new AppError('CORRUPT_VAULT', '附件格式不匹配')
  }
  const version = buffer.readUInt8(4)
  if (version !== MDAT_VERSION) throw new AppError('CORRUPT_VAULT', '附件版本不支持')
  const headerSize = buffer.readUInt16BE(6)
  if (headerSize !== MDAT_HEADER_SIZE) throw new AppError('CORRUPT_VAULT', '附件头长度不合法')
  const chunkSize = buffer.readUInt32BE(24)
  const totalChunks = buffer.readUInt32BE(28)
  const plaintextSizeBig = buffer.readBigUInt64BE(32)
  if (plaintextSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('CORRUPT_VAULT', '附件过大')
  }
  const plaintextSize = Number(plaintextSizeBig)
  if (chunkSize <= 0 || chunkSize > MAX_HEADER_CHUNK_SIZE) {
    throw new AppError('CORRUPT_VAULT', '分块大小不合法')
  }
  if (totalChunks !== totalChunksFor(plaintextSize, chunkSize)) {
    throw new AppError('CORRUPT_VAULT', '分块数量不匹配')
  }
  const prefix = Buffer.from(buffer.subarray(0, MDAT_TAG_OFFSET))
  return {
    version,
    flags: buffer.readUInt8(5),
    headerSize,
    fileId: Buffer.from(buffer.subarray(8, 24)),
    chunkSize,
    totalChunks,
    plaintextSize,
    noncePrefix: Buffer.from(buffer.subarray(40, 48)),
    prefix
  }
}

export function verifyHeaderTag(headerBuffer: Buffer, fileKey: Buffer): boolean {
  const expected = createHmac('sha256', fileKey).update(headerBuffer.subarray(0, MDAT_TAG_OFFSET)).digest().subarray(0, MDAT_TAG_SIZE)
  const actual = headerBuffer.subarray(MDAT_TAG_OFFSET, MDAT_HEADER_SIZE)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function buildNonce(noncePrefix: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(12)
  noncePrefix.copy(nonce, 0)
  nonce.writeUInt32BE(index >>> 0, 8)
  return nonce
}

function buildAad(prefix: Buffer, index: number, chunkLength: number): Buffer {
  const aad = Buffer.alloc(prefix.length + 8)
  prefix.copy(aad, 0)
  aad.writeUInt32BE(index >>> 0, prefix.length)
  aad.writeUInt32BE(chunkLength, prefix.length + 4)
  return aad
}

export function encryptChunk(
  fileKey: Buffer,
  header: Pick<MdatHeader, 'noncePrefix' | 'prefix' | 'chunkSize' | 'totalChunks' | 'plaintextSize'>,
  index: number,
  plaintext: Buffer
): Buffer {
  const expected = chunkPlainLength(header, index)
  if (plaintext.length !== expected) {
    throw new AppError('INVALID_INPUT', '分块长度与头部元数据不一致')
  }
  const nonce = buildNonce(header.noncePrefix, index)
  const aad = buildAad(header.prefix, index, plaintext.length)
  const cipher = createCipheriv('aes-256-gcm', fileKey, nonce, { authTagLength: MDAT_TAG_SIZE })
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

export function decryptChunk(
  fileKey: Buffer,
  header: Pick<MdatHeader, 'noncePrefix' | 'prefix' | 'chunkSize' | 'totalChunks' | 'plaintextSize'>,
  index: number,
  ciphertext: Buffer
): Buffer {
  const expectedLength = chunkPlainLength(header, index) + MDAT_TAG_SIZE
  if (ciphertext.length !== expectedLength) {
    throw new AppError('CORRUPT_VAULT', '附件分块长度不匹配')
  }
  const nonce = buildNonce(header.noncePrefix, index)
  const aad = buildAad(header.prefix, index, expectedLength - MDAT_TAG_SIZE)
  const tag = ciphertext.subarray(ciphertext.length - MDAT_TAG_SIZE)
  try {
    const decipher = createDecipheriv('aes-256-gcm', fileKey, nonce, { authTagLength: MDAT_TAG_SIZE })
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - MDAT_TAG_SIZE)), decipher.final()])
  } catch {
    throw new AppError('CORRUPT_VAULT', '附件校验失败或已被篡改')
  }
}

export interface ChunkPlan {
  index: number
  /** 分块内需要读取的明文起止（相对该块起点） */
  from: number
  to: number
}

/** 给定明文区间 [start, end)，算出需要解密哪些块、每块取哪一段 */
export function planRangeChunks(
  header: Pick<MdatHeader, 'chunkSize' | 'plaintextSize' | 'totalChunks'>,
  start: number,
  end: number
): ChunkPlan[] {
  if (start < 0 || end > header.plaintextSize || start >= end) {
    throw new AppError('INVALID_INPUT', 'Range 越界')
  }
  const firstIndex = Math.floor(start / header.chunkSize)
  const lastIndex = Math.floor((end - 1) / header.chunkSize)
  const plans: ChunkPlan[] = []
  for (let index = firstIndex; index <= lastIndex; index++) {
    const chunkStart = index * header.chunkSize
    const from = Math.max(0, start - chunkStart)
    const to = Math.min(chunkPlainLength(header, index), end - chunkStart)
    plans.push({ index, from, to })
  }
  return plans
}

// ───────────────────────── 文件类型识别 ─────────────────────────
// 自己写嗅探而不是引入 file-type：主进程是 CJS，file-type 只提供 ESM，
// 为一个 20 行的判断引入 ESM/CJS 互操作风险不值得。

interface Signature {
  kind: AttachmentKind
  mime: string
  test: (head: Buffer) => boolean
}

const startsWithAscii = (head: Buffer, ascii: string, offset = 0): boolean =>
  head.length >= offset + ascii.length &&
  head.subarray(offset, offset + ascii.length).toString('ascii') === ascii

const SIGNATURES: Signature[] = [
  {
    kind: 'image',
    mime: 'image/png',
    test: (head) => head.length > 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  },
  { kind: 'image', mime: 'image/jpeg', test: (head) => head.length > 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { kind: 'image', mime: 'image/gif', test: (head) => startsWithAscii(head, 'GIF87a') || startsWithAscii(head, 'GIF89a') },
  { kind: 'image', mime: 'image/webp', test: (head) => startsWithAscii(head, 'RIFF') && startsWithAscii(head, 'WEBP', 8) },
  { kind: 'image', mime: 'image/avif', test: (head) => startsWithAscii(head, 'ftypavif', 4) },
  { kind: 'image', mime: 'image/bmp', test: (head) => startsWithAscii(head, 'BM') },
  { kind: 'image', mime: 'image/svg+xml', test: (head) => /^\s*<svg[\s>]/i.test(head.subarray(0, 256).toString('utf8')) },
  { kind: 'audio', mime: 'audio/mpeg', test: (head) => startsWithAscii(head, 'ID3') || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) },
  { kind: 'audio', mime: 'audio/wav', test: (head) => startsWithAscii(head, 'RIFF') && startsWithAscii(head, 'WAVE', 8) },
  { kind: 'audio', mime: 'audio/ogg', test: (head) => startsWithAscii(head, 'OggS') },
  { kind: 'audio', mime: 'audio/flac', test: (head) => startsWithAscii(head, 'fLaC') },
  { kind: 'video', mime: 'video/mp4', test: (head) => startsWithAscii(head, 'ftyp', 4) },
  { kind: 'video', mime: 'video/webm', test: (head) => head.length > 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 }
]

const EXTENSION_KIND: Record<string, { kind: AttachmentKind; mime: string }> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  avif: { kind: 'image', mime: 'image/avif' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  heic: { kind: 'image', mime: 'image/heic' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' }
}

export interface DetectedType {
  kind: AttachmentKind
  mime: string
}

/** 先看魔数，再退回扩展名，最后按普通文件处理 */
export function detectType(fileName: string, head: Buffer, fallbackMime?: string): DetectedType {
  for (const signature of SIGNATURES) {
    try {
      if (signature.test(head)) return { kind: signature.kind, mime: signature.mime }
    } catch {
      // 头部太短时忽略该签名
    }
  }
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  const byExtension = EXTENSION_KIND[extension]
  if (byExtension) return byExtension
  return { kind: 'file', mime: fallbackMime && fallbackMime.length > 0 ? fallbackMime : 'application/octet-stream' }
}

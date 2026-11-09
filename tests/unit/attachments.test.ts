import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { scanOrphans } from '../../src/main/attachments/orphans'
import { AttachmentStore, SIZE_LIMITS } from '../../src/main/attachments/store'
import { VaultRepository } from '../../src/main/vault/repository'
import {
  DEFAULT_CHUNK_SIZE,
  MDAT_HEADER_SIZE,
  MDAT_TAG_SIZE,
  buildHeader,
  chunkCipherOffset,
  chunkPlainLength,
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
  writeHeaderTag
} from '../../src/main/attachments/format'
import { parseRangeHeader, contentRangeHeader, unsatisfiedRangeHeader } from '../../src/main/attachments/range'
import { randomUuid } from '../../src/main/vault/crypto'

const attachmentKey = Buffer.alloc(32, 5)
const CHUNK = 4 // 测试用极小分块，边界更容易覆盖

function fileId(): Buffer {
  return uuidHexToBytes(randomUuid())
}

describe('MDAT 分块 AEAD', () => {
  it('头长度为 64 字节，分块数向上取整', () => {
    const plaintextSize = CHUNK * 2 + 1
    const { header, fileKeyHeader } = buildHeader({ fileId: fileId(), plaintextSize, chunkSize: CHUNK })
    expect(header.length).toBe(MDAT_HEADER_SIZE)
    expect(fileKeyHeader.totalChunks).toBe(3)
    expect(chunkPlainLength(fileKeyHeader, 0)).toBe(CHUNK)
    expect(chunkPlainLength(fileKeyHeader, 2)).toBe(1)
    expect(expectedFileSize(plaintextSize, CHUNK)).toBe(
      MDAT_HEADER_SIZE + plaintextSize + 3 * MDAT_TAG_SIZE
    )
  })

  it('逐块加解密 roundtrip，末块可以更短', () => {
    const plaintext = Buffer.from('0123456789', 'utf8') // 10 字节 → 3 块 (4,4,2)
    const file = fileId()
    const { header, fileKeyHeader } = buildHeader({
      fileId: file,
      plaintextSize: plaintext.length,
      chunkSize: CHUNK
    })
    const fileKey = deriveFileKey(attachmentKey, file)
    writeHeaderTag(header, fileKey)

    const chunks: Buffer[] = []
    for (let index = 0; index < fileKeyHeader.totalChunks; index++) {
      const start = index * CHUNK
      const slice = plaintext.subarray(start, start + chunkPlainLength(fileKeyHeader, index))
      chunks.push(encryptChunk(fileKey, fileKeyHeader, index, slice))
    }

    const decrypted = Buffer.concat(
      chunks.map((cipher, index) => decryptChunk(fileKey, fileKeyHeader, index, cipher))
    )
    expect(decrypted.toString()).toBe('0123456789')
    expect(verifyHeaderTag(header, fileKey)).toBe(true)
  })

  it('分块内容被篡改时解密失败', () => {
    const plaintext = Buffer.alloc(CHUNK, 9)
    const file = fileId()
    const { header, fileKeyHeader } = buildHeader({
      fileId: file,
      plaintextSize: plaintext.length,
      chunkSize: CHUNK
    })
    const fileKey = deriveFileKey(attachmentKey, file)
    writeHeaderTag(header, fileKey)
    const cipher = encryptChunk(fileKey, fileKeyHeader, 0, plaintext)
    cipher[0] = (cipher[0] ?? 0) ^ 0xff
    expect(() => decryptChunk(fileKey, fileKeyHeader, 0, cipher)).toThrowError(/校验失败|篡改/)
  })

  it('分块重排与截断都会失败', () => {
    const plaintext = Buffer.concat([Buffer.alloc(CHUNK, 1), Buffer.alloc(CHUNK, 2)])
    const file = fileId()
    const { header, fileKeyHeader } = buildHeader({
      fileId: file,
      plaintextSize: plaintext.length,
      chunkSize: CHUNK
    })
    const fileKey = deriveFileKey(attachmentKey, file)
    writeHeaderTag(header, fileKey)
    const first = encryptChunk(fileKey, fileKeyHeader, 0, plaintext.subarray(0, CHUNK))
    const second = encryptChunk(fileKey, fileKeyHeader, 1, plaintext.subarray(CHUNK))
    // 交换顺序 → 第 0 块用第 1 块的密文解，AAD/序号不匹配
    expect(() => decryptChunk(fileKey, fileKeyHeader, 0, second)).toThrow()
    // 截断
    expect(() => decryptChunk(fileKey, fileKeyHeader, 0, first.subarray(0, 4))).toThrow()
  })

  it('头部被篡改时 HMAC 校验失败', () => {
    const file = fileId()
    const { header } = buildHeader({ fileId: file, plaintextSize: CHUNK, chunkSize: CHUNK })
    const fileKey = deriveFileKey(attachmentKey, file)
    writeHeaderTag(header, fileKey)
    const tampered = Buffer.from(header)
    tampered[40] = (tampered[40] ?? 0) ^ 0xff // 改 noncePrefix，头部仍然结构合法
    expect(verifyHeaderTag(tampered, fileKey)).toBe(false)
    expect(parseHeader(tampered).chunkSize).toBe(CHUNK)
  })

  it('Range 计算只挑相关分块', () => {
    const file = fileId()
    const { fileKeyHeader } = buildHeader({
      fileId: file,
      plaintextSize: CHUNK * 4,
      chunkSize: CHUNK
    })
    expect(planRangeChunks(fileKeyHeader, 0, CHUNK)).toEqual([{ index: 0, from: 0, to: CHUNK }])
    expect(planRangeChunks(fileKeyHeader, CHUNK, CHUNK * 2)).toEqual([
      { index: 1, from: 0, to: CHUNK }
    ])
    expect(planRangeChunks(fileKeyHeader, 2, CHUNK + 1)).toEqual([
      { index: 0, from: 2, to: CHUNK },
      { index: 1, from: 0, to: 1 }
    ])
    expect(() => planRangeChunks(fileKeyHeader, CHUNK * 4, CHUNK * 4 + 1)).toThrow()
  })

  it('偏移计算公式与文件布局一致', () => {
    expect(chunkCipherOffset(1024, 0)).toBe(MDAT_HEADER_SIZE)
    expect(chunkCipherOffset(1024, 3)).toBe(MDAT_HEADER_SIZE + 3 * (1024 + MDAT_TAG_SIZE))
  })

  it('拒绝空文件与非法分块大小', () => {
    expect(() => buildHeader({ fileId: fileId(), plaintextSize: 0 })).toThrow()
    expect(() => buildHeader({ fileId: fileId(), plaintextSize: 1, chunkSize: 0 })).toThrow()
    expect(totalChunksFor(0)).toBe(0)
    expect(totalChunksFor(DEFAULT_CHUNK_SIZE + 1)).toBe(2)
  })

  it('按魔数识别类型，未知类型退回扩展名', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
    expect(detectType('photo.jpg', png)).toEqual({ kind: 'image', mime: 'image/png' })
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')])
    expect(detectType('clip.bin', mp4).kind).toBe('video')
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(8)])
    expect(detectType('voice', mp3).kind).toBe('audio')
    expect(detectType('notes.wav', Buffer.from('RIFFxxxxWAVE'))).toEqual({
      kind: 'audio',
      mime: 'audio/wav'
    })
    expect(detectType('a.pdf', Buffer.from('hello')).kind).toBe('file')
    expect(detectType('a.tiff', Buffer.from('hello')).mime).toBe('application/octet-stream')
  })
})

describe('HTTP Range 解析', () => {
  it('支持闭区间、开区间与后缀区间', () => {
    expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRangeHeader('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRangeHeader('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRangeHeader('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRangeHeader('bytes=500-500', 1000)).toEqual({ start: 500, end: 500 })
  })

  it('非法 Range 返回 null（调用方回 416）', () => {
    expect(parseRangeHeader(null, 1000)).toBeNull()
    expect(parseRangeHeader('', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=1000-', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=10-5', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=-0', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=0-1,3-4', 1000)).toBeNull()
    expect(parseRangeHeader('items=0-1', 1000)).toBeNull()
  })

  it('生成 Content-Range 头', () => {
    expect(contentRangeHeader({ start: 10, end: 19 }, 100)).toBe('bytes 10-19/100')
    expect(unsatisfiedRangeHeader(100)).toBe('bytes */100')
  })
})

describe('AttachmentStore 流式读写', () => {
  let dir = ''

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'minidiary-mdat-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('写入后能按 Range 读出正确明文，且磁盘上没有明文', async () => {
    const store = new AttachmentStore(dir, () => attachmentKey)
    const payload = Buffer.from('雨停之后，窗外的树被打得发亮。'.repeat(64), 'utf8')
    const attachment = await store.addFromBytes({
      name: '窗外梧桐.txt',
      mime: 'text/plain',
      bytes: new Uint8Array(payload)
    })

    expect(attachment.kind).toBe('file')
    expect(attachment.size).toBe(payload.length)
    expect(attachment.totalChunks).toBe(Math.ceil(payload.length / DEFAULT_CHUNK_SIZE))

    const onDisk = await readFile(path.join(dir, 'attachments', `${attachment.id}.mdat`))
    expect(onDisk.subarray(0, 4).toString()).toBe('MDAT')
    expect(onDisk.includes(Buffer.from('雨停之后'))).toBe(false)

    const meta = {
      size: attachment.size,
      chunkSize: attachment.chunkSize,
      totalChunks: attachment.totalChunks
    }
    const full = Buffer.concat([...[]])
    void full
    const chunks: Buffer[] = []
    for await (const chunk of store.readRange(attachment.id, meta, 0, attachment.size)) {
      chunks.push(chunk)
    }
    expect(Buffer.concat(chunks).equals(payload)).toBe(true)

    const middle: Buffer[] = []
    for await (const chunk of store.readRange(attachment.id, meta, 10, 30)) {
      middle.push(chunk)
    }
    expect(Buffer.concat(middle).equals(payload.subarray(10, 30))).toBe(true)

    expect(await store.verify(attachment)).toBe(true)
    const stats = await stat(path.join(dir, 'attachments', `${attachment.id}.mdat`))
    expect(stats.size).toBe(expectedFileSize(attachment.size, attachment.chunkSize))
    expect(SIZE_LIMITS.image).toBe(50 * 1024 * 1024)
  })

  it('文件被截断后读取报错', async () => {
    const store = new AttachmentStore(dir, () => attachmentKey)
    const attachment = await store.addFromBytes({
      name: 'a.bin',
      mime: 'application/octet-stream',
      bytes: new Uint8Array(Buffer.alloc(2048, 1))
    })
    const filePath = path.join(dir, 'attachments', `${attachment.id}.mdat`)
    const original = await readFile(filePath)
    await rm(filePath)
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, original.subarray(0, 100))
    await expect(async () => {
      for await (const chunk of store.readRange(
        attachment.id,
        {
          size: attachment.size,
          chunkSize: attachment.chunkSize,
          totalChunks: attachment.totalChunks
        },
        0,
        attachment.size
      )) {
        void chunk
      }
    }).rejects.toThrow()
  })
})

describe('未引用附件扫描', () => {
  it('只返回没有被任何 entry 引用的附件，并从头部嗅探 kind', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'minidiary-orphans-'))
    try {
      const repo = new VaultRepository({ dir, scrypt: { N: 1024, r: 8, p: 1 } })
      await repo.create('orphan-password-1234')
      const store = new AttachmentStore(dir, () => repo.getAttachmentKey())
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4EWADRAwQCgAnbgVRZO/EWgAAAABJRU5ErkJggg==',
        'base64'
      )

      const referenced = await store.addFromBytes({
        name: '书桌.png',
        mime: 'image/png',
        bytes: new Uint8Array(png)
      })
      await repo.saveEntry({
        date: '2026-11-05',
        title: '被引用',
        body: `![书桌](attachment://${referenced.id})`,
        tags: [],
        attachments: [referenced]
      })
      const orphan = await store.addFromBytes({
        name: '旧照片.png',
        mime: 'image/png',
        bytes: new Uint8Array(png)
      })

      const result = await scanOrphans(repo, store)
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.id).toBe(orphan.id)
      expect(result.items[0]?.kind).toBe('image')
      expect(result.items[0]?.size).toBe(png.length)
      expect(result.bytes).toBe(png.length)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

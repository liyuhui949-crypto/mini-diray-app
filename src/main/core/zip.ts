import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import yauzl from 'yauzl'
import yazl from 'yazl'

import { AppError } from '@shared/errors'

/**
 * ZIP64 流式读写：
 * - 写：yazl，附件用 store（不压缩），边写边算 SHA-256；
 * - 读：yauzl，逐条校验，防 Zip Slip / Zip Bomb / 重复条目 / 符号链接。
 * 任何时刻都不把整个 ZIP 读进内存。
 */

export const MAX_ZIP_ENTRIES = 200_000
export const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024 * 1024
export const MAX_SINGLE_ENTRY = 8 * 1024 * 1024 * 1024
export const MAX_COMPRESSION_RATIO = 1000

export interface HashCountingTransform {
  stream: Transform
  digest: () => string
  bytes: () => number
}

/** 一个既能统计字节、又能顺带算 SHA-256 的透传流 */
export function createHashCounter(): HashCountingTransform {
  const hash = createHash('sha256')
  let count = 0
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      count += chunk.length
      callback(null, chunk)
    }
  })
  return {
    stream,
    digest: () => hash.digest('hex'),
    bytes: () => count
  }
}

export function createByteCounter(onBytes: (delta: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length)
      callback(null, chunk)
    }
  })
}

export interface ZipWriteOptions {
  /** 目标 .part 路径 */
  filePath: string
}

export class ZipWriter {
  private readonly zip = new yazl.ZipFile()
  private readonly output: ReturnType<typeof createWriteStream>
  private readonly completion: Promise<void>
  private closed = false

  constructor(options: ZipWriteOptions) {
    this.output = createWriteStream(options.filePath, { mode: 0o600 })
    this.completion = new Promise<void>((resolve, reject) => {
      this.output.on('close', () => resolve())
      this.output.on('error', reject)
      this.zip.outputStream.on('error', reject)
    })
    this.zip.outputStream.pipe(this.output)
  }

  addBuffer(memberPath: string, data: Buffer | string, compress = true): void {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    this.zip.addBuffer(buffer, memberPath, { compress })
  }

  /** 已存在于磁盘的密文附件：流式读入，store 模式（不压缩、不重加密） */
  addFileFromDisk(realPath: string, memberPath: string): HashCountingTransform {
    const counter = createHashCounter()
    const source = createReadStream(realPath)
    source.on('error', () => counter.stream.destroy(new Error(`无法读取 ${memberPath}`)))
    source.pipe(counter.stream)
    this.zip.addReadStream(counter.stream, memberPath, { compress: false })
    return counter
  }

  /** 任意可读流或异步迭代器（迁移导入导出、PDF 等） */
  addStream(
    source: NodeJS.ReadableStream | AsyncIterable<Buffer> | Iterable<Buffer>,
    memberPath: string,
    compress = false
  ): void {
    const stream =
      typeof (source as NodeJS.ReadableStream).pipe === 'function'
        ? (source as NodeJS.ReadableStream)
        : Readable.from(source as AsyncIterable<Buffer>)
    this.zip.addReadStream(stream, memberPath, { compress })
  }

  /** 关闭 ZIP 并等待落盘，返回文件大小 */
  async finalize(): Promise<{ size: number }> {
    if (this.closed) throw new AppError('INVALID_INPUT', 'ZIP 已关闭')
    this.closed = true
    this.zip.end()
    await this.completion
    const stats = await fs.stat(this.output.path as string).catch(() => null)
    return { size: stats?.size ?? 0 }
  }

  /** 中止：立刻销毁输出流，调用方负责删除 .part */
  abort(): void {
    this.closed = true
    this.output.destroy()
  }
}

export interface ZipEntryInfo {
  name: string
  size: number
  compressedSize: number
  isDirectory: boolean
}

interface OpenZipOptions {
  /** 成员名校验：返回 false 立即拒绝整个包 */
  allowMember?: (name: string) => boolean
  maxEntries?: number
  maxTotalUncompressed?: number
}

export class ZipArchive {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    readonly entries: Map<string, yauzl.Entry>
  ) {}

  static async open(filePath: string, options: OpenZipOptions = {}): Promise<ZipArchive> {
    const allowMember = options.allowMember ?? (() => true)
    const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES
    const maxTotal = options.maxTotalUncompressed ?? MAX_TOTAL_UNCOMPRESSED

    const file = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.open(
        filePath,
        { lazyEntries: true, validateEntrySizes: true, autoClose: false, decodeStrings: true },
        (error, zip) => {
          if (error || !zip) reject(new AppError('CORRUPT_VAULT', '无法读取迁移包（ZIP 结构损坏）'))
          else resolve(zip)
        }
      )
    })

    const entries = new Map<string, yauzl.Entry>()
    let total = 0
    let count = 0

    await new Promise<void>((resolve, reject) => {
      file.on('entry', (entry: yauzl.Entry) => {
        try {
          count += 1
          if (count > maxEntries) throw new AppError('INVALID_INPUT', '迁移包条目过多')
          const name = entry.fileName
          assertSafeMemberName(name)
          if (!allowMember(name.replace(/\/$/, ''))) {
            throw new AppError('INVALID_INPUT', `迁移包包含不允许的文件：${name}`)
          }
          if (name.endsWith('/')) {
            file.readEntry()
            return
          }
          if (entries.has(name)) throw new AppError('INVALID_INPUT', '迁移包含重复条目')
          if (entry.uncompressedSize > MAX_SINGLE_ENTRY) {
            throw new AppError('INVALID_INPUT', '迁移包内单个文件过大')
          }
          if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO) {
            throw new AppError('INVALID_INPUT', '迁移包压缩比异常（疑似 Zip Bomb）')
          }
          total += entry.uncompressedSize
          if (total > maxTotal) throw new AppError('INVALID_INPUT', '迁移包解压后过大')
          // yauzl 已拒绝符号链接以外的 Unix 模式；这里再确认一次
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000
          if (mode === 0o120000) throw new AppError('INVALID_INPUT', '迁移包包含符号链接')
          entries.set(name, entry)
          file.readEntry()
        } catch (error) {
          reject(error)
        }
      })
      file.on('end', () => resolve())
      file.on('error', () => reject(new AppError('CORRUPT_VAULT', '迁移包读取失败')))
      file.readEntry()
    }).catch((error: unknown) => {
      file.close()
      throw error
    })

    return new ZipArchive(file, entries)
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  info(name: string): ZipEntryInfo | null {
    const entry = this.entries.get(name)
    if (!entry) return null
    return {
      name: entry.fileName,
      size: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
      isDirectory: entry.fileName.endsWith('/')
    }
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  async openStream(name: string): Promise<NodeJS.ReadableStream> {
    const entry = this.entries.get(name)
    if (!entry) throw new AppError('NOT_FOUND', '迁移包缺少文件')
    return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      this.zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) reject(new AppError('CORRUPT_VAULT', '无法读取迁移包内容'))
        else resolve(stream)
      })
    })
  }

  async readBuffer(name: string, limit = 64 * 1024 * 1024): Promise<Buffer> {
    const stream = await this.openStream(name)
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length
      if (total > limit) throw new AppError('INVALID_INPUT', '迁移包内文件过大')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  close(): void {
    try {
      this.zip.close()
    } catch {
      // 已经关闭
    }
  }
}

export function assertSafeMemberName(name: string): void {
  if (name.length === 0 || name.length > 512) throw new AppError('INVALID_INPUT', '迁移包条目名不合法')
  if (name.includes('\0')) throw new AppError('INVALID_INPUT', '迁移包条目名包含非法字符')
  if (name.includes('\\')) throw new AppError('INVALID_INPUT', '迁移包条目名包含反斜杠')
  if (name.startsWith('/')) throw new AppError('INVALID_INPUT', '迁移包包含绝对路径')
  if (/^[a-zA-Z]:/.test(name)) throw new AppError('INVALID_INPUT', '迁移包包含盘符路径')
  const segments = name.replace(/\/$/, '').split('/')
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      throw new AppError('INVALID_INPUT', '迁移包包含路径穿越')
    }
    if (segment.length === 0) throw new AppError('INVALID_INPUT', '迁移包包含空路径段')
  }
}

/** 计算文件的 SHA-256（流式，用于校验迁移包成员） */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback()
    }
  }))
  return hash.digest('hex')
}

/** 校验磁盘上目录是否存在可写（迁移前检查） */
export async function ensureWritableDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const probe = path.join(dir, `.probe-${process.pid}`)
  await fs.writeFile(probe, 'ok', { mode: 0o600 })
  await fs.rm(probe, { force: true })
}

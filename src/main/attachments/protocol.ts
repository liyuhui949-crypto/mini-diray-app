import { Readable } from 'node:stream'

import { protocol } from 'electron'

import { logger } from '../logger'
import type { VaultRepository } from '../vault/repository'
import { detectPlainType } from './orphans'
import { contentRangeHeader, parseRangeHeader, unsatisfiedRangeHeader } from './range'
import type { AttachmentStore } from './store'

interface StreamMeta {
  size: number
  totalChunks: number
  chunkSize: number
  mime: string
}

export const ATTACHMENT_SCHEME = 'attachment'

/** 必须在 app ready 之前调用 */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ATTACHMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: false
      }
    }
  ])
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `attachment://<uuid>` 只做解密代理，不做静态目录映射：
 * - 未解锁 423
 * - 未知/不属于当前库 404
 * - 单区间 Range → 206；非法 Range → 416
 * - 永远 `Cache-Control: no-store`，不给 Chromium 落盘缓存的机会
 */
export class AttachmentProtocol {
  private readonly controllers = new Set<AbortController>()
  /** 未引用附件没有 entry 元数据，按需从 .mdat 头与明文头部推断并缓存 */
  private readonly orphanCache = new Map<string, StreamMeta>()

  constructor(
    private readonly repository: VaultRepository,
    private readonly store: AttachmentStore
  ) {}

  register(): void {
    protocol.handle(ATTACHMENT_SCHEME, (request) => this.handle(request))
  }

  /** 供 PDF 打印窗口的独立 session 复用同一个解密代理 */
  handleRequest(request: Request): Promise<Response> {
    return this.handle(request)
  }

  /** 锁定/退出：中止所有正在进行的解密流 */
  abortAll(): void {
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.orphanCache.clear()
  }

  private async resolveOrphan(id: string): Promise<StreamMeta | null> {
    const cached = this.orphanCache.get(id)
    if (cached) return cached
    try {
      const meta = await this.store.describe(id)
      const { mime } = await detectPlainType(this.store, id, meta)
      const value: StreamMeta = { ...meta, mime }
      this.orphanCache.set(id, value)
      return value
    } catch {
      this.orphanCache.delete(id)
      return null
    }
  }

  private async handle(request: Request): Promise<Response> {
    if (!this.repository.isUnlocked) {
      return new Response(null, { status: 423, statusText: 'Locked' })
    }

    let id = ''
    try {
      const url = new URL(request.url)
      id = url.hostname || url.pathname.replace(/^\/+/, '')
    } catch {
      return new Response(null, { status: 400 })
    }
    if (!ID_RE.test(id)) return new Response(null, { status: 404 })

    let mime: string
    let meta: Omit<StreamMeta, 'mime'>
    const found = this.repository.findAttachment(id)
    if (found) {
      const attachment = found.attachment
      mime = attachment.mime
      meta = {
        size: attachment.size,
        totalChunks: attachment.totalChunks,
        chunkSize: attachment.chunkSize
      }
    } else {
      // 也允许预览未被任何日记引用的附件（附件库的「未引用」列表）
      const orphan = await this.resolveOrphan(id)
      if (!orphan) return new Response(null, { status: 404 })
      mime = orphan.mime
      meta = { size: orphan.size, totalChunks: orphan.totalChunks, chunkSize: orphan.chunkSize }
    }

    const baseHeaders: Record<string, string> = {
      'Content-Type': mime,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'Content-Disposition': 'inline',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff'
    }
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(meta.size) }
      })
    }

    const rangeHeader = request.headers.get('Range')
    const range = rangeHeader ? parseRangeHeader(rangeHeader, meta.size) : null

    if (rangeHeader && !range) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': unsatisfiedRangeHeader(meta.size) }
      })
    }

    const start = range ? range.start : 0
    const end = range ? range.end + 1 : meta.size
    const controller = new AbortController()
    this.controllers.add(controller)

    try {
      const stream = this.store.readRange(id, meta, start, end, controller.signal)
      const nodeStream = Readable.from(stream)
      const release = (): void => {
        this.controllers.delete(controller)
      }
      nodeStream.once('close', release)
      nodeStream.once('end', release)
      nodeStream.once('error', release)
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>

      const headers: Record<string, string> = {
        ...baseHeaders,
        'Content-Length': String(end - start)
      }
      if (range) headers['Content-Range'] = contentRangeHeader(range, meta.size)

      return new Response(webStream, { status: range ? 206 : 200, headers })
    } catch (error) {
      this.controllers.delete(controller)
      logger.error('attachment stream failed', error)
      return new Response(null, { status: 500 })
    }
  }
}

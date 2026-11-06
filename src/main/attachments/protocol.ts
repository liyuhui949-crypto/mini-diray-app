import { Readable } from 'node:stream'

import { protocol } from 'electron'

import type { Attachment } from '@shared/types'

import { logger } from '../logger'
import type { VaultRepository } from '../vault/repository'
import { contentRangeHeader, parseRangeHeader, unsatisfiedRangeHeader } from './range'
import type { AttachmentStore } from './store'

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

    const found = this.repository.findAttachment(id)
    if (!found) return new Response(null, { status: 404 })
    const attachment: Attachment = found.attachment

    const baseHeaders: Record<string, string> = {
      'Content-Type': attachment.mime,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'Content-Disposition': 'inline',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff'
    }
    const meta = {
      size: attachment.size,
      totalChunks: attachment.totalChunks,
      chunkSize: attachment.chunkSize
    }

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(attachment.size) }
      })
    }

    const rangeHeader = request.headers.get('Range')
    const range = rangeHeader ? parseRangeHeader(rangeHeader, attachment.size) : null

    if (rangeHeader && !range) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': unsatisfiedRangeHeader(attachment.size) }
      })
    }

    const start = range ? range.start : 0
    const end = range ? range.end + 1 : attachment.size
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
      if (range) headers['Content-Range'] = contentRangeHeader(range, attachment.size)

      return new Response(webStream, { status: range ? 206 : 200, headers })
    } catch (error) {
      this.controllers.delete(controller)
      logger.error('attachment stream failed', error)
      return new Response(null, { status: 500 })
    }
  }
}

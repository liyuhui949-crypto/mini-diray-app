import fs from 'node:fs/promises'
import path from 'node:path'

import { AppError } from '@shared/errors'
import type { ExportFormat } from '@shared/types'
import { formatDateWithWeekdayCN } from '@shared/date'
import { escapeHtml } from '@shared/markdown'

import { logger } from '../logger'
import type { AttachmentStore } from '../attachments/store'
import type { JobHandle } from '../jobs'
import type { VaultRepository } from '../vault/repository'
import { buildDayOneTxt } from './dayOneTxt'
import { buildMarkdownDocument, markdownFileName, safeAttachmentFileName } from './markdown'
import { buildMiniDiaryJson } from './miniDiaryJson'
import { buildPrintDocument, exportPdf } from './pdf'

export interface ExportDeps {
  repository: VaultRepository
  store: AttachmentStore
  appVersion: string
  attachmentHandler: (request: Request) => Promise<Response>
}

export interface ExportOptions {
  format: ExportFormat
  /** 文件路径或目录路径（Markdown 用目录） */
  targetPath: string
  includeAttachments?: boolean
  /** PDF 用：渲染进程已经生成好的正文 HTML（已 sanitize） */
  html?: string
  job: JobHandle
}

export async function runExport(deps: ExportDeps, options: ExportOptions): Promise<{ path: string }> {
  const { repository, store } = deps
  await repository.flush()
  if (!repository.isUnlocked) throw new AppError('VAULT_LOCKED')

  const entries = repository.getSnapshot().entries
  const { job } = options

  switch (options.format) {
    case 'miniDiaryJson': {
      const json = buildMiniDiaryJson(entries, { version: deps.appVersion })
      await fs.mkdir(path.dirname(options.targetPath), { recursive: true })
      await fs.writeFile(options.targetPath, json, { mode: 0o600 })
      job.report(1, '导出完成')
      logger.info('exported mini diary json', { entries: entries.length })
      return { path: options.targetPath }
    }

    case 'dayOneTxt': {
      const text = buildDayOneTxt(entries)
      await fs.mkdir(path.dirname(options.targetPath), { recursive: true })
      await fs.writeFile(options.targetPath, text, { mode: 0o600 })
      job.report(1, '导出完成')
      return { path: options.targetPath }
    }

    case 'markdown': {
      const directory = options.targetPath
      await fs.mkdir(directory, { recursive: true })
      const attachmentsDir = path.join(directory, 'attachments')
      let copied = 0
      const totalBytes = entries.reduce(
        (sum, entry) => sum + entry.attachments.reduce((inner, item) => inner + item.size, 0),
        0
      )
      let doneBytes = 0

      for (const entry of entries) {
        const linkMap = new Map<string, string>()
        if (options.includeAttachments) {
          await fs.mkdir(attachmentsDir, { recursive: true })
          for (const attachment of entry.attachments) {
            if (job.signal.aborted) throw new AppError('CANCELLED')
            const fileName = safeAttachmentFileName(attachment.id, attachment.name)
            const target = path.join(attachmentsDir, fileName)
            await store.exportTo(attachment, target)
            linkMap.set(attachment.id.toLowerCase(), `attachments/${encodeURI(fileName)}`)
            copied += 1
            doneBytes += attachment.size
            job.report(
              totalBytes === 0 ? 0.5 : doneBytes / Math.max(1, totalBytes),
              `复制附件 ${copied}`,
              { bytesDone: doneBytes, bytesTotal: totalBytes }
            )
          }
        }
        const markdown = buildMarkdownDocument(entry, { attachmentLinks: linkMap })
        await fs.writeFile(path.join(directory, markdownFileName(entry.date)), markdown, {
          mode: 0o600
        })
      }
      job.report(1, '导出完成')
      logger.info('exported markdown', { entries: entries.length, attachments: copied })
      return { path: directory }
    }

    case 'pdf': {
      const html = options.html ?? buildFallbackPdfHtml(entries)
      const document = buildPrintDocument({
        title: 'Mini Diary',
        subtitle: entries.length > 0
          ? `${formatDateWithWeekdayCN(entries[0]!.date)} 至 ${formatDateWithWeekdayCN(entries[entries.length - 1]!.date)} · 共 ${entries.length} 篇`
          : '还没有日记',
        bodyHtml: html
      })
      await fs.mkdir(path.dirname(options.targetPath), { recursive: true })
      job.report(0.3, '生成 PDF…')
      await exportPdf({
        html: document,
        targetPath: options.targetPath,
        attachmentHandler: deps.attachmentHandler,
        title: 'Mini Diary'
      })
      job.report(1, '导出完成')
      return { path: options.targetPath }
    }

    default:
      throw new AppError('UNSUPPORTED', '不支持的导出格式')
  }
}

/** 渲染进程没给 HTML 时的兜底（纯文本段落），保证 PDF 不会失败 */
function buildFallbackPdfHtml(entries: readonly { date: string; title: string; body: string }[]): string {
  return entries
    .map((entry) => {
      const title = escapeHtml(entry.title || formatDateWithWeekdayCN(entry.date))
      const body = entry.body
        .split('\n')
        .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : ''))
        .join('')
      return `<article class="entry"><h2>${title}</h2><p class="entry-meta">${escapeHtml(formatDateWithWeekdayCN(entry.date))}</p><div class="entry-body">${body}</div></article>`
    })
    .join('\n')
}

import fs from 'node:fs/promises'

import { AppError } from '@shared/errors'
import type { ImportFormat, ImportSummary, LocalDate } from '@shared/types'
import type { ImportWarning } from '@shared/types'

import { logger } from '../logger'
import { randomUuid } from '../vault/crypto'
import { createRollbackPoint, deleteRollbackPoint, restoreRollbackPoint } from '../vault/rollback'
import type { VaultRepository } from '../vault/repository'
import { parseDayOneJson } from './dayOneJson'
import { parseDayOneTxt } from './dayOneTxt'
import { parseJrnlJson } from './jrnlJson'
import { parseMiniDiaryJson } from './miniDiaryJson'
import type { ParseOutcome, ParsedEntry } from './helpers'

const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024

interface TokenRecord {
  filePath: string
  format: ImportFormat
  outcome: ParseOutcome
  summary: ImportSummary
}

function parseContent(format: ImportFormat, content: string): ParseOutcome {
  switch (format) {
    case 'dayOneJson':
      return parseDayOneJson(content)
    case 'jrnlJson':
      return parseJrnlJson(content)
    case 'miniDiaryJson':
      return parseMiniDiaryJson(content)
    case 'dayOneTxt':
      return parseDayOneTxt(content)
    default:
      throw new AppError('UNSUPPORTED', '不支持的导入格式')
  }
}

/**
 * 外部格式导入：只导入文本（附件不参与），
 * 预览时解析出条目并给出摘要；提交时才写库，写前保留临时回滚点。
 */
export class ExternalImporter {
  private readonly tokens = new Map<string, TokenRecord>()

  constructor(private readonly repository: VaultRepository) {}

  async preview(format: ImportFormat, filePath: string): Promise<{ token: string; summary: ImportSummary }> {
    const stats = await fs.stat(filePath).catch(() => {
      throw new AppError('NOT_FOUND', '导入文件不存在')
    })
    if (stats.size > MAX_IMPORT_FILE_BYTES) throw new AppError('INVALID_INPUT', '导入文件过大')
    const content = await fs.readFile(filePath, 'utf8')
    const outcome = parseContent(format, content)
    if (outcome.entries.length === 0) throw new AppError('INVALID_INPUT', '没有识别到任何条目')

    const existing = new Set(
      this.repository.isUnlocked
        ? this.repository.getSnapshot().entries.map((entry) => entry.date)
        : []
    )
    const mergedCount = outcome.entries.filter((entry) => existing.has(entry.date)).length
    const dates = outcome.entries.map((entry) => entry.date).sort()
    const summary: ImportSummary = {
      format,
      entryCount: outcome.entries.length,
      mergedCount,
      newCount: outcome.entries.length - mergedCount,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      warnings: outcome.warnings
    }

    const token = randomUuid()
    this.tokens.set(token, { filePath, format, outcome, summary })
    return { token, summary }
  }

  cancel(token: string): void {
    this.tokens.delete(token)
  }

  async commit(token: string): Promise<{ revision: number; summary: ImportSummary }> {
    const record = this.tokens.get(token)
    if (!record) throw new AppError('NOT_FOUND', '导入会话已过期，请重新选择文件')
    this.tokens.delete(token)
    if (!this.repository.isUnlocked) throw new AppError('VAULT_LOCKED')

    const jobId = `import-${Date.now()}`
    await createRollbackPoint(this.repository.vaultDir, jobId, { attachments: false })
    try {
      const drafts = record.outcome.entries.map((entry: ParsedEntry) => ({
        date: entry.date,
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        attachments: []
      }))
      const result = await this.repository.upsertEntries(drafts)
      await deleteRollbackPoint(this.repository.vaultDir, jobId)
      const summary: ImportSummary = {
        ...record.summary,
        entryCount: drafts.length
      }
      logger.info('external import committed', {
        format: record.format,
        added: result.added,
        merged: result.merged
      })
      return { revision: result.revision, summary }
    } catch (error) {
      await restoreRollbackPoint(this.repository.vaultDir, jobId).catch(() => undefined)
      await deleteRollbackPoint(this.repository.vaultDir, jobId).catch(() => undefined)
      throw error
    }
  }

  /** 测试与调试用：直接拿到解析结果 */
  static parseForTest(format: ImportFormat, content: string): ParseOutcome {
    return parseContent(format, content)
  }
}

export type { ParseOutcome, ParsedEntry, ImportWarning, LocalDate }

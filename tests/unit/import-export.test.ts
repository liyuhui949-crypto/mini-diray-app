import { describe, expect, it } from 'vitest'

import { parseDayOneJson } from '../../src/main/import/dayOneJson'
import { parseJrnlJson } from '../../src/main/import/jrnlJson'
import { parseMiniDiaryJson } from '../../src/main/import/miniDiaryJson'
import { parseDayOneTxt } from '../../src/main/import/dayOneTxt'
import { extractLocalDate, splitTitleAndBody } from '../../src/main/import/helpers'
import { buildDayOneTxt } from '../../src/main/export/dayOneTxt'
import { buildMiniDiaryJson } from '../../src/main/export/miniDiaryJson'
import {
  buildMarkdownDocument,
  markdownFileName,
  rewriteAttachmentLinks,
  safeAttachmentFileName
} from '../../src/main/export/markdown'
import type { Attachment, DiaryEntry } from '@shared/types'

const attachment: Attachment = {
  id: '6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e',
  name: '窗外的梧桐.png',
  mime: 'image/png',
  kind: 'image',
  size: 2048,
  sha256: 'a'.repeat(64),
  chunkSize: 1024 * 1024,
  totalChunks: 1,
  createdAt: '2026-11-06T00:00:00.000Z'
}

const entry: DiaryEntry = {
  date: '2026-11-06',
  title: '雨停之后',
  body: `下午四点雨停了。\n\n![梧桐](attachment://${attachment.id})`,
  tags: ['日常', '思考'],
  attachments: [attachment],
  wordCount: 20,
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T12:00:00.000Z'
}

describe('导入解析器', () => {
  it('Day One JSON：日期、标题、正文、标签映射正确，附件给警告', () => {
    const outcome = parseDayOneJson(
      JSON.stringify({
        entries: [
          {
            creationDate: '2026-11-06T16:42:00Z',
            text: '# 雨停之后\n\n下午四点雨停了。',
            tags: ['日常'],
            photos: [{ identifier: 'x' }]
          },
          { creationDate: 'not-a-date', text: '无日期' }
        ]
      })
    )
    expect(outcome.entries).toHaveLength(1)
    expect(outcome.entries[0]).toMatchObject({
      date: '2026-11-06',
      title: '雨停之后',
      body: '下午四点雨停了。',
      tags: ['日常']
    })
    expect(outcome.warnings.some((warning) => warning.message.includes('照片'))).toBe(true)
    expect(outcome.warnings.some((warning) => warning.message.includes('日期'))).toBe(true)
  })

  it('Day One JSON 结构不合法时报错', () => {
    expect(() => parseDayOneJson('not json')).toThrow()
    expect(() => parseDayOneJson('{"foo":1}')).toThrow()
  })

  it('jrnl JSON：保留标题与标签', () => {
    const outcome = parseJrnlJson(
      JSON.stringify([
        { date: '2026-11-06 20:15', title: '周一的清单', body: '- 回邮件', tags: ['工作'] }
      ])
    )
    expect(outcome.entries[0]).toMatchObject({
      date: '2026-11-06',
      title: '周一的清单',
      body: '- 回邮件',
      tags: ['工作']
    })
  })

  it('Mini Diary JSON：旧版本正文补成 Markdown 段落', () => {
    const outcome = parseMiniDiaryJson(
      JSON.stringify({
        metadata: { version: '1.9.0' },
        entries: {
          '2026-11-06': { title: '旧', text: '第一行\n第二行' },
          '2026-11-05': { title: '新', text: 'a\nb' }
        }
      })
    )
    const oldEntry = outcome.entries.find((item) => item.date === '2026-11-06')
    expect(oldEntry?.body).toBe('第一行\n\n第二行')

    const migrated = parseMiniDiaryJson(
      JSON.stringify({
        metadata: { version: '2.1.0' },
        entries: { '2026-11-06': { title: '新', text: 'a\nb' } }
      })
    )
    expect(migrated.entries[0]?.body).toBe('a\nb')
  })

  it('Day One TXT：字段解析、正文保留、无日期段给警告', () => {
    const text = [
      '\tDate:\t2026-11-06 20:15:00',
      '\tTitle:\t雨停之后',
      '\tTime:\t20:15:00',
      '\tTags:\t#日常',
      '',
      '下午四点雨停了。',
      '',
      '另一段。',
      '',
      '\tDate:\t2026-11-05 21:00:00',
      '',
      '只有正文的一篇'
    ].join('\n')
    const outcome = parseDayOneTxt(text)
    expect(outcome.entries).toHaveLength(2)
    const first = outcome.entries.find((item) => item.date === '2026-11-06')
    const second = outcome.entries.find((item) => item.date === '2026-11-05')
    expect(first).toMatchObject({ date: '2026-11-06', title: '雨停之后' })
    expect(first?.body).toContain('下午四点雨停了。')
    expect(first?.body).not.toContain('Time:')
    expect(second?.title).toBe('只有正文的一篇')
  })

  it('日期与标题拆分工具覆盖常见写法', () => {
    expect(extractLocalDate('2026-11-06T16:42:00Z')).toBe('2026-11-06')
    expect(extractLocalDate('2026/11/06')).toBe('2026-11-06')
    expect(extractLocalDate('2026-13-40')).toBeNull()
    expect(extractLocalDate(null)).toBeNull()
    expect(splitTitleAndBody('## 标题\n\n正文')).toEqual({ title: '标题', body: '正文' })
    expect(splitTitleAndBody('')).toEqual({ title: '', body: '' })
  })
})

describe('导出格式', () => {
  it('Mini Diary JSON 兼容旧结构并带附件元数据', () => {
    const json = JSON.parse(buildMiniDiaryJson([entry], { version: '4.0.0' })) as {
      metadata: { application: string; version: string }
      entries: Record<string, { title: string; text: string; attachments?: unknown[] }>
    }
    expect(json.metadata.application).toBe('Mini Diary')
    expect(json.metadata.version).toBe('4.0.0')
    expect(json.entries['2026-11-06']?.title).toBe('雨停之后')
    expect(json.entries['2026-11-06']?.attachments).toHaveLength(1)
  })

  it('Day One TXT 可以被自己的解析器读回', () => {
    const text = buildDayOneTxt([entry])
    expect(text).toContain('\tDate:\t2026-11-06')
    expect(text).toContain('\tTitle:\t雨停之后')
    expect(text).toContain('\tTags:\t#日常, #思考')
    expect(text).toContain('[附件] 窗外的梧桐.png（image）')

    const parsed = parseDayOneTxt(text)
    expect(parsed.entries[0]?.date).toBe('2026-11-06')
    expect(parsed.entries[0]?.title).toBe('雨停之后')
    expect(parsed.entries[0]?.body).toContain('下午四点雨停了。')
  })

  it('Markdown 导出把 attachment:// 改写成相对路径', () => {
    const map = new Map([[attachment.id, 'attachments/窗外的梧桐-6d5f1c1e.png']])
    const body = rewriteAttachmentLinks(entry.body, map)
    expect(body).toContain('attachments/窗外的梧桐-6d5f1c1e.png')
    expect(body).not.toContain('attachment://')

    const markdown = buildMarkdownDocument(entry, { attachmentLinks: map })
    expect(markdown).toContain('# 雨停之后')
    expect(markdown).toContain('#日常 #思考')
    expect(markdown).toContain('attachments/窗外的梧桐-6d5f1c1e.png')
    expect(markdown).toContain('附件：窗外的梧桐.png')
    expect(markdownFileName('2026-11-06')).toBe('2026-11-06.md')
  })

  it('附件导出文件名安全且带短 ID', () => {
    const name = safeAttachmentFileName(attachment.id, 'a/b:c*.png')
    expect(name).toMatch(/^a_b_c_-[0-9a-f]{8}\.png$/)
    expect(safeAttachmentFileName(attachment.id, '')).toBe(`attachment-${attachment.id.slice(0, 8)}`)
  })
})

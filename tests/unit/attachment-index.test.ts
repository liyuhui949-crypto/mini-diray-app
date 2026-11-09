import { describe, expect, it } from 'vitest'

import {
  buildAttachmentIndex,
  countAttachmentKinds,
  totalAttachmentBytes
} from '@shared/attachmentIndex'
import type { Attachment, DiaryEntry } from '@shared/types'

function attachment(id: string, kind: Attachment['kind'], size = 1024): Attachment {
  return {
    id,
    name: `${id}.bin`,
    mime: 'application/octet-stream',
    kind,
    size,
    sha256: '0'.repeat(64),
    chunkSize: 1024 * 1024,
    totalChunks: 1,
    createdAt: '2026-11-01T00:00:00.000Z'
  }
}

function entry(date: string, title: string, attachments: Attachment[]): DiaryEntry {
  return {
    date,
    title,
    body: '',
    tags: [],
    attachments,
    wordCount: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z'
  }
}

describe('附件库聚合索引', () => {
  it('空库返回空数组', () => {
    expect(buildAttachmentIndex([])).toEqual([])
    expect(countAttachmentKinds([])).toEqual({ all: 0, image: 0, video: 0, audio: 0, file: 0 })
    expect(totalAttachmentBytes([])).toBe(0)
  })

  it('按日记日期倒序，同一天保留附件顺序', () => {
    const items = buildAttachmentIndex([
      entry('2026-11-04', '较早', [attachment('a', 'image'), attachment('b', 'file')]),
      entry('2026-11-06', '较晚', [attachment('c', 'video')]),
      entry('2026-11-04', '同一天', [attachment('d', 'audio')])
    ])
    expect(items.map((item) => item.attachment.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(items[0]?.entryTitle).toBe('较晚')
  })

  it('计数与体积按 kind 汇总', () => {
    const items = buildAttachmentIndex([
      entry('2026-11-06', '', [
        attachment('i1', 'image', 100),
        attachment('i2', 'image', 200),
        attachment('v1', 'video', 1000),
        attachment('f1', 'file', 30)
      ])
    ])
    expect(countAttachmentKinds(items)).toEqual({
      all: 4,
      image: 2,
      video: 1,
      audio: 0,
      file: 1
    })
    expect(totalAttachmentBytes(items)).toBe(1330)
  })
})

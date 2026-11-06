import { describe, expect, it } from 'vitest'

import { countEntryWords, countWords, deriveTitle, makeSnippet, plainText } from '@shared/words'
import { collectTags, filterByTag, highlightSegments, searchEntries } from '@shared/search'
import { calcStats, hasContent, heatmapColumns, weeklyBuckets } from '@shared/stats'
import {
  collectBrokenAttachmentRefs,
  composeMergedBody,
  composeMergedTitle,
  mergeEntryLists,
  mergeTags,
  rewriteAttachmentIds
} from '@shared/merge'
import { escapeHtml, renderMarkdownToHtml } from '@shared/markdown'
import { isValidLocalDate, normalizeTags, passwordSchema, preferencesSchema } from '@shared/schemas'
import {
  PACKAGE_KEY_ALPHABET,
  PACKAGE_KEY_LENGTH,
  composePackageSecret,
  formatPackageKey,
  generatePackageKey,
  isValidPackageKey,
  normalizePackageKey
} from '@shared/packageKey'
import type { Attachment, DiaryEntry } from '@shared/types'

function entry(partial: Partial<DiaryEntry> & { date: string }): DiaryEntry {
  return {
    title: '',
    body: '',
    tags: [],
    attachments: [],
    wordCount: 0,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    ...partial
  }
}

const imageAttachment: Attachment = {
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

describe('字数统计', () => {
  it('中文按字、英文按词，混合内容口径固定', () => {
    expect(countWords('下午四点雨停了')).toBe(7)
    expect(countWords('hello world 世界')).toBe(4)
    expect(countWords('')).toBe(0)
    expect(countWords('a')).toBe(1)
  })

  it('Markdown 标记与附件链接不计入字数', () => {
    expect(countWords('**粗体** 与 *斜体*')).toBe(5)
    expect(countWords('# 标题')).toBe(2)
    expect(countWords('- 一\n- 二')).toBe(2)
    expect(countWords('![图](attachment://6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e)')).toBe(0)
    expect(countWords('[看这里](https://example.com)')).toBe(3)
  })

  it('标题计入每个条目的字数', () => {
    expect(countEntryWords('雨停之后', '下午四点雨停了')).toBe(11)
    expect(countEntryWords('', '正文')).toBe(2)
  })

  it('纯文本化会去掉结构标记', () => {
    expect(plainText('## 标题\n\n> 引用')).toBe('标题\n\n引用')
    expect(deriveTitle('', '# 第一行\n第二行')).toBe('第一行')
    expect(deriveTitle('显式标题', '正文')).toBe('显式标题')
    expect(makeSnippet('第一行\n第二行', '标题')).toBe('第一行 第二行')
  })
})

describe('搜索', () => {
  const entries = [
    entry({ date: '2026-11-06', title: '雨停之后', body: '下午四点雨停了，专注。', tags: ['日常'] }),
    entry({ date: '2026-11-05', title: '关于专注', body: '深度工作需要专注。', tags: ['思考'] }),
    entry({ date: '2026-11-04', title: '降温', body: '出门忘了带外套。', tags: ['日常'] })
  ]

  it('标题、正文、标签都能命中，大小写不敏感', () => {
    expect(searchEntries(entries, '雨停').map((hit) => hit.entry.date)).toEqual(['2026-11-06'])
    expect(searchEntries(entries, '外套')[0]?.entry.date).toBe('2026-11-04')
    expect(searchEntries(entries, '思考')[0]?.entry.date).toBe('2026-11-05')
    expect(searchEntries(entries, 'HELLO')).toHaveLength(0)
  })

  it('多个词是“与”关系，标题命中排序更靠前', () => {
    const hits = searchEntries(entries, '专注 深度')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.entry.date).toBe('2026-11-05')
    const byTitle = searchEntries(entries, '专注')
    expect(byTitle[0]?.entry.date).toBe('2026-11-05')
  })

  it('空查询返回空数组，隐藏标题时用正文首行', () => {
    expect(searchEntries(entries, '   ')).toHaveLength(0)
    const hit = searchEntries([entry({ date: '2026-11-06', body: '第一行正文' })], '第一行', {
      hideTitle: true
    })[0]
    expect(hit?.title).toBe('第一行正文')
  })

  it('高亮片段把命中处切开', () => {
    expect(highlightSegments('雨停之后雨停了', '雨')).toEqual([
      { text: '雨', match: true },
      { text: '停之后', match: false },
      { text: '雨', match: true },
      { text: '停了', match: false }
    ])
    expect(highlightSegments('abc', '')).toEqual([{ text: 'abc', match: false }])
    expect(highlightSegments('abc', 'z')).toEqual([{ text: 'abc', match: false }])
  })

  it('标签筛选与统计', () => {
    expect(filterByTag(entries, '日常').map((item) => item.date).sort()).toEqual([
      '2026-11-04',
      '2026-11-06'
    ])
    expect(filterByTag(entries, null)).toHaveLength(3)
    expect(collectTags(entries)).toEqual([
      { tag: '日常', count: 2 },
      { tag: '思考', count: 1 }
    ])
  })
})

describe('统计', () => {
  const today = '2026-11-06'
  const entries = [
    entry({ date: '2026-11-01', title: 'a', body: '一', wordCount: 10 }),
    entry({ date: '2026-11-02', title: 'b', body: '二', wordCount: 10 }),
    entry({ date: '2026-11-03', title: 'c', body: '三', wordCount: 10 }),
    entry({ date: '2026-11-04', title: 'd', body: '四', wordCount: 10 }),
    entry({ date: '2026-11-05', title: 'e', body: '五', wordCount: 10 }),
    entry({ date: '2026-11-06', title: 'f', body: '六', wordCount: 10 })
  ]

  it('六项指标口径与手算一致', () => {
    const stats = calcStats(entries, { today })
    expect(stats.totalEntries).toBe(6)
    expect(stats.longestStreak).toBe(6)
    expect(stats.currentStreak).toBe(6)
    expect(stats.totalWords).toBe(60)
    expect(stats.avgWords).toBe(10)
    // 2026-10-26 起算到本周共 2 周
    expect(stats.perWeek).toBe(3)
    expect(stats.firstDate).toBe('2026-11-01')
    expect(stats.lastDate).toBe('2026-11-06')
  })

  it('断档与当前连续以今天/昨天为锚', () => {
    const broken = [
      entry({ date: '2026-11-01', title: 'a' }),
      entry({ date: '2026-11-02', title: 'b' }),
      entry({ date: '2026-11-05', title: 'c' })
    ]
    const stats = calcStats(broken, { today })
    expect(stats.longestStreak).toBe(2)
    // 今天没写，但昨天写了 → 当前连续 = 1
    expect(stats.currentStreak).toBe(1)
  })

  it('空库与未来条目不参与连续统计', () => {
    expect(calcStats([], { today })).toMatchObject({
      totalEntries: 0,
      longestStreak: 0,
      currentStreak: 0,
      totalWords: 0,
      avgWords: 0,
      perWeek: 0
    })
    const future = [
      entry({ date: '2026-11-07', title: 'f' }),
      entry({ date: '2026-11-06', title: 't' })
    ]
    const stats = calcStats(future, { today })
    expect(stats.currentStreak).toBe(1)
  })

  it('只有空内容的条目不计数', () => {
    expect(hasContent(entry({ date: '2026-11-06' }))).toBe(false)
    expect(hasContent(entry({ date: '2026-11-06', tags: ['x'] }))).toBe(true)
    expect(calcStats([entry({ date: '2026-11-06' })], { today }).totalEntries).toBe(
      0
    )
  })

  it('近 12 周分桶与热力图列数正确', () => {
    const weeks = weeklyBuckets(entries, 12, { today })
    expect(weeks).toHaveLength(12)
    // 本周（11-02 起）有 11-02 到 11-06 共 5 篇；11-01 属于上一周
    expect(weeks[11]?.count).toBe(5)
    expect(weeks[10]?.count).toBe(1)
    expect(weeks[0]?.count).toBe(0)

    const heat = heatmapColumns(entries, 13, { today })
    expect(heat).toHaveLength(13)
    expect(heat[0]?.cells).toHaveLength(7)
    const last = heat[12]?.cells ?? []
    expect(last.some((cell) => cell.level > 0)).toBe(true)
  })
})

describe('合并规则', () => {
  it('标题用 | 连接，正文用 --- 分隔，标签并集', () => {
    expect(composeMergedTitle('旧', '新')).toBe('旧 | 新')
    expect(composeMergedTitle('同一标题', '同一标题')).toBe('同一标题')
    expect(composeMergedTitle('', '新')).toBe('新')
    expect(composeMergedBody('旧', '新')).toBe('旧\n\n---\n\n新')
    expect(composeMergedBody('', '新')).toBe('新')
    expect(mergeTags(['A', 'b'], ['b', ' c '])).toEqual(['a', 'b', 'c'])
  })

  it('同日合并保留双方内容与附件，绝不覆盖', () => {
    const existing = entry({
      date: '2026-11-06',
      title: '我的',
      body: '我的正文',
      tags: ['本地'],
      attachments: [imageAttachment]
    })
    const incoming = entry({
      date: '2026-11-06',
      title: '导入',
      body: '导入正文',
      tags: ['导入'],
      attachments: [{ ...imageAttachment, id: '00000000-0000-4000-8000-000000000001' }]
    })
    const { entries, stats } = mergeEntryLists([existing], [incoming])
    expect(stats).toEqual({ added: 0, merged: 1 })
    expect(entries[0]?.title).toBe('我的 | 导入')
    expect(entries[0]?.body).toContain('我的正文')
    expect(entries[0]?.body).toContain('导入正文')
    expect(entries[0]?.attachments).toHaveLength(2)
    expect(entries[0]?.tags.sort()).toEqual(['locally'.slice(0, 0) + '导入', '本地'].sort())
  })

  it('附件 ID 重写与断链检测', () => {
    const idMap = new Map([[imageAttachment.id, '00000000-0000-4000-8000-000000000002']])
    const body = `看图 ![x](attachment://${imageAttachment.id})`
    expect(rewriteAttachmentIds(body, idMap)).toBe(
      '看图 ![x](attachment://00000000-0000-4000-8000-000000000002)'
    )
    const broken = collectBrokenAttachmentRefs([
      entry({ date: '2026-11-06', body: '![x](attachment://00000000-0000-4000-8000-000000000003)' })
    ])
    expect(broken).toHaveLength(1)
  })
})

describe('打印用 Markdown 渲染', () => {
  it('渲染标题、列表、引用与强调', () => {
    const html = renderMarkdownToHtml('# 标题\n\n- 一\n- 二\n\n> 引用 **重点**')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>一</li>')
    expect(html).toContain('<blockquote>引用 <strong>重点</strong></blockquote>')
  })

  it('附件图片渲染为 figure，音频渲染为卡片，未知协议不生成链接', () => {
    const audio: Attachment = {
      ...imageAttachment,
      id: '00000000-0000-4000-8000-000000000004',
      name: '录音.m4a',
      kind: 'audio',
      mime: 'audio/mp4'
    }
    const html = renderMarkdownToHtml(
      `![梧桐](attachment://${imageAttachment.id})\n\n[录音](attachment://${audio.id})\n\n[外链](https://example.com)\n\n[坏链](javascript:alert(1))`,
      { attachments: [imageAttachment, audio] }
    )
    expect(html).toContain(`<img src="attachment://${imageAttachment.id}"`)
    expect(html).toContain('media-card')
    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain('javascript:alert')
  })

  it('转义 HTML，代码块保持原文', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
    const html = renderMarkdownToHtml('```\n<b>code</b>\n```')
    expect(html).toContain('&lt;b&gt;code&lt;/b&gt;')
    expect(renderMarkdownToHtml('<img src=x onerror=alert(1)>')).not.toContain('<img')
  })
})

describe('Schema 与标签规范化', () => {
  it('标签去 #、去空白、小写、去重、限制长度', () => {
    expect(normalizeTags([' #日常 ', '日常', '#思考', '', '   ', 'x'.repeat(40)])).toEqual([
      '日常',
      '思考'
    ])
  })

  it('密码至少 8 位', () => {
    expect(passwordSchema.safeParse('1234567').success).toBe(false)
    expect(passwordSchema.safeParse('12345678').success).toBe(true)
  })

  it('偏好 schema 接受默认值并拒绝非法枚举', () => {
    const prefs = {
      version: 1,
      theme: 'system',
      hideTitle: false,
      allowFutureEntries: false,
      autoLockMinutes: 0,
      diaryDir: '/tmp/diary',
      lastOpenedDate: null,
      lastImportDir: null,
      lastExportDir: null
    }
    expect(preferencesSchema.safeParse(prefs).success).toBe(true)
    expect(preferencesSchema.safeParse({ ...prefs, theme: 'neon' }).success).toBe(false)
    expect(preferencesSchema.safeParse({ ...prefs, autoLockMinutes: 7 }).success).toBe(false)
  })

  it('日期校验拒绝 2 月 30 日', () => {
    expect(isValidLocalDate('2026-02-30')).toBe(false)
    expect(isValidLocalDate('2026-02-28')).toBe(true)
  })
})


describe('迁移包公钥', () => {
  it('生成的公钥为 128 位，且只含约定字母表字符', () => {
    const key = generatePackageKey()
    expect(key).toHaveLength(PACKAGE_KEY_LENGTH)
    expect(PACKAGE_KEY_LENGTH).toBe(128)
    for (const char of key) expect(PACKAGE_KEY_ALPHABET).toContain(char)
    expect(isValidPackageKey(key)).toBe(true)
    expect(generatePackageKey()).not.toBe(key)
    // 同时包含大小写与数字，说明字母表是混合的
    expect(key).toMatch(/[A-Z]/)
    expect(key).toMatch(/[a-z]/)
    expect(key).toMatch(/[0-9]/)
  })

  it('展示按 4 位分组；导入时忽略短横线但保留大小写', () => {
    const key = PACKAGE_KEY_ALPHABET.repeat(3).slice(0, 128)
    const formatted = formatPackageKey(key)
    expect(formatted).toHaveLength(128 + 31)
    expect(formatted.split('-')).toHaveLength(32)
    expect(normalizePackageKey(formatted)).toBe(key)
    expect(formatPackageKey(formatted)).toBe(formatted)
    // 大小写敏感：换成大写后不再是同一个公钥
    expect(normalizePackageKey(formatted).toUpperCase()).not.toBe(key)
  })

  it('拒绝长度不对或含歧义字符的公钥', () => {
    expect(isValidPackageKey('')).toBe(false)
    expect(isValidPackageKey('ABCD-EFGH')).toBe(false)
    const valid = 'A'.repeat(128)
    expect(isValidPackageKey(valid)).toBe(true)
    // 0 / O / I / l 不在字母表里
    expect(isValidPackageKey(`${'A'.repeat(127)}0`)).toBe(false)
    expect(isValidPackageKey(`${'A'.repeat(127)}O`)).toBe(false)
    expect(isValidPackageKey(`${'A'.repeat(127)}I`)).toBe(false)
    expect(isValidPackageKey(`${'A'.repeat(127)}l`)).toBe(false)
  })

  it('公钥与私钥组合后才是真正参与派生的口令，大小写不同即不同', () => {
    const key = `${PACKAGE_KEY_ALPHABET}`.repeat(3).slice(0, 128)
    const first = composePackageSecret(key, 'password-1')
    const sameNormalized = composePackageSecret(formatPackageKey(key), 'password-1')
    const otherCase = composePackageSecret(key.toUpperCase(), 'password-1')
    const otherPassword = composePackageSecret(key, 'password-2')
    expect(first).toBe(sameNormalized)
    expect(first).not.toBe(otherCase)
    expect(first).not.toBe(otherPassword)
  })
})

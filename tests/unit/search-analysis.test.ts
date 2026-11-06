import { describe, expect, it } from 'vitest'

import { analyzeSearch, highlightSegments, normalizeText } from '@shared/search'
import type { DiaryEntry } from '@shared/types'

function entry(date: string, title: string, body: string, tags: string[] = []): DiaryEntry {
  return {
    date,
    title,
    body,
    tags,
    attachments: [],
    wordCount: 0,
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`
  }
}

/** 2025 年 3 篇 + 2026 年 9 篇 = 12 篇，与 PRD 的「感冒」夹具一致 */
const fixtures: DiaryEntry[] = [
  entry('2025-11-02', '', '换季就感冒了，头也疼。', ['身体']),
  entry('2025-12-20', '第二天', '感冒好一点，但还是咳嗽。'),
  entry('2025-12-31', '', '跨年前又感冒，真难受。'),
  entry('2026-01-01', '', '新年第一天，感冒还在。'),
  entry('2026-02-14', '情人节', '感冒了，在家躺着。感冒药吃了两片。'),
  entry('2026-02-15', '', '还是感冒，没出门。'),
  entry('2026-03-02', '', '感冒終於好了。'),
  entry('2026-06-10', '', '吹空调又感冒。'),
  entry('2026-09-09', '', '换季感冒，注意保暖。'),
  entry('2026-10-15', '', '办公室有人感冒。'),
  entry('2026-11-04', '', '感冒了，头也疼。'),
  entry('2026-11-05', '', '感冒第三天，快好了。'),
  entry('2026-11-06', '别的日子', '今天只写了天气，没别的。')
]

describe('analyzeSearch', () => {
  it('空查询返回 null', () => {
    expect(analyzeSearch(fixtures, '   ')).toBeNull()
  })

  it('概览：命中篇数与最早/最近命中日', () => {
    const analysis = analyzeSearch(fixtures, '感冒')
    expect(analysis).not.toBeNull()
    expect(analysis!.hits).toHaveLength(12)
    expect(analysis!.firstHit).toBe('2025-11-02')
    expect(analysis!.lastHit).toBe('2026-11-05')
    expect(analysis!.byYear.map((group) => [group.year, group.hits.length])).toEqual([
      ['2026', 9],
      ['2025', 3]
    ])
  })

  it('只命中标题也算一篇，但没有正文片段', () => {
    const analysis = analyzeSearch([entry('2026-05-01', '感冒记事', '今天很平静。')], '感冒')
    expect(analysis!.hits).toHaveLength(1)
    expect(analysis!.hits[0]!.titleHits).toBe(1)
    expect(analysis!.hits[0]!.snippets).toHaveLength(0)
  })

  it('全角与大小写：NFKC 归一化后命中同一批', () => {
    const list = [entry('2026-05-01', '', 'RAIN and rain and ｒａｉｎ')]
    const plain = analyzeSearch(list, 'rain')!
    const fullWidth = analyzeSearch(list, 'ｒａｉｎ')!
    const upper = analyzeSearch(list, 'RAIN')!
    expect(plain.hits).toHaveLength(1)
    expect(fullWidth.hits).toHaveLength(1)
    expect(upper.hits).toHaveLength(1)
    expect(normalizeText('ＲＡＩＮ')).toBe('rain')
  })

  it('non-overlapping 计数：aaa 里搜 aa 只算 1 处', () => {
    const analysis = analyzeSearch([entry('2026-05-01', '', 'aaa')], 'aa')
    expect(analysis!.hits[0]!.bodyHits).toBe(1)
  })

  it('连续段：跨年按完整日历拼接，断一天就断段', () => {
    const analysis = analyzeSearch(fixtures, '感冒')!
    expect(analysis.streakOf['2025-12-31']).toEqual({ idx: 1, len: 2 })
    expect(analysis.streakOf['2026-01-01']).toEqual({ idx: 2, len: 2 })
    expect(analysis.streakOf['2026-02-14']).toEqual({ idx: 1, len: 2 })
    expect(analysis.streakOf['2026-02-15']).toEqual({ idx: 2, len: 2 })
    // 11/04、11/05 连续；11/06 没有命中，所以段在那里结束
    expect(analysis.streakOf['2026-11-04']).toEqual({ idx: 1, len: 2 })
    expect(analysis.streakOf['2026-11-05']).toEqual({ idx: 2, len: 2 })
    expect(analysis.streakOf['2026-11-06']).toBeUndefined()
  })

  it('片段：命中 ≥3 次给首尾两条并高亮', () => {
    const body = `开头提到感冒。${'中间写了很多别的事情。'.repeat(6)}中午又感冒了。${'继续写别的。'.repeat(6)}结尾又感冒了。`
    const analysis = analyzeSearch([entry('2026-05-01', '', body)], '感冒')!
    const snippets = analysis.hits[0]!.snippets
    expect(snippets).toHaveLength(2)
    expect(snippets[0]!.text).toContain('开头')
    expect(snippets[1]!.text).toContain('结尾')
    for (const snippet of snippets) {
      expect(snippet.segments.some((segment) => segment.match)).toBe(true)
    }
  })

  it('时间线：逐月出柱，空月保留占位并标注季度月份', () => {
    const analysis = analyzeSearch(fixtures, '感冒')!
    expect(analysis.timeline.unit).toBe('month')
    const buckets = analysis.timeline.buckets
    expect(buckets[0]!.key).toBe('2025-11')
    expect(buckets[buckets.length - 1]!.key).toBe('2026-11')
    expect(buckets).toHaveLength(13)
    const empty = buckets.find((bucket) => bucket.key === '2026-04')!
    expect(empty.n).toBe(0)
    // 1 月给年份标签，其它季度首月给月份标签
    expect(buckets.find((bucket) => bucket.key === '2026-01')!.label).toBe('26年')
    expect(buckets.find((bucket) => bucket.key === '2026-02')!.label).toBe('')
    expect(buckets.find((bucket) => bucket.key === '2026-04')!.label).toBe('4月')
    // 轴上的标签是 yyyy-mm
    expect(buckets[0]!.dateLabel).toBe('2025-11')
    expect(buckets.find((bucket) => bucket.key === '2026-04')!.dateLabel).toBe('2026-04')
    expect(buckets.find((bucket) => bucket.key === '2026-12')).toBeUndefined()
  })

  it('时间线：跨度超过 30 个月按年聚合', () => {
    const list = [
      entry('2020-01-05', '', '感冒'),
      entry('2023-06-05', '', '感冒'),
      entry('2023-12-05', '', '感冒')
    ]
    const analysis = analyzeSearch(list, '感冒')!
    expect(analysis.timeline.unit).toBe('year')
    expect(analysis.timeline.buckets.map((bucket) => [bucket.key, bucket.n])).toEqual([
      ['2020', 1],
      ['2023', 2]
    ])
    expect(analysis.timeline.buckets[0]!.dateLabel).toBe('2020')
  })

  it('多词按"与"处理，与列表搜索口径一致', () => {
    const list = [
      entry('2026-05-01', '', '感冒和头疼一起来'),
      entry('2026-05-02', '', '只有感冒'),
      entry('2026-05-03', '', '只有头疼')
    ]
    const analysis = analyzeSearch(list, '感冒 头疼')!
    expect(analysis.hits.map((hit) => hit.entry.date)).toEqual(['2026-05-01'])
  })

  it('标签命中同样计入篇数', () => {
    const analysis = analyzeSearch(fixtures, '身体')
    expect(analysis!.hits).toHaveLength(1)
    expect(analysis!.hits[0]!.entry.date).toBe('2025-11-02')
    expect(analysis!.hits[0]!.snippets).toHaveLength(0)
  })
})

describe('highlightSegments', () => {
  it('全角查询也能切出高亮段', () => {
    const segments = highlightSegments('今天 rain 了', 'ＲＡＩＮ')
    expect(segments.filter((segment) => segment.match).map((segment) => segment.text)).toEqual([
      'rain'
    ])
  })
})

/**
 * 文本匹配的底层原语：检索高亮、证据片段、批注定位都从这里取，
 * 避免每个功能各写一套「归一化 + 找下标 + 合并区间」。
 */

/** 去掉 Markdown 标记与 URL，只留下"人读的字" */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*\n?/g, ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片（含附件图片）不计入字数
    .replace(/\[([^\]]*)\]\((?:attachment|https?):[^)]*\)/g, '$1') // 链接只保留文字
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '')
    .replace(/^[ \t]{0,3}\d+\.[ \t]+/gm, '')
    .replace(/[*_~`|]/g, '')
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
    .replace(/<[^>]+>/g, '')
}

/** NFKC + 小写：全角字母/数字也一并归一化 */
export function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

/** 查询串 → 词数组：空格分词、小写、去空 */
export function normalizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
}

/** [start, end) 区间 */
export type TextRange = [number, number]

/** 合并重叠或相接的区间，按起点升序 */
function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: TextRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    } else {
      merged.push([range[0], range[1]])
    }
  }
  return merged
}

/**
 * 在 text 里找出所有 needle 出现的位置（非重叠、NFKC + 小写匹配）。
 * 下标基于原文：全角字符归一化后长度不变，因此可以直接用来切片。
 */
function findRanges(text: string, needles: readonly string[]): TextRange[] {
  if (!text) return []
  const haystack = normalizeForMatch(text)
  const ranges: TextRange[] = []
  for (const needle of needles) {
    const normalized = normalizeForMatch(needle)
    if (!normalized) continue
    let index = haystack.indexOf(normalized)
    while (index !== -1) {
      ranges.push([index, index + normalized.length])
      index = haystack.indexOf(normalized, index + normalized.length)
    }
  }
  return mergeRanges(ranges)
}

/** 取区间前后若干字符，越界则补省略号 */
function sliceAround(
  text: string,
  [start, end]: TextRange,
  before: number,
  after: number
): string {
  const from = Math.max(0, start - before)
  const to = Math.min(text.length, end + after)
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

export interface HighlightSegment {
  text: string
  match: boolean
}

/** 把命中的片段切成可渲染的段落，供高亮使用 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const terms = normalizeQuery(query)
  if (terms.length === 0 || !text) return [{ text, match: false }]

  const ranges = findRanges(text, terms)
  if (ranges.length === 0) return [{ text, match: false }]

  const segments: HighlightSegment[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false })
    segments.push({ text: text.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments
}

/** 列表摘要：去掉 Markdown 与附件后的前 N 个字（不围绕命中，只截开头） */
export function previewSnippet(markdown: string, limit: number): string {
  const plain = plainText(markdown).replace(/\s+/g, ' ').trim()
  return plain.slice(0, limit)
}

export interface SearchSnippet {
  /** 已截断的纯文本片段（可能带首尾省略号） */
  text: string
  segments: HighlightSegment[]
}

const SNIPPET_BEFORE = 18
const SNIPPET_AFTER = 26

/**
 * 证据片段：命中 ≤2 次给一条；≥3 次给"第一次 + 最后一次"。
 * queries 为已归一化的词。
 */
export function buildSnippets(markdown: string, needles: readonly string[]): SearchSnippet[] {
  const plain = plainText(markdown).replace(/\s+/g, ' ').trim()
  if (!plain) return []
  const matches = findRanges(plain, needles)
  if (matches.length === 0) return []

  const picks = matches.length <= 2 ? [matches[0]!] : [matches[0]!, matches[matches.length - 1]!]
  const query = needles.join(' ')
  return picks.map((range) => {
    const text = sliceAround(plain, range, SNIPPET_BEFORE, SNIPPET_AFTER)
    return { text, segments: highlightSegments(text, query) }
  })
}

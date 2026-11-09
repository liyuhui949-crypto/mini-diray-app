/**
 * 字数统计：中文按字计，拉丁按词计。
 * 与界面状态栏、条目列表、统计页共用同一个纯函数，保证口径一致。
 */

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/g
const LATIN_WORD_RE = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g

import { plainText, previewSnippet } from './text'

export { plainText }

export function countWords(text: string): number {
  if (!text) return 0
  const plain = plainText(text)
  const cjk = plain.match(CJK_RE)?.length ?? 0
  const latin = plain.match(LATIN_WORD_RE)?.length ?? 0
  return cjk + latin
}

/** 标题 + 正文（与 DiaryEntry.wordCount 口径一致） */
export function countEntryWords(title: string, body: string): number {
  const titleWords = title.trim() ? countWords(title) : 0
  return titleWords + countWords(body)
}

/** 列表摘要：去掉附件与标题后的前 N 个字 */
export function makeSnippet(body: string, title: string, limit = 90): string {
  return previewSnippet(body, limit) || title.slice(0, limit)
}

/** 隐藏标题时，用正文首行代替标题 */
export function deriveTitle(title: string, body: string): string {
  const trimmed = title.trim()
  if (trimmed) return trimmed
  const firstLine = plainText(body)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return (firstLine ?? '').slice(0, 40)
}

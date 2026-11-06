import { AppError } from '@shared/errors'

import { extractLocalDate, splitTitleAndBody, type ParseOutcome, type ParsedEntry } from './helpers'

/**
 * Day One TXT 导出：
 * 每个条目以 `\tDate:\t<date>` 开头（部分版本没有缩进），
 * 其余字段用 `\tKey:\tvalue` 表示，正文是最后一个字段的剩余内容。
 */
export function parseDayOneTxt(content: string): ParseOutcome {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.trim()) throw new AppError('INVALID_INPUT', '文件是空的')

  const entries: ParsedEntry[] = []
  const warnings: ParseOutcome['warnings'] = []

  const blocks = splitBlocks(normalized)
  for (const block of blocks) {
    const dateLine = /^\s*Date:\s*(.+)$/m.exec(block)
    if (!dateLine) {
      warnings.push({ message: '有一段缺少 Date 字段，已跳过' })
      continue
    }
    const date = extractLocalDate(dateLine[1])
    if (!date) {
      warnings.push({ message: `无法解析日期：${dateLine[1]?.trim() ?? ''}` })
      continue
    }

    const titleField = /^\s*Title:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? ''
    const bodyStart = block.indexOf(dateLine[0]) + dateLine[0].length
    let remainder = block.slice(bodyStart).replace(/^\n+/, '')

    // 去掉已知的头部字段（Time / Timezone / Starred …），保留正文
    remainder = remainder
      .split('\n')
      .filter((line) => !/^\s*(Time|Timezone|Starred|UUID|Location|Weather|Tags|Title):/i.test(line))
      .join('\n')
      .replace(/^\n+/, '')

    let title = titleField
    let body = remainder
    if (!title) {
      const split = splitTitleAndBody(remainder)
      title = split.title
      body = split.body
    }

    entries.push({ date, title: title.slice(0, 500), body, tags: [] })
  }

  if (entries.length === 0) throw new AppError('INVALID_INPUT', '没有识别到任何 Day One 条目')
  entries.sort((a, b) => (a.date < b.date ? -1 : 1))
  return { entries, warnings }
}

function splitBlocks(content: string): string[] {
  const lines = content.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let seenDate = false
  for (const line of lines) {
    if (/^\s*Date:\s*/.test(line)) {
      if (seenDate && current.length > 0) {
        blocks.push(current.join('\n'))
        current = []
      }
      seenDate = true
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks
}

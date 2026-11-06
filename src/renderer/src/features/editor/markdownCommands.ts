/**
 * Markdown 编辑命令：纯函数，输入输出都是「文本 + 选区」，
 * 这样工具栏、快捷键、单测共用同一套逻辑。
 */

export interface TextEdit {
  text: string
  selectionStart: number
  selectionEnd: number
}

export type CommandKind = 'bold' | 'italic' | 'unorderedList' | 'orderedList'

/** 用标记包裹选区；空选区时插入占位文字并选中它 */
export function wrapSelection(
  edit: TextEdit,
  before: string,
  after: string,
  placeholder = '文字'
): TextEdit {
  const { text, selectionStart, selectionEnd } = edit
  const selected = text.slice(selectionStart, selectionEnd)
  if (selected.length === 0) {
    const inserted = `${before}${placeholder}${after}`
    return {
      text: text.slice(0, selectionStart) + inserted + text.slice(selectionStart),
      selectionStart: selectionStart + before.length,
      selectionEnd: selectionStart + before.length + placeholder.length
    }
  }
  // 已经被包裹 → 去掉标记（可撤销的"再点一次取消"）
  const outerStart = selectionStart - before.length
  const outerEnd = selectionEnd + after.length
  if (
    outerStart >= 0 &&
    text.slice(outerStart, selectionStart) === before &&
    text.slice(selectionEnd, outerEnd) === after
  ) {
    return {
      text: text.slice(0, outerStart) + selected + text.slice(outerEnd),
      selectionStart: outerStart,
      selectionEnd: outerStart + selected.length
    }
  }
  return {
    text: text.slice(0, selectionStart) + before + selected + after + text.slice(selectionEnd),
    selectionStart: selectionStart + before.length,
    selectionEnd: selectionEnd + before.length
  }
}

function lineBounds(text: string, position: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', Math.max(0, position - 1)) + 1
  const nextBreak = text.indexOf('\n', position)
  const end = nextBreak === -1 ? text.length : nextBreak
  return { start, end }
}

/** 逐行加/去列表前缀；已有前缀则整段去掉 */
export function toggleLinePrefix(edit: TextEdit, ordered: boolean): TextEdit {
  const { text, selectionStart, selectionEnd } = edit
  const firstLine = lineBounds(text, selectionStart)
  const lastLine = lineBounds(text, Math.max(selectionStart, selectionEnd - 1))
  const block = text.slice(firstLine.start, lastLine.end)
  const lines = block.split('\n')

  const prefixFor = (index: number): string => (ordered ? `${index + 1}. ` : '- ')
  const hasPrefix = (line: string): boolean => /^\s*(-\s+|\d+\.\s+)/.test(line)
  const allPrefixed = lines.every((line) => line.trim().length === 0 || hasPrefix(line))

  const nextLines = lines.map((line, index) => {
    if (line.trim().length === 0) return line
    if (allPrefixed) return line.replace(/^\s*(-\s+|\d+\.\s+)/, '')
    return `${prefixFor(index)}${line.replace(/^\s*(-\s+|\d+\.\s+)/, '')}`
  })
  const nextBlock = nextLines.join('\n')
  return {
    text: text.slice(0, firstLine.start) + nextBlock + text.slice(lastLine.end),
    selectionStart: firstLine.start,
    selectionEnd: firstLine.start + nextBlock.length
  }
}

/** 在光标处插入文本（附件引用、链接等） */
export function insertAtSelection(edit: TextEdit, insert: string): TextEdit {
  const { text, selectionStart, selectionEnd } = edit
  return {
    text: text.slice(0, selectionStart) + insert + text.slice(selectionEnd),
    selectionStart: selectionStart + insert.length,
    selectionEnd: selectionStart + insert.length
  }
}

export function applyCommand(edit: TextEdit, command: CommandKind): TextEdit {
  switch (command) {
    case 'bold':
      return wrapSelection(edit, '**', '**', '粗体')
    case 'italic':
      return wrapSelection(edit, '*', '*', '斜体')
    case 'unorderedList':
      return toggleLinePrefix(edit, false)
    case 'orderedList':
      return toggleLinePrefix(edit, true)
    default:
      return edit
  }
}

/** 附件引用：图片用 ![]()，其他用 []() */
export function attachmentMarkdown(
  attachment: { id: string; name: string; kind: string }
): string {
  const name = attachment.name.replace(/[[\]]/g, '')
  const isImage = attachment.kind === 'image'
  return `${isImage ? '!' : ''}[${name}](attachment://${attachment.id})`
}

/** 从正文里抽出所有 attachment:// 引用（用于校验/GC 提示） */
export function collectAttachmentRefs(body: string): string[] {
  const found = new Set<string>()
  for (const match of body.matchAll(/attachment:\/\/([0-9a-f-]{36})/gi)) {
    if (match[1]) found.add(match[1].toLowerCase())
  }
  return [...found]
}

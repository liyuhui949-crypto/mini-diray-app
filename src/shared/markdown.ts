import type { Attachment } from './types'
import { formatBytes } from './date'

/**
 * 极简 Markdown → HTML 渲染器（PDF / 纯文本导出的兜底）。
 *
 * 为什么自己写：PDF 需要"不依赖 React 渲染器"的确定性输出，
 * 且结果会在主进程里再过一遍 sanitize-html。
 * 界面的富文本预览用 react-markdown + rehype-sanitize，两者覆盖范围不同。
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const ATTACHMENT_RE = /^attachment:\/\/([0-9a-f-]{36})$/i

function inline(text: string, attachments: Map<string, Attachment>): string {
  let result = escapeHtml(text)

  // 图片：attachment:// → 内嵌图片
  result = result.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt: string, url: string) => {
    const id = ATTACHMENT_RE.exec(url)?.[1]?.toLowerCase()
    const attachment = id ? attachments.get(id) : undefined
    if (!attachment) return alt
    return `<figure><img src="attachment://${attachment.id}" alt="${escapeHtml(attachment.name)}" /><figcaption>${escapeHtml(attachment.name)} · ${escapeHtml(formatBytes(attachment.size))}</figcaption></figure>`
  })

  // 链接：附件 → 附件卡片；https → 可点击链接；其他 → 纯文本
  result = result.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    const id = ATTACHMENT_RE.exec(url)?.[1]?.toLowerCase()
    if (id) {
      const attachment = attachments.get(id)
      if (!attachment) return label
      const kindLabel =
        attachment.kind === 'video' ? '视频' : attachment.kind === 'audio' ? '音频' : '文件'
      return `<div class="media-card"><span class="badge">${kindLabel}</span><span>${escapeHtml(attachment.name)}</span><span class="muted">${escapeHtml(formatBytes(attachment.size))}</span></div>`
    }
    if (url.startsWith('https:')) {
      return `<a href="${escapeHtml(url)}">${label}</a>`
    }
    return label
  })

  result = result
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')

  return result
}

export interface RenderMarkdownOptions {
  attachments?: readonly Attachment[]
}

export function renderMarkdownToHtml(body: string, options: RenderMarkdownOptions = {}): string {
  const attachments = new Map(
    (options.attachments ?? []).map((attachment) => [attachment.id.toLowerCase(), attachment])
  )
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const output: string[] = []
  let list: 'ul' | 'ol' | null = null
  let inCode = false
  let codeBuffer: string[] = []

  const closeList = (): void => {
    if (list) {
      output.push(`</${list}>`)
      list = null
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    if (line.startsWith('```')) {
      if (inCode) {
        output.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`)
        codeBuffer = []
        inCode = false
      } else {
        closeList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeBuffer.push(rawLine)
      continue
    }

    if (line.trim().length === 0) {
      closeList()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = Math.min(6, heading[1]?.length ?? 1)
      output.push(`<h${level}>${inline(heading[2] ?? '', attachments)}</h${level}>`)
      continue
    }

    if (/^([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      closeList()
      output.push('<hr />')
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      closeList()
      output.push(`<blockquote>${inline(quote[1] ?? '', attachments)}</blockquote>`)
      continue
    }

    const unordered = /^[-*+]\s+(.*)$/.exec(line)
    if (unordered) {
      if (list !== 'ul') {
        closeList()
        output.push('<ul>')
        list = 'ul'
      }
      output.push(`<li>${inline(unordered[1] ?? '', attachments)}</li>`)
      continue
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line)
    if (ordered) {
      if (list !== 'ol') {
        closeList()
        output.push('<ol>')
        list = 'ol'
      }
      output.push(`<li>${inline(ordered[1] ?? '', attachments)}</li>`)
      continue
    }

    closeList()
    output.push(`<p>${inline(line, attachments)}</p>`)
  }

  if (inCode && codeBuffer.length > 0) {
    output.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`)
  }
  closeList()
  return output.join('\n')
}

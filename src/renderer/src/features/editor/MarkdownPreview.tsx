import { useMemo } from 'react'

import { Download, FileAudio, FileVideo } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

import { copy } from '@shared/copy'
import { formatBytes } from '@shared/date'
import { highlightSegments } from '@shared/search'
import type { Annotation, Attachment } from '@shared/types'

import { call } from '@/api/client'
import { saveAttachmentAs } from '@/features/attachments/saveAttachmentAs'
import { useUiStore } from '@/stores/ui'

import styles from './media.module.scss'

const schema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.['href'] ?? []), 'attachment'],
    src: [...(defaultSchema.protocols?.['src'] ?? []), 'attachment']
  },
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.['img'] ?? []), 'src', 'alt', 'width', 'height']
  }
}

const ATTACHMENT_SRC_RE = /^attachment:\/\/([0-9a-f-]{36})$/i

/**
 * react-markdown v10 默认会清空未知协议的 URL（安全考虑），
 * 这里显式放行 attachment:，否则图片与媒体引用会被抹成空串。
 */
function urlTransform(url: string): string {
  if (url.startsWith('attachment://')) return url
  if (/^https:\/\//.test(url)) return url
  if (/^(#|\/|\.\/|\.\.\/)/.test(url)) return url
  return ''
}

interface MarkdownPreviewProps {
  body: string
  attachments: readonly Attachment[]
  /** 检索词：渲染时把命中文本包进 <mark class="hitMark"> */
  highlight?: string
  /** 批注：把引文包进 <mark class="ann-mark" data-ann-id>，点它可跳到卡片 */
  annotations?: readonly Annotation[]
}

/** hast 的最小结构，只为写一个不依赖额外包的高亮插件 */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function markTextNodes(parent: HastNode, query: string): void {
  if (!parent.children) return
  const next: HastNode[] = []
  for (const child of parent.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const segments = highlightSegments(child.value, query)
      if (segments.length <= 1 && !segments[0]?.match) {
        next.push(child)
        continue
      }
      for (const segment of segments) {
        if (!segment.match) {
          next.push({ type: 'text', value: segment.text })
          continue
        }
        next.push({
          type: 'element',
          tagName: 'mark',
          properties: { className: ['hitMark'] },
          children: [{ type: 'text', value: segment.text }]
        })
      }
      continue
    }
    if (child.children) markTextNodes(child, query)
    next.push(child)
  }
  parent.children = next
}

const ANN_CLASS = 'ann-mark'

function isAnnotated(node: HastNode): boolean {
  const className = node.properties?.['className']
  return Array.isArray(className) && className.includes(ANN_CLASS)
}

/** 把一段文本里的引文包成 ann-mark；同一段里多次出现只包第一处（原型行为） */
function wrapQuote(parent: HastNode, quote: string, annotation: Annotation): boolean {
  if (!parent.children) return false
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index]!
    if (child.type === 'element' && child.tagName === 'mark' && isAnnotated(child)) continue
    if (child.type === 'text' && typeof child.value === 'string') {
      const at = child.value.indexOf(quote)
      if (at === -1) continue
      const before = child.value.slice(0, at)
      const after = child.value.slice(at + quote.length)
      const mark: HastNode = {
        type: 'element',
        tagName: 'mark',
        properties: {
          className: [ANN_CLASS],
          'data-ann-id': annotation.id,
          title: `${annotation.tag || '批注'} · ${annotation.at}`
        },
        children: [{ type: 'text', value: quote }]
      }
      const replacement: HastNode[] = []
      if (before) replacement.push({ type: 'text', value: before })
      replacement.push(mark)
      if (after) replacement.push({ type: 'text', value: after })
      parent.children.splice(index, 1, ...replacement)
      return true
    }
    if (child.children && wrapQuote(child, quote, annotation)) return true
  }
  return false
}

function rehypeAnnotationMarks(annotations: readonly Annotation[]) {
  return (tree: unknown): void => {
    if (annotations.length === 0) return
    for (const annotation of annotations) {
      if (annotation.quote) wrapQuote(tree as HastNode, annotation.quote, annotation)
    }
  }
}

/** rehype 插件：在 sanitize 之后把命中的文字包成 mark（节点由我们自己生成，安全） */
function rehypeSearchHighlight(query: string) {
  return (tree: unknown): void => {
    if (query.trim()) markTextNodes(tree as HastNode, query)
  }
}

export function MarkdownPreview({
  body,
  attachments,
  highlight,
  annotations
}: MarkdownPreviewProps): React.JSX.Element {
  const byId = new Map(attachments.map((attachment) => [attachment.id.toLowerCase(), attachment]))
  const rehypePlugins = useMemo(
    () =>
      [
        [rehypeSanitize, schema],
        ...(annotations && annotations.length > 0 ? [[rehypeAnnotationMarks, annotations]] : []),
        [rehypeSearchHighlight, highlight ?? '']
      ] as const,
    [highlight, annotations]
  )

  return (
    <div className="mdPreview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins as unknown as React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']}
        urlTransform={urlTransform}
        components={{
          // 段落用 div：附件 figure / 媒体卡片是块级元素，放进 <p> 会造成非法嵌套
          p: ({ children }) => <div className="mdPara">{children}</div>,
          img: ({ src, alt }) => {
            const id = typeof src === 'string' ? ATTACHMENT_SRC_RE.exec(src)?.[1]?.toLowerCase() : undefined
            const attachment = id ? byId.get(id) : undefined
            if (!attachment) return <span className={styles.missing}>{alt || '图片'}</span>
            return <PreviewImage attachment={attachment} />
          },
          a: ({ href, children }) => {
            const id = typeof href === 'string' ? ATTACHMENT_SRC_RE.exec(href)?.[1]?.toLowerCase() : undefined
            const attachment = id ? byId.get(id) : undefined
            if (attachment) return <AttachmentCard attachment={attachment} label={children} />
            if (href && /^https:/.test(href)) {
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault()
                    void call('shell:openExternal', { url: href })
                  }}
                >
                  {children}
                </a>
              )
            }
            return <span>{children}</span>
          }
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  )
}

function PreviewImage({ attachment }: { attachment: Attachment }): React.JSX.Element {
  const openLightbox = useUiStore((state) => state.openLightbox)
  return (
    <figure className={styles.figure}>
      <img
        src={`attachment://${attachment.id}`}
        alt={attachment.name}
        onClick={() => openLightbox(attachment.id)}
        onError={(event) => {
          event.currentTarget.style.display = 'none'
        }}
      />
      <figcaption>
        {attachment.name} · {formatBytes(attachment.size)} · {copy.attachments.viewOriginal}
      </figcaption>
    </figure>
  )
}

function AttachmentCard({
  attachment,
  label
}: {
  attachment: Attachment
  label: React.ReactNode
}): React.JSX.Element {
  const openLightbox = useUiStore((state) => state.openLightbox)

  if (attachment.kind === 'video') {
    return (
      <div className={styles.mediaCard}>
        <div className={styles.mediaHead}>
          <FileVideo size={15} className={styles.mediaIcon} />
          <span className={styles.mediaName}>{attachment.name}</span>
          <span className={styles.mediaBadge}>{copy.attachments.video}</span>
          <span className={styles.mediaMeta}>{formatBytes(attachment.size)}</span>
          <button
            type="button"
            className={styles.mediaAction}
            onClick={() => openLightbox(attachment.id)}
          >
            {copy.attachments.playLarger}
          </button>
        </div>
        <video
          className={styles.video}
          controls
          preload="metadata"
          src={`attachment://${attachment.id}`}
        >
          {String(label ?? attachment.name)}
        </video>
      </div>
    )
  }

  if (attachment.kind === 'audio') {
    return (
      <div className={styles.mediaCard}>
        <div className={styles.mediaHead}>
          <FileAudio size={15} className={styles.mediaIcon} />
          <span className={styles.mediaName}>{attachment.name}</span>
          <span className={styles.mediaBadge}>{copy.attachments.audio}</span>
          <span className={styles.mediaMeta}>{formatBytes(attachment.size)}</span>
        </div>
        <audio className={styles.audio} controls preload="metadata" src={`attachment://${attachment.id}`} />
      </div>
    )
  }

  return (
    <button
      type="button"
      className={styles.fileCard}
      onClick={() => {
        void saveAttachmentAs(attachment.id)
      }}
    >
      <span className={styles.mediaName}>{attachment.name}</span>
      <span className={styles.mediaMeta}>{formatBytes(attachment.size)}</span>
      <Download size={14} className={styles.mediaIcon} />
    </button>
  )
}

import { Download, FileAudio, FileVideo } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

import { copy } from '@shared/copy'
import { formatBytes } from '@shared/date'
import type { Attachment } from '@shared/types'

import { call } from '@/api/client'
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

interface MarkdownPreviewProps {
  body: string
  attachments: readonly Attachment[]
}

export function MarkdownPreview({ body, attachments }: MarkdownPreviewProps): React.JSX.Element {
  const byId = new Map(attachments.map((attachment) => [attachment.id.toLowerCase(), attachment]))

  return (
    <div className="mdPreview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={{
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
        loading="lazy"
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
            {copy.attachments.viewOriginal}
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
        void call('attachment:saveAs', { id: attachment.id })
      }}
    >
      <span className={styles.mediaName}>{attachment.name}</span>
      <span className={styles.mediaMeta}>{formatBytes(attachment.size)}</span>
      <Download size={14} className={styles.mediaIcon} />
    </button>
  )
}

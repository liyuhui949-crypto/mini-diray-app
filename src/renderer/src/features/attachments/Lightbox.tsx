import { copy } from '@shared/copy'
import { formatBytes, formatDateCN } from '@shared/date'
import type { Attachment } from '@shared/types'

import { saveAttachmentAs } from '@/features/attachments/saveAttachmentAs'
import { Button, Dialog } from '@/components/ui'
import { useEntriesStore } from '@/stores/entries'
import { useUiStore } from '@/stores/ui'

import styles from './lightbox.module.scss'

export function Lightbox(): React.JSX.Element {
  const lightboxId = useUiStore((state) => state.lightboxId)
  const closeLightbox = useUiStore((state) => state.closeLightbox)
  const entries = useEntriesStore((state) => state.entries)

  const attachment: Attachment | null = (() => {
    if (!lightboxId) return null
    for (const entry of entries) {
      const found = entry.attachments.find((item) => item.id === lightboxId)
      if (found) return found
    }
    return null
  })()

  return (
    <Dialog
      open={lightboxId !== null && attachment !== null}
      onOpenChange={(value) => {
        if (!value) closeLightbox()
      }}
      width={760}
      title={attachment?.name ?? ''}
      footer={
        attachment ? (
          <>
            <Button onClick={() => void saveAttachmentAs(attachment.id)}>
              另存为…
            </Button>
            <Button variant="primary" onClick={closeLightbox}>
              {copy.common.close}
            </Button>
          </>
        ) : null
      }
    >
      {attachment ? (
        <div className={styles.body}>
          {attachment.kind === 'image' ? (
            <img className={styles.image} src={`attachment://${attachment.id}`} alt={attachment.name} />
          ) : null}
          {attachment.kind === 'video' ? (
            <video
              className={styles.video}
              src={`attachment://${attachment.id}`}
              controls
              autoPlay
              preload="metadata"
            />
          ) : null}
          {attachment.kind === 'audio' ? (
            <div className={styles.audioWrap}>
              <div className={styles.audioGlyph}>音频</div>
              <audio
                className={styles.audio}
                src={`attachment://${attachment.id}`}
                controls
                autoPlay
                preload="metadata"
              />
            </div>
          ) : null}
          {attachment.kind === 'file' ? (
            <p className={styles.fileHint}>这个文件不能预览，可以直接另存为。</p>
          ) : null}
          <div className={styles.meta}>
            <span>{formatBytes(attachment.size)}</span>
            <span>{formatDateCN(attachment.createdAt.slice(0, 10))}</span>
            <span className={styles.badge}>已加密</span>
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}

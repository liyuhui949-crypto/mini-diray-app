import { useEffect, useRef, useState } from 'react'

import { ChevronRight, PanelsTopLeft, X } from 'lucide-react'

import { copy } from '@shared/copy'
import type { Annotation } from '@shared/types'

import { Button } from '@/components/ui'
import { persistLayout } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'

import styles from './annotations.module.scss'

export interface AnnotationDraft {
  quote: string
  tag: string
  body: string
}

interface AnnotationPaneProps {
  annotations: Annotation[]
  /** 正文（用于检测引文锚点是否还存在） */
  body: string
  /** 当前是否预览模式（两种模式的锚点 DOM 不同，变化时需要重扫） */
  preview: boolean
  /** 有草稿时展开编辑区 */
  draft: AnnotationDraft | null
  busy: boolean
  activeId: string | null
  onDraftChange: (patch: Partial<AnnotationDraft>) => void
  onCancel: () => void
  onSave: () => void
  onPick: (annotation: Annotation) => void
}

export function AnnotationPane({
  annotations,
  body,
  preview,
  draft,
  busy,
  activeId,
  onDraftChange,
  onCancel,
  onSave,
  onPick
}: AnnotationPaneProps): React.JSX.Element {
  const setAnnotationCollapsed = useUiStore((state) => state.setAnnotationCollapsed)
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const [flashedId, setFlashedId] = useState<string | null>(null)
  const [missingAnchors, setMissingAnchors] = useState<ReadonlySet<string>>(new Set())

  // 引文在正文里被删掉后，卡片要能提示"原文已找不到"（预览/源码两种渲染都要扫）
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const missing = new Set<string>()
      for (const annotation of annotations) {
        if (!annotation.quote) continue
        const selector =
          `.ann-mark[data-ann-id="${annotation.id}"], .cmAnn[data-ann-id="${annotation.id}"]`
        if (!document.querySelector(selector)) missing.add(annotation.id)
      }
      setMissingAnchors(missing)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [annotations, body, preview])

  const composing = draft !== null
  useEffect(() => {
    if (composing) textRef.current?.focus()
  }, [composing])

  useEffect(() => {
    if (!activeId) return
    setFlashedId(activeId)
    const timer = window.setTimeout(() => setFlashedId(null), 1600)
    return () => window.clearTimeout(timer)
  }, [activeId])

  return (
    <aside className={styles.pane} data-composing={draft !== null}>
      <header className={styles.head}>
        <span className={styles.headTitle}>
          <PanelsTopLeft size={13} />
          {copy.annotations.title}
          <span className={styles.count}>{annotations.length}</span>
        </span>
        {draft ? null : <span className={styles.headHint}>{copy.annotations.hint}</span>}
        <button
          type="button"
          className={styles.iconBtn}
          title={copy.annotations.collapse}
          aria-label={copy.annotations.collapse}
          onClick={() => {
            setAnnotationCollapsed(true)
            persistLayout({ annotationCollapsed: true })
          }}
        >
          <ChevronRight size={14} />
        </button>
      </header>

      {draft ? (
        <div className={styles.edit}>
          <div className={styles.editHead}>
            <span>{copy.annotations.composeTitle}</span>
            <span className={styles.dash} />
            <button
              type="button"
              className={styles.iconBtn}
              aria-label={copy.annotations.close}
              onClick={onCancel}
            >
              <X size={12} />
            </button>
          </div>
          <div className={styles.quoteBox} data-empty={!draft.quote}>
            {draft.quote ? copy.annotations.quote(draft.quote) : copy.annotations.wholeDoc}
          </div>
          <label className={styles.tagRow}>
            <span className={styles.hash}>#</span>
            <input
              id="annotation-tag"
              value={draft.tag}
              placeholder={copy.annotations.tagPlaceholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onDraftChange({ tag: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave()
              }}
            />
          </label>
          <textarea
            id="annotation-body"
            ref={textRef}
            className={styles.textarea}
            value={draft.body}
            aria-label={copy.annotations.title}
            onChange={(event) => onDraftChange({ body: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                onSave()
              }
            }}
          />
          <div className={styles.actions}>
            <Button size="sm" onClick={onCancel}>
              {copy.annotations.cancel}
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={onSave}>
              {copy.annotations.save}
            </Button>
          </div>
        </div>
      ) : null}

      <div className={styles.list} data-testid="annotation-list">
        {annotations.length === 0 ? (
          <div className={styles.empty}>
            <b>{copy.annotations.emptyTitle}</b>
          </div>
        ) : (
          annotations.map((annotation) => (
            <button
              key={annotation.id}
              type="button"
              className={[styles.card, flashedId === annotation.id ? styles.cardActive : '']
                .filter(Boolean)
                .join(' ')}
              data-annotation-card={annotation.id}
              onClick={() => onPick(annotation)}
            >
              <span className={styles.cardHead}>
                {annotation.tag ? (
                  <span className={styles.tag} title={annotation.tag}>
                    {annotation.tag}
                  </span>
                ) : (
                  <span className={styles.unnamed}>{copy.annotations.unnamed}</span>
                )}
                <span className={styles.at}>{annotation.at}</span>
              </span>
              <span className={styles.cardQuote} data-empty={!annotation.quote}>
                {annotation.quote
                  ? copy.annotations.quote(annotation.quote)
                  : copy.annotations.wholeDocCard}
              </span>
              <span className={styles.cardBody}>{annotation.body}</span>
              {missingAnchors.has(annotation.id) ? (
                <span className={styles.missing}>{copy.annotations.anchorMissing}</span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </aside>
  )
}

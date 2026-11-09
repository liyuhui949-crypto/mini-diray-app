import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as placeholderExtension,
  type DecorationSet
} from '@codemirror/view'
import { tags as lezerTags } from '@lezer/highlight'

import { highlightSegments } from '@shared/search'
import type { Annotation } from '@shared/types'

import { applyCommand, insertAtSelection, type CommandKind } from './markdownCommands'

export interface EditorHandle {
  focus: () => void
  insertText: (text: string) => void
  runCommand: (command: CommandKind) => void
  /** 当前选区文本与屏幕位置（用于"选中文字 → 加批注"浮条） */
  getSelection: () => { text: string; rect: DOMRect } | null
}

interface CodeMirrorEditorProps {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
  placeholderText?: string
  handleRef?: Ref<EditorHandle>
  /** 检索跳转：把命中的词标出来（只读覆盖层，用户一输入就清除） */
  highlightQuery?: string | null
  onHighlightCount?: (count: number) => void
  /** 批注锚点：引文在源码里也画出虚线底纹 */
  annotations?: readonly Annotation[]
  onAnnotationClick?: (id: string) => void
}

const highlightStyle = HighlightStyle.define([
  { tag: lezerTags.heading1, class: 'mdH1' },
  { tag: lezerTags.heading2, class: 'mdH2' },
  { tag: lezerTags.heading3, class: 'mdH3' },
  { tag: lezerTags.strong, class: 'mdStrong' },
  { tag: lezerTags.emphasis, class: 'mdEm' },
  { tag: lezerTags.quote, class: 'mdQuote' },
  { tag: lezerTags.link, class: 'mdLink' },
  { tag: lezerTags.url, class: 'mdLink' },
  { tag: lezerTags.monospace, class: 'mdCode' },
  { tag: lezerTags.processingInstruction, class: 'mdMarker' },
  { tag: lezerTags.meta, class: 'mdMeta' },
  { tag: lezerTags.list, class: 'mdMeta' }
])

const baseTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-gutters': { display: 'none' }
})

/** 检索命中的装饰层：只在显式 set 时生成，任何 doc 变化都会清空 */
const setHighlightEffect = StateEffect.define<string | null>()

function buildHighlight(doc: string, query: string): { deco: DecorationSet; count: number } {
  if (!query.trim()) return { deco: Decoration.none, count: 0 }
  const ranges: ReturnType<Decoration['range']>[] = []
  let offset = 0
  let count = 0
  for (const segment of highlightSegments(doc, query)) {
    if (segment.match) {
      ranges.push(
        Decoration.mark({ class: 'cmHit' }).range(offset, offset + segment.text.length)
      )
      count += 1
    }
    offset += segment.text.length
  }
  return { deco: Decoration.set(ranges, true), count }
}

const highlightField = StateField.define<{ deco: DecorationSet; count: number }>({
  create: () => ({ deco: Decoration.none, count: 0 }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHighlightEffect)) {
        return buildHighlight(tr.state.doc.toString(), effect.value ?? '')
      }
    }
    if (tr.docChanged) return { deco: Decoration.none, count: 0 }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco)
})

/** 批注锚点装饰层：正文或批注变化时重算 */
const setAnnotationsEffect = StateEffect.define<readonly Annotation[]>()

function buildAnnotationDecorations(doc: string, annotations: readonly Annotation[]): DecorationSet {
  const ranges: ReturnType<Decoration['range']>[] = []
  for (const annotation of annotations) {
    if (!annotation.quote) continue
    let index = doc.indexOf(annotation.quote)
    while (index !== -1) {
      ranges.push(
        Decoration.mark({
          class: 'cmAnn',
          attributes: { 'data-ann-id': annotation.id, title: annotation.tag || '批注' }
        }).range(index, index + annotation.quote.length)
      )
      index = doc.indexOf(annotation.quote, index + annotation.quote.length)
    }
  }
  return Decoration.set(ranges, true)
}

const annotationField = StateField.define<{
  annotations: readonly Annotation[]
  deco: DecorationSet
}>({
  create: () => ({ annotations: [], deco: Decoration.none }),
  update(value, tr) {
    let annotations = value.annotations
    let changed = false
    for (const effect of tr.effects) {
      if (effect.is(setAnnotationsEffect)) {
        annotations = effect.value
        changed = true
      }
    }
    if (tr.docChanged || changed) {
      return { annotations, deco: buildAnnotationDecorations(tr.state.doc.toString(), annotations) }
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco)
})

const readOnlyCompartment = new Compartment()
const placeholderCompartment = new Compartment()

const contentAttributes: Extension = EditorView.contentAttributes.of({
  spellcheck: 'false',
  autocorrect: 'off',
  autocapitalize: 'off'
})

function selectionEdit(view: EditorView): { text: string; selectionStart: number; selectionEnd: number } {
  const selection = view.state.selection.main
  return {
    text: view.state.doc.toString(),
    selectionStart: selection.from,
    selectionEnd: selection.to
  }
}

function commitEdit(
  view: EditorView,
  edit: { text: string; selectionStart: number; selectionEnd: number }
): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: edit.text },
    selection: { anchor: edit.selectionStart, head: edit.selectionEnd }
  })
  view.focus()
}

function runCommandOnView(view: EditorView, command: CommandKind): void {
  commitEdit(view, applyCommand(selectionEdit(view), command))
}

export function CodeMirrorEditor({
  value,
  onChange,
  readOnly = false,
  placeholderText = '',
  handleRef,
  highlightQuery = null,
  onHighlightCount,
  annotations = [],
  onAnnotationClick
}: CodeMirrorEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const lastExternalValue = useRef(value)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onCountRef = useRef(onHighlightCount)
  onCountRef.current = onHighlightCount
  const onAnnotationClickRef = useRef(onAnnotationClick)
  onAnnotationClickRef.current = onAnnotationClick

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      dropCursor(),
      markdown({ base: markdownLanguage, addKeymap: true }),
      syntaxHighlighting(highlightStyle),
      baseTheme,
      EditorView.lineWrapping,
      readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
      contentAttributes,
      highlightField,
      annotationField,
      EditorView.domEventHandlers({
        mousedown: (event) => {
          const target = event.target as HTMLElement | null
          const mark = target?.closest?.('.cmAnn')
          const id = mark?.getAttribute('data-ann-id')
          if (!id) return false
          onAnnotationClickRef.current?.(id)
          return true
        }
      }),
      placeholderCompartment.of(placeholderText ? placeholderExtension(placeholderText) : []),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const next = update.state.doc.toString()
        lastExternalValue.current = next
        onChangeRef.current(next)
        // 用户开始改字：装饰层已清零，状态栏的「命中 n 处」同步撤掉
        onCountRef.current?.(update.state.field(highlightField).count)
      }),
      keymap.of([
        {
          key: 'Mod-b',
          run: (view) => {
            runCommandOnView(view, 'bold')
            return true
          }
        },
        {
          key: 'Mod-i',
          run: (view) => {
            runCommandOnView(view, 'italic')
            return true
          }
        },
        {
          key: 'Mod-Shift-8',
          run: (view) => {
            runCommandOnView(view, 'unorderedList')
            return true
          }
        },
        {
          key: 'Mod-Shift-7',
          run: (view) => {
            runCommandOnView(view, 'orderedList')
            return true
          }
        },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab
      ])
    ]

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 编辑器实例只在挂载时创建，后续属性变化用 compartment 重配置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() === value) return
    lastExternalValue.current = value
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: Math.min(value.length, view.state.selection.main.anchor) }
    })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly))
    })
  }, [readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: placeholderCompartment.reconfigure(
        placeholderText ? placeholderExtension(placeholderText) : []
      )
    })
  }, [placeholderText])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: setAnnotationsEffect.of(annotations) })
    // 批注列表变化时只需重算装饰层，不动光标与内容
  }, [annotations])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: setHighlightEffect.of(highlightQuery) })
    const count = view.state.field(highlightField).count
    onCountRef.current?.(count)
    if (count > 0) {
      const first = view.dom.querySelector('.cmHit')
      first?.scrollIntoView({ block: 'center' })
    }
  }, [highlightQuery])

  useImperativeHandle(
    handleRef,
    () => ({
      focus: () => viewRef.current?.focus(),
      insertText: (text: string) => {
        const view = viewRef.current
        if (!view || readOnly) return
        commitEdit(view, insertAtSelection(selectionEdit(view), text))
      },
      runCommand: (command: CommandKind) => {
        const view = viewRef.current
        if (!view || readOnly) return
        runCommandOnView(view, command)
      },
      getSelection: () => {
        const view = viewRef.current
        if (!view) return null
        const selection = view.state.selection.main
        if (selection.empty) return null
        const text = view.state.doc.sliceString(selection.from, selection.to).trim()
        if (!text) return null
        const start = view.coordsAtPos(selection.from)
        const end = view.coordsAtPos(selection.to)
        if (!start || !end) return null
        const rect = new DOMRect(
          Math.min(start.left, end.left),
          Math.min(start.top, end.top),
          Math.abs(end.left - start.left),
          Math.max(18, Math.abs(end.bottom - start.bottom))
        )
        return { text, rect }
      }
    }),
    [readOnly]
  )

  return <div className="cmEditor" ref={hostRef} />
}

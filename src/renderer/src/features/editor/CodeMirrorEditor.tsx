import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as placeholderExtension
} from '@codemirror/view'
import { tags as lezerTags } from '@lezer/highlight'

import { applyCommand, insertAtSelection, type CommandKind } from './markdownCommands'

export interface EditorHandle {
  focus: () => void
  insertText: (text: string) => void
  runCommand: (command: CommandKind) => void
}

interface CodeMirrorEditorProps {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
  spellcheck?: boolean
  placeholderText?: string
  handleRef?: Ref<EditorHandle>
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

const readOnlyCompartment = new Compartment()
const spellcheckCompartment = new Compartment()
const placeholderCompartment = new Compartment()

function contentAttributes(spellcheck: boolean): Extension {
  return EditorView.contentAttributes.of({
    spellcheck: spellcheck ? 'true' : 'false',
    autocorrect: 'off',
    autocapitalize: 'off'
  })
}

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
  spellcheck = true,
  placeholderText = '',
  handleRef
}: CodeMirrorEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const lastExternalValue = useRef(value)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

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
      spellcheckCompartment.of(contentAttributes(spellcheck)),
      placeholderCompartment.of(placeholderText ? placeholderExtension(placeholderText) : []),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const next = update.state.doc.toString()
        lastExternalValue.current = next
        onChangeRef.current(next)
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
      effects: spellcheckCompartment.reconfigure(contentAttributes(spellcheck))
    })
  }, [spellcheck])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: placeholderCompartment.reconfigure(
        placeholderText ? placeholderExtension(placeholderText) : []
      )
    })
  }, [placeholderText])

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
      }
    }),
    [readOnly]
  )

  return <div className="cmEditor" ref={hostRef} />
}

import { create } from 'zustand'

import type {
  Annotation,
  Attachment,
  DiaryEntry,
  EntryDraft,
  LocalDate,
  VaultSnapshot
} from '@shared/types'
import { countEntryWords } from '@shared/words'
import { todayLocalDate } from '@shared/date'

import { call, errorMessage } from '@/api/client'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

const AUTOSAVE_MS = 800

let timer: ReturnType<typeof setTimeout> | null = null
let draftVersion = 0
let savingPromise: Promise<void> | null = null

function emptyDraft(date: LocalDate): EntryDraft {
  return { date, title: '', body: '', tags: [], attachments: [] }
}

function toDraft(entry: DiaryEntry): EntryDraft {
  return {
    date: entry.date,
    title: entry.title,
    body: entry.body,
    tags: [...entry.tags],
    attachments: [...entry.attachments]
  }
}

function isBlank(draft: EntryDraft): boolean {
  return (
    draft.title.trim().length === 0 &&
    draft.body.trim().length === 0 &&
    draft.tags.length === 0 &&
    draft.attachments.length === 0
  )
}

function sortEntries(entries: DiaryEntry[]): DiaryEntry[] {
  return [...entries].sort((a, b) => (a.date < b.date ? -1 : 1))
}

interface EntriesState {
  entries: DiaryEntry[]
  /** 按日期分组的批注（只增不改） */
  annotations: Record<string, Annotation[]>
  activeDate: LocalDate
  draft: EntryDraft | null
  saveState: SaveState
  savedAt: string | null
  saveError: string | null
  /** 输入框里的原始内容（未提交） */
  searchInput: string
  /** 已提交、用于列表过滤与分析的检索词 */
  searchQuery: string
  /** 本地不存在 .mdat 的附件 id（文本已同步、附件未迁移） */
  missingAttachmentIds: string[]
  activeTag: string | null
  loadSnapshot: (snapshot: VaultSnapshot) => void
  refreshMissingAttachments: () => Promise<void>
  clear: () => void
  openDate: (date: LocalDate) => Promise<void>
  updateDraft: (patch: Partial<Omit<EntryDraft, 'date'>>) => void
  addAttachment: (attachment: Attachment) => void
  removeAttachment: (id: string) => void
  flush: () => Promise<void>
  setSearchInput: (value: string) => void
  commitSearch: (value?: string) => void
  clearSearch: () => void
  setTag: (tag: string | null) => void
  addAnnotation: (input: {
    date: string
    quote: string
    tag: string
    body: string
  }) => Promise<Annotation>
  wordCount: () => number
}

export const useEntriesStore = create<EntriesState>((set, get) => ({
  entries: [],
  annotations: {},
  activeDate: todayLocalDate(),
  draft: null,
  saveState: 'saved',
  savedAt: null,
  saveError: null,
  searchInput: '',
  searchQuery: '',
  missingAttachmentIds: [],
  activeTag: null,

  loadSnapshot: (snapshot) => {
    const entries = sortEntries(snapshot.entries)
    const activeDate = get().activeDate
    const existing = entries.find((entry) => entry.date === activeDate)
    set({
      entries,
      annotations: snapshot.annotations ?? {},
      draft: existing ? toDraft(existing) : emptyDraft(activeDate),
      saveState: 'saved',
      saveError: null
    })
    void get().refreshMissingAttachments()
  },

  refreshMissingAttachments: async () => {
    try {
      const missing = await call('sync:missingAttachments', undefined)
      set({ missingAttachmentIds: missing.map((item) => item.id) })
    } catch {
      // 锁定时没有缺失列表；保持原状
    }
  },

  clear: () =>
    set({
      entries: [],
      annotations: {},
      draft: null,
      saveState: 'saved',
      savedAt: null,
      saveError: null,
      searchInput: '',
      searchQuery: '',
      missingAttachmentIds: [],
      activeTag: null
    }),

  openDate: async (date) => {
    if (date === get().activeDate && get().draft) return
    await get().flush()
    const entry = get().entries.find((item) => item.date === date)
    set({
      activeDate: date,
      draft: entry ? toDraft(entry) : emptyDraft(date),
      saveState: 'saved',
      saveError: null
    })
  },

  updateDraft: (patch) => {
    const current = get().draft
    if (!current) return
    draftVersion += 1
    set({ draft: { ...current, ...patch }, saveState: 'dirty' })
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void get().flush()
    }, AUTOSAVE_MS)
  },

  addAttachment: (attachment) => {
    const current = get().draft
    if (!current) return
    draftVersion += 1
    set({
      draft: { ...current, attachments: [...current.attachments, attachment] },
      saveState: 'dirty'
    })
  },

  removeAttachment: (id) => {
    const current = get().draft
    if (!current) return
    draftVersion += 1
    set({
      draft: {
        ...current,
        attachments: current.attachments.filter((item) => item.id !== id)
      },
      saveState: 'dirty'
    })
  },


  flush: async () => {
    if (savingPromise) {
      await savingPromise
    }
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const state = get()
    if (!state.draft || state.saveState === 'saved') return
    const version = draftVersion
    const draft = state.draft
    set({ saveState: 'saving', saveError: null })

    const run = (async () => {
      try {
        const result = await call('entry:save', { entry: draft })
        const entries = [...get().entries]
        const index = entries.findIndex((entry) => entry.date === draft.date)
        if (result.entry) {
          if (index === -1) entries.push(result.entry)
          else entries[index] = result.entry
        } else if (index !== -1) {
          entries.splice(index, 1)
        }
        const changed = draftVersion !== version
        set({
          entries: sortEntries(entries),
          saveState: changed ? 'dirty' : 'saved',
          savedAt: result.savedAt,
          saveError: null
        })
        if (changed) {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            void get().flush()
          }, AUTOSAVE_MS)
        }
      } catch (error) {
        set({ saveState: 'error', saveError: errorMessage(error) })
        throw error
      }
    })()

    savingPromise = run.finally(() => {
      savingPromise = null
    })
    try {
      await savingPromise
    } catch {
      // 错误已经写进 store，交给界面提示
    }
  },

  addAnnotation: async ({ date, quote, tag, body }) => {
    const result = await call('annotation:add', { date, quote, tag, body })
    set({
      annotations: {
        ...get().annotations,
        [date]: result.annotations
      }
    })
    return result.annotation
  },

  setSearchInput: (searchInput) => set({ searchInput }),
  // 提交就是"检索"：输入框内容与检索词对齐，列表与分析同时更新
  commitSearch: (value) => {
    const searchInput = value ?? get().searchInput
    set({ searchInput, searchQuery: searchInput.trim() })
  },
  clearSearch: () => set({ searchInput: '', searchQuery: '' }),
  setTag: (activeTag) => set({ activeTag }),

  wordCount: () => {
    const draft = get().draft
    if (!draft) return 0
    return countEntryWords(draft.title, draft.body)
  }
}))

/** 卸载/锁定时清掉未触发的自动保存（内容已在 store 里） */
export function cancelPendingSave(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

export { isBlank }

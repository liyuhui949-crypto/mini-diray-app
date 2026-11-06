import { create } from 'zustand'

import type { Attachment, DiaryEntry, EntryDraft, LocalDate, VaultSnapshot } from '@shared/types'
import { countEntryWords } from '@shared/words'
import { todayLocalDate } from '@shared/date'

import { call, errorMessage } from '@/api/client'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

const AUTOSAVE_MS = 800

let timer: ReturnType<typeof setTimeout> | null = null
let draftVersion = 0
let savingPromise: Promise<void> | null = null

export function emptyDraft(date: LocalDate): EntryDraft {
  return { date, title: '', body: '', tags: [], attachments: [] }
}

export function toDraft(entry: DiaryEntry): EntryDraft {
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
  activeDate: LocalDate
  draft: EntryDraft | null
  saveState: SaveState
  savedAt: string | null
  saveError: string | null
  searchQuery: string
  activeTag: string | null
  loadSnapshot: (snapshot: VaultSnapshot) => void
  clear: () => void
  openDate: (date: LocalDate) => Promise<void>
  updateDraft: (patch: Partial<Omit<EntryDraft, 'date'>>) => void
  addAttachment: (attachment: Attachment) => void
  removeAttachment: (id: string) => void
  replaceDraft: (draft: EntryDraft) => void
  flush: () => Promise<void>
  setQuery: (query: string) => void
  setTag: (tag: string | null) => void
  deleteActive: () => Promise<void>
  wordCount: () => number
}

export const useEntriesStore = create<EntriesState>((set, get) => ({
  entries: [],
  activeDate: todayLocalDate(),
  draft: null,
  saveState: 'saved',
  savedAt: null,
  saveError: null,
  searchQuery: '',
  activeTag: null,

  loadSnapshot: (snapshot) => {
    const entries = sortEntries(snapshot.entries)
    const activeDate = get().activeDate
    const existing = entries.find((entry) => entry.date === activeDate)
    set({
      entries,
      draft: existing ? toDraft(existing) : emptyDraft(activeDate),
      saveState: 'saved',
      saveError: null
    })
  },

  clear: () =>
    set({
      entries: [],
      draft: null,
      saveState: 'saved',
      savedAt: null,
      saveError: null,
      searchQuery: '',
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

  replaceDraft: (draft) => {
    draftVersion += 1
    set({ draft, saveState: 'dirty' })
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

  setQuery: (searchQuery) => set({ searchQuery }),
  setTag: (activeTag) => set({ activeTag }),

  deleteActive: async () => {
    const { activeDate } = get()
    const result = await call('entry:delete', { date: activeDate })
    set({
      entries: get().entries.filter((entry) => entry.date !== activeDate),
      draft: emptyDraft(activeDate),
      saveState: 'saved',
      savedAt: null,
      saveError: null
    })
    void result
  },

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

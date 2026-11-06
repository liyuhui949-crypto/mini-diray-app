import { create } from 'zustand'

import type { Preferences } from '@shared/types'

import { call } from '@/api/client'

type ResolvedTheme = 'light' | 'dark'

interface PrefsState {
  prefs: Preferences | null
  theme: ResolvedTheme
  setPrefs: (prefs: Preferences) => void
  setTheme: (theme: ResolvedTheme) => void
  update: (patch: Partial<Preferences>) => Promise<void>
}

function resolveTheme(prefs: Preferences): ResolvedTheme {
  if (prefs.theme === 'system') {
    const dark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    return dark ? 'dark' : 'light'
  }
  return prefs.theme
}

export const usePrefsStore = create<PrefsState>((set, get) => ({
  prefs: null,
  theme: 'light',
  setPrefs: (prefs) => set({ prefs, theme: resolveTheme(prefs) }),
  setTheme: (theme) => set({ theme }),
  update: async (patch) => {
    const next = await call('prefs:update', patch)
    set({ prefs: next, theme: resolveTheme(next) })
    void get()
  }
}))

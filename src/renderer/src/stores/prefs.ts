import { create } from 'zustand'

import type { Preferences } from '@shared/types'


import { call } from '@/api/client'

type ResolvedTheme = 'light' | 'dark'

interface PrefsState {
  prefs: Preferences | null
  theme: ResolvedTheme
  /** 应用版本（来自主进程 app.getVersion，即 package.json） */
  appVersion: string
  setPrefs: (prefs: Preferences) => void
  setAppVersion: (version: string) => void
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
  appVersion: '',
  setPrefs: (prefs) => set({ prefs, theme: resolveTheme(prefs) }),
  setTheme: (theme) => set({ theme }),
  setAppVersion: (appVersion) => set({ appVersion }),
  update: async (patch) => {
    const next = await call('prefs:update', patch)
    set({ prefs: next, theme: resolveTheme(next) })
    void get()
  }
}))

/** 布局相关的偏好子集：列宽与折叠状态 */
export type LayoutPatch = Partial<
  Pick<Preferences, 'sidebarCollapsed' | 'listWidth' | 'annotationCollapsed'>
>

/** 统一入口：拖拽/折叠后落盘，失败不影响界面（只在控制台留痕） */
export function persistLayout(patch: LayoutPatch): void {
  void usePrefsStore
    .getState()
    .update(patch)
    .catch(() => undefined)
}

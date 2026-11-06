import { create } from 'zustand'

export type ViewName = 'editor' | 'stats' | 'settings'

export type DialogName =
  | 'changePassword'
  | 'resetVault'
  | 'deleteVault'
  | 'migrationExport'
  | 'migrationImport'
  | 'import'
  | 'export'
  | 'cleanup'
  | 'legacyImport'
  | null

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  id: string
  message: string
  action?: ToastAction
  tone: 'default' | 'error'
}

let toastSeq = 0

interface UiState {
  view: ViewName
  dialog: DialogName
  sidebarCollapsed: boolean
  listCollapsed: boolean
  lightboxId: string | null
  toasts: ToastItem[]
  focusSearchSeq: number
  attachmentRequestSeq: number
  pendingPackagePath: string | null
  setView: (view: ViewName) => void
  openDialog: (dialog: Exclude<DialogName, null>) => void
  closeDialog: () => void
  toggleSidebar: () => void
  toggleList: () => void
  openLightbox: (id: string) => void
  closeLightbox: () => void
  pushToast: (message: string, options?: { action?: ToastAction; tone?: ToastItem['tone'] }) => void
  dismissToast: (id: string) => void
  requestFocusSearch: () => void
  requestAttachment: () => void
  setPendingPackage: (path: string | null) => void
}

export const useUiStore = create<UiState>((set, get) => ({
  view: 'editor',
  dialog: null,
  sidebarCollapsed: false,
  listCollapsed: false,
  lightboxId: null,
  toasts: [],
  focusSearchSeq: 0,
  attachmentRequestSeq: 0,
  pendingPackagePath: null,
  setView: (view) => set({ view, dialog: null }),
  requestFocusSearch: () => set({ focusSearchSeq: get().focusSearchSeq + 1 }),
  requestAttachment: () => set({ attachmentRequestSeq: get().attachmentRequestSeq + 1 }),
  setPendingPackage: (pendingPackagePath) => set({ pendingPackagePath }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
  toggleList: () => set({ listCollapsed: !get().listCollapsed }),
  openLightbox: (id) => set({ lightboxId: id }),
  closeLightbox: () => set({ lightboxId: null }),
  pushToast: (message, options = {}) => {
    toastSeq += 1
    const id = `toast-${toastSeq}`
    set({
      toasts: [...get().toasts, { id, message, tone: options.tone ?? 'default', action: options.action }]
    })
    window.setTimeout(
      () => {
        set({ toasts: get().toasts.filter((toast) => toast.id !== id) })
      },
      options.action ? 6000 : 3200
    )
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) })
}))

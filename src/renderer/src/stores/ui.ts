import { todayLocalDate } from '@shared/date'
import type { LocalDate, OrphanAttachment, Preferences } from '@shared/types'
import { create } from 'zustand'

export type ViewName = 'editor' | 'stats' | 'settings' | 'search' | 'attachments'

/** 「在日记中打开」的一次性请求：跳到某天并把检索词标出来 */
export interface SearchJump {
  date: LocalDate
  query: string
  seq: number
}

/** 条目列表的取数范围：跟随日历月份，或展示全部 */
export type ListScope = 'month' | 'all'

export type DialogName =
  | 'changePassword'
  | 'resetVault'
  | 'migrationExport'
  | 'migrationImport'
  | 'import'
  | 'export'
  | null

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  id: string
  message: string
  action?: ToastAction
  tone: 'default' | 'error' | 'success'
}

let toastSeq = 0

interface UiState {
  view: ViewName
  dialog: DialogName
  sidebarCollapsed: boolean
  /** 条目列表宽度（px） */
  listWidth: number
  annotationCollapsed: boolean
  lightboxId: string | null
  /** 从附件库打开灯箱时记住所属日记，供「查看所属日记」切换 */
  lightboxDate: LocalDate | null
  /** 未引用附件的灯箱上下文（没有 entry 元数据） */
  lightboxOrphan: OrphanAttachment | null
  toasts: ToastItem[]
  /** 编辑器预览模式：跨日记保留，切日期不重置 */
  previewMode: boolean
  /** 日历当前显示月份（每月 1 号） */
  calendarMonth: LocalDate
  listScope: ListScope
  focusSearchSeq: number
  attachmentRequestSeq: number
  pendingPackagePath: string | null
  /** 搜索结果里点开的预览对话框（列表与洞察共用） */
  searchPreviewDate: LocalDate | null
  /** 附件库里点开的「所属日记」预览 */
  attachmentPreviewDate: LocalDate | null
  /** 附件库预览日记时记住是哪张附件，供「预览附件」切回 */
  attachmentPreviewAttachmentId: string | null
  searchJump: SearchJump | null
  setView: (view: ViewName) => void
  openSearchPreview: (date: LocalDate) => void
  closeSearchPreview: () => void
  openAttachmentPreview: (date: LocalDate, attachmentId?: string | null) => void
  closeAttachmentPreview: () => void
  requestSearchJump: (date: LocalDate, query: string) => void
  setPreviewMode: (preview: boolean) => void
  setCalendarMonth: (month: LocalDate) => void
  setListScope: (scope: ListScope) => void
  openDialog: (dialog: Exclude<DialogName, null>) => void
  closeDialog: () => void
  toggleSidebar: () => void
  setListWidth: (width: number) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setAnnotationCollapsed: (collapsed: boolean) => void
  hydrateLayout: (prefs: Preferences) => void
  openLightbox: (id: string) => void
  openAttachmentLightbox: (id: string, date: LocalDate) => void
  openOrphanLightbox: (orphan: OrphanAttachment) => void
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
  listWidth: 312,
  annotationCollapsed: false,
  lightboxId: null,
  lightboxDate: null,
  lightboxOrphan: null,
  toasts: [],
  previewMode: false,
  calendarMonth: todayLocalDate(),
  listScope: 'month',
  focusSearchSeq: 0,
  attachmentRequestSeq: 0,
  pendingPackagePath: null,
  searchPreviewDate: null,
  attachmentPreviewDate: null,
  attachmentPreviewAttachmentId: null,
  searchJump: null,
  setView: (view) => set({ view, dialog: null }),
  openSearchPreview: (searchPreviewDate) => set({ searchPreviewDate }),
  closeSearchPreview: () => set({ searchPreviewDate: null }),
  openAttachmentPreview: (attachmentPreviewDate, attachmentPreviewAttachmentId = null) =>
    set({ attachmentPreviewDate, attachmentPreviewAttachmentId }),
  closeAttachmentPreview: () =>
    set({ attachmentPreviewDate: null, attachmentPreviewAttachmentId: null }),
  requestSearchJump: (date, query) =>
    set((state) => ({
      searchJump: { date, query, seq: (state.searchJump?.seq ?? 0) + 1 }
    })),
  setPreviewMode: (previewMode) => set({ previewMode }),
  setCalendarMonth: (calendarMonth) => set({ calendarMonth }),
  setListScope: (listScope) => set({ listScope }),
  requestFocusSearch: () => set({ focusSearchSeq: get().focusSearchSeq + 1 }),
  requestAttachment: () => set({ attachmentRequestSeq: get().attachmentRequestSeq + 1 }),
  setPendingPackage: (pendingPackagePath) => set({ pendingPackagePath }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
  setListWidth: (listWidth) => set({ listWidth }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setAnnotationCollapsed: (annotationCollapsed) => set({ annotationCollapsed }),
  hydrateLayout: (prefs) =>
    set({
      listWidth: prefs.listWidth ?? 312,
      sidebarCollapsed: prefs.sidebarCollapsed ?? false,
      annotationCollapsed: prefs.annotationCollapsed ?? false
    }),
  openLightbox: (id) => set({ lightboxId: id, lightboxDate: null, lightboxOrphan: null }),
  openAttachmentLightbox: (lightboxId, lightboxDate) =>
    set({ lightboxId, lightboxDate, lightboxOrphan: null }),
  openOrphanLightbox: (lightboxOrphan) =>
    set({ lightboxId: lightboxOrphan.id, lightboxDate: null, lightboxOrphan }),
  closeLightbox: () => set({ lightboxId: null, lightboxDate: null, lightboxOrphan: null }),
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

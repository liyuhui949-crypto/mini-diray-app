import { copy } from '@shared/copy'

import { call, errorMessage } from '@/api/client'
import { useUiStore } from '@/stores/ui'

/**
 * 附件「另存为」：成功提示保存路径，失败给出错误 toast。
 * 灯箱与 Markdown 预览的附件卡片共用这一份实现。
 */
export async function saveAttachmentAs(id: string): Promise<void> {
  const ui = useUiStore.getState()
  try {
    const result = await call('attachment:saveAs', { id })
    if (result.path) ui.pushToast(copy.attachments.savedTo(result.path))
  } catch (error) {
    ui.pushToast(errorMessage(error), { tone: 'error' })
  }
}

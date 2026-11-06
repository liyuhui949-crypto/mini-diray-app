import { session } from 'electron'

import { logger } from './logger'

/** 拼写检查只用于英文单词；中文没有词典，与界面语言无关 */
export function applySpellcheck(enabled: boolean): void {
  const defaultSession = session.defaultSession
  try {
    defaultSession.setSpellCheckerEnabled(enabled)
    defaultSession.setSpellCheckerLanguages(['en-US'])
  } catch (error) {
    logger.warn('spellchecker unavailable')
    void error
  }
}

/** CodeMirror / contenteditable 的右键建议菜单由 Chromium 自己提供，这里只同步开关 */
export function configureSpellcheckSession(): void {
  try {
    session.defaultSession.setSpellCheckerLanguages(['en-US'])
  } catch {
    logger.warn('spellchecker languages unavailable')
  }
}

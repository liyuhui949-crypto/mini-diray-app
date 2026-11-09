import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'

/**
 * 自动化测试的统一入口：
 * - `MINIDIARY_SILENT=1` 让窗口只在后台渲染，不弹出、不抢焦点，不打断正在用电脑的人；
 * - userData 与日记目录都指向临时目录，绝不碰真实数据。
 */
export async function makeHome(prefix = 'minidiary-e2e-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  errors: string[]
}

export async function launchApp(home: string): Promise<LaunchedApp> {
  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MINIDIARY_SILENT: '1',
      MINIDIARY_USER_DATA: path.join(home, 'userdata'),
      // 测试夹具需要写历史日期（产品里历史正文是只读的）
      MINIDIARY_ALLOW_HISTORY_WRITE: '1',
      MINIDIARY_DIARY_DIR: path.join(home, 'diary')
    }
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
  })
  await page.waitForLoadState('domcontentloaded')
  return { app, page, errors }
}

/**
 * React 受控输入在偶发情况下会吞掉最后一个字符（Playwright fill + 重新渲染竞态），
 * 所以填完要回读校验，不一致就重填。
 */
export async function fillInput(locator: Locator, value: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await locator.fill(value)
    if ((await locator.inputValue()) === value) return
  }
  const current = await locator.inputValue()
  throw new Error(`输入框没有填入完整内容：期望 ${value.length} 字符，实际 ${current.length}`)
}

/** 用密码创建日记库，并等三栏界面出现 */
export async function createVault(page: Page, password: string): Promise<void> {
  await fillInput(page.locator('#new-password'), password)
  await fillInput(page.locator('#confirm-password'), password)
  await page.getByRole('button', { name: '创建日记库' }).click()
  await page.getByRole('button', { name: '开始写' }).waitFor({ state: 'visible', timeout: 30_000 })
}

/** 解锁 */
export async function unlockVault(page: Page, password: string): Promise<void> {
  await fillInput(page.locator('#unlock-password'), password)
  await page.getByRole('button', { name: '解锁' }).click()
}

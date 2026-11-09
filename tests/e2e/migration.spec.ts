import { rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { createVault, fillInput, launchApp, makeHome, unlockVault } from './helpers'

/**
 * 一键迁移的完整用户路径：
 * A 机器建库写作 → 导出 .minidiary → B 机器全新安装 → 导入 → 内容与附件回来。
 * 原生保存/打开对话框在主进程里被替换成固定路径。
 */

const PASSWORD = 'source-password-1234'
const PACKAGE_PASSWORD = 'package-password-1234'

let homeA = ''
let homeB = ''
let appA: ElectronApplication | null = null
let appB: ElectronApplication | null = null
let packagePath = ''
let packageKey = ''

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await launchApp(home)
  return { app: launched.app, page: launched.page }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  homeA = await makeHome('minidiary-mig-a-')
  homeB = await makeHome('minidiary-mig-b-')
  packagePath = path.join(homeA, 'bundle.minidiary')
})

test.afterAll(async () => {
  await appA?.close().catch(() => undefined)
  await appB?.close().catch(() => undefined)
  await rm(homeA, { recursive: true, force: true })
  await rm(homeB, { recursive: true, force: true })
})

test('导出迁移包再导入到全新安装', async () => {
  // ── A 机器：建库 + 写一篇 ──────────────────────────────
  {
    const launched = await launch(homeA)
    appA = launched.app
    const page = launched.page
    await createVault(page, PASSWORD)

    await expect(page.getByText('这一天还没有字。')).toBeVisible()
    await page.getByRole('button', { name: '开始写' }).click()
    await fillInput(page.getByLabel('今天发生了什么？'), '雨停之后')
    await page.locator('.cm-content').click()
    await page.keyboard.type('下午四点雨停了。')
    await expect(page.getByText(/已保存/)).toBeVisible({ timeout: 15_000 })

    // 导出迁移包（保存对话框替换成固定路径）
    await appA.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, packagePath)

    await page.getByRole('button', { name: '设置' }).click()
    await page.getByRole('button', { name: '导出…' }).click()
    await fillInput(page.locator('#export-password'), PACKAGE_PASSWORD)
    await page.getByRole('button', { name: '生成公钥' }).click()
    await expect(page.locator('#package-key')).toBeVisible()
    packageKey = (await page.locator('#package-key').textContent())?.trim() ?? ''
    expect(packageKey).toMatch(/^[0-9A-Za-z-]{159}$/)
    // 生成公钥后有 5 秒冷静期，倒计时结束才能导出
    await expect(page.getByRole('button', { name: '开始导出' })).toBeEnabled({ timeout: 15_000 })
    await page.getByRole('button', { name: '开始导出' }).click()
    // 导出完成后对话框切到摘要态：只剩"完成"按钮，并显示包内统计
    await expect(page.getByRole('button', { name: '完成' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/1 篇日记 · 0 个附件/)).toBeVisible()
    await page.getByRole('button', { name: '完成' }).click()

    expect((await stat(packagePath)).size).toBeGreaterThan(0)
    await appA.close()
  }

  // ── B 机器：全新安装，用迁移包恢复 ─────────────────────
  {
    const launched = await launch(homeB)
    appB = launched.app
    const page = launched.page

    await expect(page.locator('#new-password')).toBeVisible()
    await page.getByRole('button', { name: /导入迁移包/ }).click()

    await appB.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
    }, packagePath)

    await page.getByRole('button', { name: '选择文件…' }).first().click()
    await expect(page.locator('#import-package-key')).toBeVisible()
    await fillInput(page.locator('#import-package-key'), packageKey)
    await fillInput(page.locator('#import-password'), PACKAGE_PASSWORD)
    await page.getByRole('button', { name: '下一步' }).click()

    // 导入不需要设置新密码：没有库时，导入后的解锁密码就是迁移包的私钥
    await expect(page.locator('#import-mode')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: '开始导入' }).click()

    await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: '完成' }).click()

    // 导入后的库用新密码解锁，内容回来了
    await expect(page.getByText('雨停之后').first()).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: '锁定' }).click()
    await expect(page.locator('#unlock-password')).toBeVisible()
    await unlockVault(page, PACKAGE_PASSWORD)
    await expect(page.getByText('雨停之后').first()).toBeVisible({ timeout: 30_000 })
  }
})

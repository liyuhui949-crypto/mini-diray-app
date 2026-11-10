import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { createVault, fillInput, launchApp, makeHome, unlockVault } from './helpers'

/**
 * 真实 Electron 端到端：建库 → 写作 → 搜索 → 附件（解密代理）→ 锁定/解锁 → 重启后仍在。
 * 使用独立的 userData 与日记目录，不碰用户真实数据。
 */

// 1×1 透明 PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const PASSWORD = 'e2e-password-1234'

let homeDir = ''
let app: ElectronApplication
let page: Page

async function launch(): Promise<void> {
  const launched = await launchApp(homeDir)
  app = launched.app
  page = launched.page
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  homeDir = await makeHome()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await rm(homeDir, { recursive: true, force: true })
})

test('建库、写作、附件解密、搜索、锁定与重启保持', async () => {
  await launch()

  // 1. 引导页建库
  await expect(page.locator('#new-password')).toBeVisible()
  await createVault(page, PASSWORD)

  // 2. 写一篇
  await expect(page.getByText('这一天还没有字。')).toBeVisible()
  await page.getByRole('button', { name: '开始写' }).click()
  await fillInput(page.getByLabel('今天发生了什么？'), '雨停之后')
  await page.locator('.cm-content').click()
  await page.keyboard.type('下午四点雨停了。')
  await page.keyboard.type('\n\n这几天一直在想**专注**这件事。')
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const snapshot = await window.miniDiary.invoke('vault:snapshot', undefined)
          if (!snapshot.ok) return ''
          return snapshot.data.entries.map((entry) => entry.body).join('|')
        }),
      { timeout: 20_000 }
    )
    .toContain('专注')

  // 3. 搜索
  await page.getByLabel('搜索标题和正文').fill('专注')
  await expect(page.getByText('搜索结果')).toBeVisible()
  await page.getByLabel('搜索标题和正文').fill('')
  // 列表默认跟随日历月份，清空搜索后回到当月视图
  await expect(page.getByRole('heading', { name: '2026年11月' })).toBeVisible()

  // 4. 附件：把文件选择框替换成固定路径，走真实的流式加密写入
  const pngPath = path.join(homeDir, 'test.png')
  await writeFile(pngPath, Buffer.from(PNG_BASE64, 'base64'))
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, pngPath)

  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+End')
  await page.getByRole('article').getByRole('button', { name: '附件' }).click()

  // 等附件真正写进库（自动保存是 800ms 防抖，不能只看“已保存”文案）
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const snapshot = await window.miniDiary.invoke('vault:snapshot', undefined)
          if (!snapshot.ok) return ''
          const entry = snapshot.data.entries.find((item) => item.attachments.length > 0)
          return entry?.attachments[0]?.id ?? ''
        }),
      { timeout: 30_000 }
    )
    .toMatch(/^[0-9a-f-]{36}$/)

  const attachmentId = await page.evaluate(async () => {
    const snapshot = await window.miniDiary.invoke('vault:snapshot', undefined)
    if (!snapshot.ok) throw new Error('取快照失败')
    const entry = snapshot.data.entries.find((item) => item.attachments.length > 0)
    return entry?.attachments[0]?.id ?? ''
  })

  await page.getByRole('button', { name: /预览/ }).click()
  const attachment = { id: attachmentId }

  const image = page.locator(`.mdPreview img[src="attachment://${attachment.id}"]`)
  await expect(image).toBeVisible()
  await expect
    .poll(async () => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
      timeout: 15_000
    })
    .toBeGreaterThan(0)

  // 5. 锁定：内容消失，媒体不再可读
  await page.getByRole('button', { name: '锁定' }).click()
  await expect(page.getByText('已锁定')).toBeVisible()
  await expect(page.getByText('雨停之后')).toHaveCount(0)
  const compact = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getBounds()
  )
  expect(compact?.width).toBeLessThan(700)

  const lockedStatus = await app.evaluate(async ({ net }, id) => {
    const response = await net.fetch(`attachment://${id}`)
    return response.status
  }, attachment.id)
  expect(lockedStatus).toBe(423)

  // 6. 错误密码 → 正确密码
  await unlockVault(page, 'wrong-password')
  await expect(page.getByText('密码错误或文件已损坏')).toBeVisible({ timeout: 15_000 })
  await unlockVault(page, PASSWORD)
  await expect(page.getByText('雨停之后').first()).toBeVisible({ timeout: 30_000 })
  const restored = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getBounds()
  )
  expect(restored?.width).toBeGreaterThan(900)

  // 7. 重启后仍在
  await app.close()
  await launch()
  await expect(page.locator('#unlock-password')).toBeVisible()
  await unlockVault(page, PASSWORD)
  await expect(page.getByText('雨停之后').first()).toBeVisible({ timeout: 30_000 })
})

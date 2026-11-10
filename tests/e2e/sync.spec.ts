import { rm } from 'node:fs/promises'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { createVault, launchApp, makeHome } from './helpers'

const PASSWORD = 'e2e-sync-password-1234'

let homeDir = ''
let app: ElectronApplication
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  homeDir = await makeHome('minidiary-e2e-sync-')
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await rm(homeDir, { recursive: true, force: true })
})

test('同步窗口、两页签与缺失附件状态', async () => {
  const launched = await launchApp(homeDir)
  app = launched.app
  page = launched.page
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await expect(page.locator('#new-password')).toBeVisible()
  await createVault(page, PASSWORD)

  // 历史条目：引用一个不存在的附件（模拟“文本已同步、附件未迁移”）
  await page.evaluate(async () => {
    const missingId = '11111111-1111-4111-8111-111111111111'
    await window.miniDiary.invoke('entry:save', {
      entry: {
        date: '2026-11-01',
        title: '旧日记',
        body: `正文\n\n![白板拍照.jpg](attachment://${missingId})`,
        tags: [],
        attachments: [
          {
            id: missingId,
            name: '白板拍照.jpg',
            mime: 'image/jpeg',
            kind: 'image',
            size: 1_600_000,
            sha256: 'a'.repeat(64),
            chunkSize: 1024 * 1024,
            totalChunks: 2,
            createdAt: new Date().toISOString()
          }
        ]
      }
    })
  })
  await page.reload()
  await page.waitForTimeout(2000)

  await expect(page.getByText('缺 1 附件')).toBeVisible()
  await page.getByText('缺 1 附件').click()
  await expect(page.getByText('附件尚未迁移')).toBeVisible()
  await expect(page.getByText('（1 个未迁移）')).toBeVisible()

  await page.getByRole('button', { name: '同步', exact: true }).click()
  await expect.poll(() => app.windows().filter((item) => item.url().includes('window=sync')).length).toBe(1)
  const sync = app.windows().find((item) => item.url().includes('window=sync'))
  if (!sync) throw new Error('没有打开同步窗口')
  await sync.waitForLoadState('domcontentloaded')
  await expect(sync.getByRole('tab', { name: 'Git 同步' })).toBeVisible()
  await expect(sync.getByText('尚未连接仓库').first()).toBeVisible()

  await sync.getByRole('tab', { name: '数据' }).click()
  await expect(sync.getByText('1 个附件未迁移')).toBeVisible()
  await expect(sync.getByText('仅迁移附件')).toBeVisible()

  await sync.getByRole('button', { name: '清空…' }).click()
  await expect(sync.getByPlaceholder('日记库密码')).toBeVisible()
  await expect(sync.getByPlaceholder('DELETE')).toBeVisible()
  await sync.keyboard.press('Escape')

  expect(errors).toEqual([])
})

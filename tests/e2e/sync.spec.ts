import { mkdir, rm, stat, writeFile } from 'node:fs/promises'

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

test('同步面板、两页签与缺失附件状态', async () => {
  const launched = await launchApp(homeDir)
  app = launched.app
  page = launched.page
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await expect(page.getByRole('button', { name: '创建新的日记库' })).toBeVisible()
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
  await expect(page.getByRole('tab', { name: '数据' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Git 同步' })).toBeVisible()
  await page.getByRole('tab', { name: 'Git 同步' }).click()
  await expect(page.getByText(/没有「备份恢复密钥」/)).toBeVisible()
  await expect(page.getByText('每次推送都会留下一个版本。')).toBeVisible()
  const syncSwitch = page.getByRole('switch')
  await expect(syncSwitch).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByText('同步已关闭').first()).toBeVisible()
  await expect(page.getByText('Git 密钥')).toHaveCount(0)
  await expect(page.getByText('备份恢复密钥', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '导出 .inkkey' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '测试连接' })).toHaveCount(0)

  await syncSwitch.click()
  await expect(syncSwitch).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('尚未连接仓库').first()).toBeVisible()
  await expect(page.getByText('Git 密钥')).toBeVisible()
  await expect(page.getByText('备份恢复密钥', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '导出 .inkkey' })).toBeVisible()
  await expect(page.getByText(/清空或换电脑后/).first()).toBeVisible()
  await syncSwitch.click()
  await expect(syncSwitch).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByText('Git 密钥')).toHaveCount(0)

  await page.getByRole('tab', { name: '数据' }).click()
  await expect(page.getByText('1 个附件未迁移')).toBeVisible()
  await expect(page.getByText('仅迁移附件')).toBeVisible()

  await page.getByRole('button', { name: '导出…' }).first().click()
  await expect(page.getByText(/会包含 Git 同步设置/)).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '导出…' }).nth(1).click()
  await expect(page.locator('#att-export-password')).toBeVisible()
  await expect(page.locator('#att-export-password-confirm')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '导入…' }).click()
  await expect(page.locator('#att-import-key')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '清空…' }).click()
  await expect(page.getByPlaceholder('日记库密码')).toBeVisible()
  await expect(page.getByPlaceholder('我确定清空全部数据')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByText('需要的权限')).toBeVisible()
  await expect(page.getByText('文稿文件夹')).toBeVisible()
  await expect(page.getByText('本地网络', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: '打开文稿设置' })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开本地网络设置' })).toBeVisible()

  // 清空全部数据：应删除日记库、密码、配置和旧同步镜像，回到首次安装的引导页
  const syncDir = `${homeDir}/diary/.sync`
  await mkdir(syncDir, { recursive: true })
  await writeFile(
    `${syncDir}/sync.json`,
    JSON.stringify({ format: 1, vaultId: 'old-vault-id' })
  )
  await page.getByRole('button', { name: '同步', exact: true }).click()
  await page.getByRole('tab', { name: '数据' }).click()
  await page.getByRole('button', { name: '清空…' }).click()
  await page.locator('#reset-password').fill(PASSWORD)
  await page.locator('#reset-delete').fill('我确定清空全部数据')
  await page.getByRole('button', { name: '我确定清空全部数据' }).click()
  await expect(page.getByRole('button', { name: '创建新的日记库' })).toBeVisible({ timeout: 20_000 })
  await expect(stat(syncDir)).rejects.toBeTruthy()

  const bootstrap = await page.evaluate(() => window.miniDiary.invoke('app:bootstrap', undefined))
  if (!bootstrap.ok) throw new Error('bootstrap failed')
  expect(bootstrap.data.vaultStatus).toBe('missing')
  expect(bootstrap.data.prefs.syncEnabled).toBe(false)

  // 重启后仍是首次安装状态，旧密码不能解锁
  await app.close()
  const relaunched = await launchApp(homeDir)
  app = relaunched.app
  page = relaunched.page
  await expect(page.getByRole('button', { name: '创建新的日记库' })).toBeVisible()
  await expect(page.locator('#unlock-password')).toHaveCount(0)

  expect(errors).toEqual([])
})

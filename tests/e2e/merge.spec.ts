import { rm } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { createVault, fillInput, launchApp, makeHome, unlockVault } from './helpers'

/**
 * 合并导入的回归用例：目标库已经有「自己的条目 + 自己的附件」，
 * 导入一个包（同一天的条目也有附件）后，两边的内容与文件都必须还在。
 */

const PASSWORD = 'mine-password-1234'
const PACKAGE_PASSWORD = 'package-password-1234'
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let home = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  home = await makeHome('minidiary-merge-')
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await rm(home, { recursive: true, force: true })
})

test('合并导入不会丢掉原库的条目与附件', async () => {
  const launched = await launchApp(home)
  app = launched.app
  page = launched.page

  await createVault(page, PASSWORD)

  // 目标库里先放一篇「自己的」日记 + 一张自己的图
  const own = await page.evaluate(async (pngBase64) => {
    const binary = atob(pngBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    const attachment = await window.miniDiary.invoke('attachment:addBytes', {
      name: '自己的图.png',
      mime: 'image/png',
      bytes
    })
    if (!attachment.ok) throw new Error('写入附件失败')
    const saved = await window.miniDiary.invoke('entry:save', {
      entry: {
        date: '2026-09-01',
        title: '我自己的日记',
        body: `自己的正文\n\n![自己的图](attachment://${attachment.data.id})`,
        tags: ['本地'],
        attachments: [attachment.data]
      }
    })
    if (!saved.ok) throw new Error('保存条目失败')
    return attachment.data.id
  }, PNG_1X1)
  await page.reload()
  await page.waitForTimeout(1200)

  // 导出一个小包（只含这篇日记），再用 merge 导回来
  const packagePath = path.join(home, 'merge-pack.minidiary')
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, packagePath)
  await page.getByRole('button', { name: '同步', exact: true }).click()
  await page.getByRole('tab', { name: '数据' }).click()
  await page.getByRole('button', { name: '导出…' }).first().click()
  await fillInput(page.locator('#export-password'), PACKAGE_PASSWORD)
  await page.getByRole('button', { name: '生成公钥' }).click()
  await expect(page.locator('#package-key')).toBeVisible()
  const packageKey = (await page.locator('#package-key').textContent())?.trim() ?? ''
  await expect(page.getByRole('button', { name: '开始导出' })).toBeEnabled({ timeout: 15_000 })
  await page.getByRole('button', { name: '开始导出' }).click()
  await expect(page.getByRole('button', { name: '完成' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '完成' }).click()

  // 改一下本地这篇，制造「同一天两边都有内容」的情况
  await page.evaluate(async (id) => {
    await window.miniDiary.invoke('entry:save', {
      entry: {
        date: '2026-09-01',
        title: '我自己的日记（改过）',
        body: `本地改过的正文\n\n![自己的图](attachment://${id})`,
        tags: ['本地', '改过'],
        attachments: await window.miniDiary
          .invoke('vault:snapshot', undefined)
          .then((snapshot) => {
            if (!snapshot.ok) return []
            const entry = snapshot.data.entries.find((item) => item.date === '2026-09-01')
            return entry?.attachments ?? []
          })
      }
    })
  }, own)
  await page.reload()
  await page.waitForTimeout(1200)

  // 走界面做 merge 导入
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, packagePath)
  await page.getByRole('button', { name: '同步', exact: true }).click()
  await page.getByRole('tab', { name: '数据' }).click()
  await page.getByRole('button', { name: '导入…' }).first().click()
  await page.getByRole('button', { name: '选择文件…' }).first().click()
  await fillInput(page.locator('#import-package-key'), packageKey)
  await fillInput(page.locator('#import-password'), PACKAGE_PASSWORD)
  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.locator('#import-mode')).toBeVisible({ timeout: 20_000 })
  await page.selectOption('#import-mode', 'merge')
  // 合并导入不需要新密码：原库密码保持不变
  await page.getByRole('button', { name: '开始导入' }).click()
  await expect(page.getByRole('heading', { name: '导入完成' })).toBeVisible({ timeout: 60_000 })

  // 合并后：同一天的内容拼在一起，两边的附件都还在
  const merged = await page.evaluate(async () => {
    const snapshot = await window.miniDiary.invoke('vault:snapshot', undefined)
    if (!snapshot.ok) return null
    const entry = snapshot.data.entries.find((item) => item.date === '2026-09-01')
    return {
      entries: snapshot.data.entries.length,
      title: entry?.title ?? '',
      body: entry?.body ?? '',
      attachments: entry?.attachments.map((item) => ({ id: item.id, name: item.name })) ?? []
    }
  })
  expect(merged).not.toBeNull()
  expect(merged?.title).toContain('我自己的日记（改过）')
  expect(merged?.title).toContain('|')
  expect(merged?.body).toContain('本地改过的正文')
  expect(merged?.body).toContain('---')
  expect(merged?.attachments).toHaveLength(2)
  expect(merged?.attachments.map((item) => item.name).sort()).toEqual(['自己的图.png', '自己的图.png'].sort())

  // 原来的附件文件仍可解密读取
  await page.getByRole('button', { name: '完成' }).click()
  await page.getByLabel('搜索标题和正文').fill('我自己的')
  await expect(page.getByText('搜索结果')).toBeVisible()
  // 搜索结果先开预览对话框，再决定要不要进编辑器
  await page.getByRole('button', { name: /我自己的日记/ }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '在日记中打开' }).click()
  await page.getByRole('button', { name: /预览/ }).click()
  const images = page.locator('img[src^="attachment://"]')
  await expect(images.first()).toBeVisible()
  const firstImage = images.first()
  await expect
    .poll(async () => firstImage.evaluate((element: HTMLImageElement) => element.naturalWidth), {
      timeout: 20_000
    })
    .toBeGreaterThan(0)

  // 合并导入不改变密码：重新锁定后仍用原来的日记密码解锁
  await page.getByRole('button', { name: '锁定' }).click()
  await expect(page.locator('#unlock-password')).toBeVisible()
  await unlockVault(page, PASSWORD)
  await expect(page.getByText('我自己的日记（改过）').first()).toBeVisible({ timeout: 30_000 })
})

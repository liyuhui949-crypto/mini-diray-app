import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { expect, test } from '@playwright/test'

import { createVault, launchApp, makeHome } from './helpers'

const PASSWORD = 'library-password-1234'
/** 2×2 红色 PNG，足够让 <img> 真正解码成功 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4EWADRAwQCgAnbgVRZO/EWgAAAABJRU5ErkJggg=='

test('附件库：分类计数、图片墙与文件行都能回到所属日记', async () => {
  const home = await makeHome('minidiary-lib-')
  const { app, page, errors } = await launchApp(home)
  try {
    await createVault(page, PASSWORD)
    await page.getByRole('button', { name: '开始写' }).waitFor({ state: 'visible', timeout: 30_000 })

    const today = await page.evaluate(() => {
      const d = new Date()
      const p = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    })

    await page.evaluate(
      async ({ date, png }) => {
        const image = await window.miniDiary.invoke('attachment:addBytes', {
          name: '书桌.png',
          mime: 'image/png',
          bytes: new Uint8Array(png)
        })
        const file = await window.miniDiary.invoke('attachment:addBytes', {
          name: '租房合同.pdf',
          mime: 'application/pdf',
          bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])
        })
        if (!image.ok || !file.ok) throw new Error('附件写入失败')
        await window.miniDiary.invoke('entry:save', {
          entry: {
            date,
            title: '月底整理',
            body: `![书桌](attachment://${image.data.id})\n\n[租房合同](attachment://${file.data.id})`,
            tags: ['日常'],
            attachments: [image.data, file.data]
          }
        })
      },
      { date: today, png: [...Buffer.from(PNG_BASE64, 'base64')] }
    )

    await page.reload()
    await page.getByTestId('entry-list').waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByRole('button', { name: '附件', exact: true }).first().click()

    await expect(page.getByRole('heading', { name: '附件' })).toBeVisible()
    await expect(page.getByRole('tab', { name: /全部/ })).toContainText('2')
    await expect(page.getByRole('tab', { name: /图片/ })).toContainText('1')
    await expect(page.getByRole('tab', { name: /文件/ })).toContainText('1')

    // 图片卡片 → 所属日记预览（脚注标明来自附件库）
    await page.locator('button[class*="card"]').first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/来自附件库 · 这篇共 2 个附件 · 关闭即回/)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '附件' })).toBeVisible()
    await expect(page.getByRole('tab', { name: /全部/ })).toHaveAttribute('aria-selected', 'true')

    // 文件 tab → 行列表带「不可预览」，点击同样进预览
    await page.getByRole('tab', { name: /文件/ }).click()
    const row = page.locator('button[class*="row"]').first()
    await expect(row).toContainText('不可预览')
    await row.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: '在日记中打开' }).click()
    await expect(page.getByTestId('entry-list')).toBeVisible()
    await expect(page.getByRole('heading', { name: '附件' })).toHaveCount(0)

    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('附件库空态给出引导', async () => {
  const home = await makeHome('minidiary-lib-empty-')
  const { app, page, errors } = await launchApp(home)
  try {
    await createVault(page, PASSWORD)
    await page.getByRole('button', { name: '开始写' }).waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByRole('button', { name: '附件', exact: true }).first().click()
    await expect(page.getByText('这一类还没有附件')).toBeVisible()
    await expect(page.getByRole('button', { name: '写今天的日记' })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('附件库：预览模式可切换并持久化，预览内也能互切', async () => {
  const home = await makeHome('minidiary-lib-mode-')
  const { app, page, errors } = await launchApp(home)
  try {
    await createVault(page, PASSWORD)
    await page.getByRole('button', { name: '开始写' }).waitFor({ state: 'visible', timeout: 30_000 })

    const today = await page.evaluate(() => {
      const d = new Date()
      const p = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    })

    await page.evaluate(
      async ({ date, png }) => {
        const image = await window.miniDiary.invoke('attachment:addBytes', {
          name: '书桌.png',
          mime: 'image/png',
          bytes: new Uint8Array(png)
        })
        if (!image.ok) throw new Error('附件写入失败')
        await window.miniDiary.invoke('entry:save', {
          entry: {
            date,
            title: '月底整理',
            body: `![书桌](attachment://${image.data.id})`,
            tags: [],
            attachments: [image.data]
          }
        })
      },
      { date: today, png: [...Buffer.from(PNG_BASE64, 'base64')] }
    )

    await page.reload()
    await page.getByTestId('entry-list').waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByRole('button', { name: '附件', exact: true }).first().click()

    // 默认「预览日记」：点卡片进日记预览，预览里可切到附件
    await expect(page.getByRole('button', { name: '预览日记' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.locator('button[class*="card"]').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: '预览附件' }).click()
    await expect(page.getByRole('dialog').getByText('书桌.png')).toBeVisible()
    await page.getByRole('button', { name: '查看所属日记' }).click()
    await expect(page.getByRole('dialog').getByText('月底整理')).toBeVisible()
    await page.keyboard.press('Escape')

    // 外层切到「预览附件」并落盘
    await page.getByRole('button', { name: '预览附件' }).click()
    await expect(page.getByRole('button', { name: '预览附件' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const prefs = JSON.parse(
      await readFile(path.join(home, 'userdata', 'preferences.json'), 'utf8')
    ) as { attachmentPreviewMode?: string }
    expect(prefs.attachmentPreviewMode).toBe('attachment')

    // 再点卡片：直接进附件灯箱（有「查看所属日记」可切回）
    await page.locator('button[class*="card"]').first().click()
    await expect(page.getByRole('button', { name: '查看所属日记' })).toBeVisible()
    await expect(page.getByRole('dialog').getByText('另存为…')).toBeVisible()
    await page.keyboard.press('Escape')

    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('附件库：未引用附件可查看并清理，设置里不再有清理入口', async () => {
  const home = await makeHome('minidiary-lib-orphan-')
  const { app, page, errors } = await launchApp(home)
  try {
    await createVault(page, PASSWORD)
    await page.getByRole('button', { name: '开始写' }).waitFor({ state: 'visible', timeout: 30_000 })

    await page.evaluate(
      async (png) => {
        await window.miniDiary.invoke('attachment:addBytes', {
          name: '遗留.png',
          mime: 'image/png',
          bytes: new Uint8Array(png)
        })
      },
      [...Buffer.from(PNG_BASE64, 'base64')]
    )

    await page.reload()
    await page.getByTestId('entry-list').waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByRole('button', { name: '附件', exact: true }).first().click()
    await page.getByRole('tab', { name: /未引用/ }).click()
    await expect(page.locator('[data-orphan]')).toHaveCount(1)
    await expect(page.getByText(/未引用附件 · /)).toBeVisible()
    await expect(page.locator('[data-orphan]')).toContainText('图片')

    // 可预览的未引用附件也能进灯箱（attachment:// 对孤儿同样可用）
    await page.locator('[data-orphan]').click()
    await expect(page.getByRole('dialog').locator('img')).toHaveCount(1)
    await expect(page.getByRole('dialog').locator('img')).toHaveAttribute(
      'src',
      /^attachment:\/\//
    )
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '清理未引用附件' }).click()
    await expect(page.getByRole('dialog').getByText(/找到 1 个未引用附件/)).toBeVisible()
    await page.getByRole('button', { name: /确认删除/ }).click()
    await expect(page.locator('[data-orphan]')).toHaveCount(0)
    await expect(page.getByText('没有未引用的附件')).toBeVisible()

    // 设置里不再有「清理未引用附件」
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByText('清理未引用附件')).toHaveCount(0)

    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(home, { recursive: true, force: true })
  }
})

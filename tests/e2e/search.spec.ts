import { rm } from 'node:fs/promises'

import { expect, test } from '@playwright/test'

import { createVault, fillInput, launchApp, makeHome } from './helpers'

const PASSWORD = 'search-password-1234'

const ENTRIES = [
  { date: '2026-11-04', title: '', body: '感冒了，头也疼。' },
  { date: '2026-11-05', title: '第三天', body: '感冒第三天，快好了。' },
  { date: '2026-09-10', title: '', body: '秋天也感冒了一次。' }
]

test('检索洞察：概览、时间线、分组证据与预览不打断检索', async () => {
  const home = await makeHome('minidiary-search-')
  const { app, page, errors } = await launchApp(home)
  try {
    await createVault(page, PASSWORD)

    // 直接走 IPC 写入三条日记，省去逐条输入的时间
    for (const entry of ENTRIES) {
      const saved = await page.evaluate(async (draft) => {
        return window.miniDiary.invoke('entry:save', {
          entry: { ...draft, tags: [], attachments: [] }
        })
      }, entry)
      expect(saved.ok).toBe(true)
    }
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('button', { name: '开始写' }).waitFor({ state: 'visible', timeout: 30_000 })

    // 1. 输入后 320ms 自动检索，主区切成检索洞察
    await fillInput(page.getByLabel('搜索标题和正文'), '感冒')
    await expect(page.getByTestId('search-hero')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('search-hit-count')).toHaveText(/^3\s*篇$/)

    // 2. 概览头：单指标 + 日期范围 + 跨年信息
    await expect(page.getByText('2026年9月10日 — 2026年11月5日')).toBeVisible()
    await expect(page.getByText(/跨 1 个年份/)).toBeVisible()

    // 3. 时间线柱状：9 月、11 月有柱，中间月份保留空柱位
    await expect(page.getByTestId('search-bars')).toBeVisible()
    await expect(page.getByTestId('search-bar-2026-09')).toBeVisible()
    await expect(page.getByTestId('search-bar-2026-11')).toBeVisible()

    // 4. 证据按年份分组
    await expect(page.getByText('2026 年 · 3 篇')).toBeVisible()

    // 4.5 点某月的柱子：日历切到该月，证据聚焦该月、其余月份淡出
    await page.getByTestId('search-bar-2026-09').click()
    await expect(page.getByText('2026年9月').first()).toBeVisible()
    await expect(page.getByTestId('search-row-2026-09-10')).not.toHaveAttribute(
      'data-dimmed',
      'true'
    )
    await expect(page.getByTestId('search-row-2026-11-05')).toHaveAttribute(
      'data-dimmed',
      'true'
    )
    await page.getByTestId('search-bar-2026-09').click()

    // 4.6 中间列表的结果也是"预览"，不会直接把编辑器切走
    await page.getByTestId('entry-list').getByRole('button', { name: /11月5日/ }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByTestId('search-hero')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()

    // 5. 点证据行 → 预览对话框，检索结果原地保留
    await page.getByTestId('search-row-2026-11-05').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('heading', { name: '第三天' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByTestId('search-hero')).toBeVisible()

    // 6. 在日记中打开：跳到该天并高亮命中词，状态栏显示命中次数
    await page.getByTestId('search-row-2026-11-04').click()
    await page.getByRole('button', { name: '在日记中打开' }).click()
    await expect(page.locator('.cm-content')).toBeVisible()
    await expect(page.locator('.cmHit').first()).toBeVisible()
    await expect(page.getByText(/命中 \d+ 处/)).toBeVisible()

    // 7. 历史日记是只读的：跳过来仍然只有只读态，正文不可编辑
    await expect(page.getByText('历史日记 · 只读')).toBeVisible()
    await expect(page.locator('.cm-content')).toHaveAttribute('aria-readonly', 'true')

    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(home, { recursive: true, force: true })
  }
})

import { rm } from 'node:fs/promises'

import { expect, test } from '@playwright/test'

import { createVault, launchApp, makeHome } from './helpers'

const PASSWORD = 'annotation-password-1234'

test('批注：历史只读、锚点、空日期整篇批注与日历红点', async () => {
  const home = await makeHome('minidiary-ann-')
  const { app, page, errors } = await launchApp(home)
  try {
    await createVault(page, PASSWORD)

    // 测试通道允许写历史（产品里历史正文只读）
    const saved = await page.evaluate(async () =>
      window.miniDiary.invoke('entry:save', {
        entry: {
          date: '2026-11-04',
          title: '加班那天',
          body: '今天加班到九点，买了个烤红薯。\n\n老板说今年冷得早。',
          tags: ['工作'],
          attachments: []
        }
      })
    )
    expect(saved.ok).toBe(true)

    await page.reload()
    await page.getByRole('button', { name: '开始写' }).waitFor({ state: 'visible', timeout: 30_000 })

    // 打开历史日记：只读 + 批注栏
    await page.getByTestId('entry-list').getByRole('button', { name: /11月4日/ }).click()
    await expect(page.getByText('历史日记 · 只读')).toBeVisible()
    await expect(page.getByText('只读 · 批注 0 条')).toBeVisible()
    await expect(page.getByText('还没有批注')).toBeVisible()

    // 选中正文一句话 → 浮条 → 内联编辑区
    await page.locator('.cm-content').click()
    await page.keyboard.press('Meta+Home')
    await page.keyboard.press('Shift+End')
    await expect(page.locator('[data-sel-bar]')).toBeVisible()
    await page.locator('[data-sel-bar]').getByRole('button', { name: '加批注' }).click()
    await expect(page.locator('#annotation-tag')).toBeVisible()
    await expect(page.getByText('「今天加班到九点，买了个烤红薯。」')).toBeVisible()
    await page.fill('#annotation-tag', '#时间有误')
    await page.fill('#annotation-body', '其实是九点半，手机日历显示 21:30 才离开公司。')
    await page.getByRole('button', { name: '保存批注' }).click()

    // 卡片 + 正文锚点 + 状态栏
    await expect(page.locator('[data-annotation-card]')).toHaveCount(1)
    await expect(page.locator('.cmAnn')).toHaveCount(1)
    await expect(page.getByText('只读 · 批注 1 条')).toBeVisible()
    await expect(page.getByText('时间有误')).toBeVisible()

    // 点卡片 → 正文锚点定位（不抛错即可），点锚点 → 卡片高亮
    await page.locator('[data-annotation-card]').click()
    await page.locator('.cmAnn').click()

    // 批注栏可以收起/展开：收起后右侧留一个"展开批注栏"的药丸
    await page.getByRole('button', { name: '收起批注栏' }).click()
    await expect(page.locator('[data-annotation-card]')).toHaveCount(0)
    await page.getByRole('button', { name: '展开批注栏' }).click()
    await expect(page.locator('[data-annotation-card]')).toHaveCount(1)


    // 空的历史日期：封存 + 整篇批注 + 日历红点
    await page.locator('[data-date="2026-11-02"]').click()
    await expect(page.getByText('已封存 · 不可新增正文')).toBeVisible()
    await page.getByRole('button', { name: '给这一天加批注' }).click()
    await expect(page.getByText('整篇批注 · 这一天没有正文可引用')).toBeVisible()
    await page.fill('#annotation-body', '那天在搬家，收完最后一箱已经十一点。')
    await page.getByRole('button', { name: '保存批注' }).click()
    await expect(page.getByText('只读 · 无正文 · 批注 1 条')).toBeVisible()
    await expect(page.locator('[data-annotation-card]')).toHaveCount(1)
    await expect(page.locator('[data-date="2026-11-02"]')).toHaveClass(/hasAnnotation/)

    // 今天仍然可写：标题输入框不是只读
    await page.getByRole('button', { name: '回到今天' }).click()
    await expect(page.getByRole('button', { name: '开始写' })).toBeVisible()

    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(home, { recursive: true, force: true })
  }
})

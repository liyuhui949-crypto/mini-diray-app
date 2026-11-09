import { rm } from 'node:fs/promises'

import { expect, test } from '@playwright/test'

import { createVault, launchApp, makeHome } from './helpers'

const PASSWORD = 'layout-password-1234'

test('条目列表宽度可拖拽，并且重启后保持', async () => {
  const home = await makeHome('minidiary-layout-')
  const { app, page, errors } = await launchApp(home)
  try {
    await createVault(page, PASSWORD)
    await page.getByRole('button', { name: '开始写' }).waitFor({ state: 'visible', timeout: 30_000 })

    const listWidth = (): Promise<number> =>
      page.evaluate(
        () => document.querySelector('[data-testid="entry-list"]')?.getBoundingClientRect().width ?? 0
      )

    expect(await listWidth()).toBeCloseTo(312, 0)

    const handle = page.getByRole('separator', { name: '调整列表宽度' })
    const box = await handle.boundingBox()
    expect(box).not.toBeNull()
    if (!box) throw new Error('列表拖拽手柄不存在')

    await page.mouse.move(box.x + 3, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + 3 + 64, box.y + 200, { steps: 8 })
    await page.mouse.up()
    await expect.poll(listWidth).toBeGreaterThan(360)

    const resized = await listWidth()
    await page.reload()
    await page.getByTestId('entry-list').waitFor({ state: 'visible', timeout: 30_000 })
    expect(Math.abs((await listWidth()) - resized)).toBeLessThanOrEqual(2)

    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(home, { recursive: true, force: true })
  }
})

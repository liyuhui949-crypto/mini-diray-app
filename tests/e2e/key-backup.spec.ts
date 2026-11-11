import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { createVault, fillInput, launchApp, unlockVault } from './helpers'

const PASSWORD = 'key-backup-diary-1234'
const BACKUP_PASSWORD = 'key-backup-password-1234'

let homeDir = ''
let app: ElectronApplication
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'minidiary-e2e-key-'))
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await rm(homeDir, { recursive: true, force: true })
})

test('导出 .inkkey，清空后用备份密钥恢复同一个日记库', async () => {
  const launched = await launchApp(homeDir)
  app = launched.app
  page = launched.page

  await expect(page.getByRole('button', { name: '创建新的日记库' })).toBeVisible()
  await createVault(page, PASSWORD)
  const before = await page.evaluate(() => window.miniDiary.invoke('vault:snapshot', undefined))
  if (!before.ok) throw new Error('snapshot failed')
  const vaultId = before.data.vaultId

  const backupPath = path.join(homeDir, 'recovery.inkkey')
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, backupPath)

  await page.getByRole('button', { name: '同步', exact: true }).click()
  await page.getByRole('tab', { name: 'Git 同步' }).click()
  const syncSwitch = page.getByRole('switch')
  await syncSwitch.click()
  await expect(syncSwitch).toHaveAttribute('aria-checked', 'true')
  const configured = await page.evaluate(() =>
    window.miniDiary.invoke('sync:configure', {
      repo: 'https://github.com/example/diary.git',
      branch: 'main'
    })
  )
  if (!configured.ok) throw new Error(`configure failed: ${configured.error.message}`)
  await expect(page.getByRole('button', { name: '导出 .inkkey' })).toBeVisible()
  await page.getByRole('button', { name: '导出 .inkkey' }).click()
  await fillInput(page.locator('#key-backup-password'), BACKUP_PASSWORD)
  await fillInput(page.locator('#key-backup-confirm'), BACKUP_PASSWORD)
  await page.getByRole('dialog').getByRole('button', { name: '导出 .inkkey' }).click()
  await expect(page.getByText('恢复密钥已导出')).toBeVisible({ timeout: 15_000 })
  expect((await stat(backupPath)).size).toBeGreaterThan(0)
  expect(await readFile(backupPath, 'utf8')).not.toContain(PASSWORD)

  // 模拟清空：关闭后删除日记库和偏好，保留用户自己保存的 .inkkey
  await app.close()
  await rm(path.join(homeDir, 'diary'), { recursive: true, force: true })
  await rm(path.join(homeDir, 'userdata', 'preferences.json'), { force: true })

  const relaunched = await launchApp(homeDir)
  app = relaunched.app
  page = relaunched.page
  await expect(page.getByRole('button', { name: '创建新的日记库' })).toBeVisible()

  await page.getByRole('button', { name: '从 Git 同步' }).click()
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, backupPath)
  await page.getByRole('button', { name: '选择 .inkkey…' }).click()
  await fillInput(page.locator('#key-restore-backup-password'), BACKUP_PASSWORD)
  await page.getByRole('button', { name: '恢复并创建空日记库' }).click()
  await expect(page.getByRole('tab', { name: 'Git 同步' })).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 20_000 }
  )

  const after = await page.evaluate(() => window.miniDiary.invoke('vault:snapshot', undefined))
  if (!after.ok) throw new Error('snapshot failed after restore')
  expect(after.data.vaultId).toBe(vaultId)
  expect(after.data.entries).toHaveLength(0)
  const restoredPrefs = await page.evaluate(() => window.miniDiary.invoke('prefs:read', undefined))
  if (!restoredPrefs.ok) throw new Error('prefs failed')
  expect(restoredPrefs.data.syncRepo).toBe('https://github.com/example/diary.git')
  expect(restoredPrefs.data.syncBranch).toBe('main')

  // 恢复后日记密码就是备份密码
  await page.getByRole('button', { name: '锁定' }).click()
  await unlockVault(page, BACKUP_PASSWORD)
  await expect(page.getByRole('button', { name: '开始写' })).toBeVisible({ timeout: 20_000 })
})

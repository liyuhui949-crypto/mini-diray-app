// 开发期冒烟脚本：用真实 Electron 打开应用、走一遍建库/写作/统计/设置，并截图。
// 用法：node scripts/smoke.mjs
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const shots = process.env.SMOKE_SHOTS ?? path.join(process.cwd(), 'tmp-shots')
const home = await mkdtemp(path.join(tmpdir(), 'minidiary-smoke-'))

const app = await electron.launch({
  args: ['.'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    NODE_ENV: 'production',
    MINIDIARY_USER_DATA: path.join(home, 'userdata'),
    MINIDIARY_DIARY_DIR: path.join(home, 'diary')
  }
})

const page = await app.firstWindow()
page.on('console', (message) => console.log('[renderer]', message.type(), message.text()))
page.on('pageerror', (error) => console.log('[pageerror]', error.message))

await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(800)
await page.screenshot({ path: path.join(shots, '01-onboarding.png') })

// 建库
await page.fill('#new-password', 'smoke-test-1234')
await page.fill('#confirm-password', 'smoke-test-1234')
await page.click('button[type="submit"]')
await page.waitForTimeout(2600)
await page.screenshot({ path: path.join(shots, '02-empty.png') })

// 写一篇
await page.click('text=开始写')
await page.waitForTimeout(300)
await page.fill('input[aria-label="今天发生了什么？"]', '雨停之后')
await page.click('.cm-content')
await page.keyboard.type('下午四点雨停了。\n\n窗外的树被打得发亮，叶子边缘还挂着水。\n\n这几天一直在想**专注**这件事。\n\n> 注意力不是一种资源，更像一种习惯。')
await page.waitForTimeout(1600)
await page.screenshot({ path: path.join(shots, '03-editor.png') })

// 预览
await page.click('text=预览')
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(shots, '04-preview.png') })
await page.click('text=源码')

// 统计
await page.click('text=统计')
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(shots, '05-stats.png') })

// 设置
await page.click('text=设置')
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(shots, '06-settings.png') })

// 深色
await page.click('button:has-text("深色")')
await page.waitForTimeout(500)
await page.click('text=统计')
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(shots, '07-dark.png') })

// 导出 PDF：替换保存对话框，验证打印链路真的产出 PDF
const pdfPath = path.join(shots, 'export.pdf')
await app.evaluate(({ dialog }, target) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
}, pdfPath)
await page.click('aside button:has-text("统计")')
await page.waitForTimeout(200)
await page.keyboard.press('Escape')
await page.evaluate(async (target) => {
  const result = await window.miniDiary.invoke('export:run', {
    format: 'pdf',
    html: '<article class="entry"><h2>雨停之后</h2><p class="entry-meta">2026年11月6日</p><div class="entry-body"><p>下午四点雨停了。</p></div></article>'
  })
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  void target
}, pdfPath)
await page.waitForTimeout(2500)
const pdfStat = await stat(pdfPath).catch(() => null)
console.log('pdf bytes', pdfStat ? pdfStat.size : 0)

// 锁定（点侧栏按钮，不依赖菜单加速键）
await page.click('aside button:has-text("锁定")')
await page.waitForTimeout(1200)
await page.screenshot({ path: path.join(shots, '08-locked.png') })

// 错误密码 → 再正确解锁
await page.fill('#unlock-password', 'wrong-password')
await page.click('button[type="submit"]')
await page.waitForTimeout(2200)
await page.screenshot({ path: path.join(shots, '09-wrong-password.png') })
await page.fill('#unlock-password', 'smoke-test-1234')
await page.click('button[type="submit"]')
await page.waitForTimeout(2600)
await page.screenshot({ path: path.join(shots, '10-unlocked.png') })

await app.close()
await rm(home, { recursive: true, force: true })
console.log('smoke ok; screenshots in', shots)

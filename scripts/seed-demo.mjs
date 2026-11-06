// 生成 40 天演示数据的迁移包：demo/40-days.minidiary
//
// 用法：
//   node scripts/seed-demo.mjs          # 约 50 MB（图片/音频/视频/归档各一份）
//   node scripts/seed-demo.mjs --big    # 额外生成 320 MB 归档，用于测试 >300 MB 二次确认
//
// 原理：在隔离的临时目录里启动真实 Electron，用应用自己的 IPC 写入 32 篇日记与附件，
// 再导出成 .minidiary。这样产出的数据格式与手动写作完全一致，不碰你的真实日记库。
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { _electron as electron } from 'playwright'

import { demoEntries, demoPassword } from './demo-content.mjs'
import { writeArchiveZip, writePhotoPng, writeRainWav } from './lib/media.mjs'

const BIG = process.argv.includes('--big')
const PACKAGE_PATH = path.resolve('demo/40-days.minidiary')
const KEY_PATH = path.resolve('demo/40-days.key.txt')
const VAULT_PASSWORD = 'seed-vault-2026'

// 与 src/shared/packageKey.ts 保持一致的字母表（脚本是 .mjs，不能直接 import TS）
const KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const KEY_LENGTH = 32

function generatePackageKey() {
  const limit = Math.floor(256 / KEY_ALPHABET.length) * KEY_ALPHABET.length
  let key = ''
  while (key.length < KEY_LENGTH) {
    const bytes = new Uint8Array(KEY_LENGTH)
    globalThis.crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= limit) continue
      key += KEY_ALPHABET[byte % KEY_ALPHABET.length]
      if (key.length === KEY_LENGTH) break
    }
  }
  return key
}

function formatPackageKey(key) {
  return key.match(/.{1,4}/g).join('-')
}

// 附件名会直接取源文件名（主进程只接受路径），所以临时文件就用中文名
const MEDIA = {
  photo1: { file: '窗外的梧桐.png', kind: 'image' },
  photo2: { file: '十一月的窗.png', kind: 'image' },
  photo3: { file: '书架.png', kind: 'image' },
  'rain-short': { file: '窗外的雨.wav', kind: 'audio' },
  'rain-long': { file: '十一月的雨.wav', kind: 'audio' },
  'flower-mp4': { file: '楼下的花.mp4', kind: 'video' },
  'flower-webm': { file: '窗外的街.webm', kind: 'video' },
  archive: { file: '项目归档-2026Q3.zip', kind: 'file' },
  orphan: { file: '截图-未引用.png', kind: 'image' }
}

const SAMPLE_VIDEOS = {
  '楼下的花.mp4': 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  '窗外的街.webm': 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm'
}

function log(message) {
  console.log(`[seed] ${message}`)
}

async function downloadSample(fileName, targetDir) {
  const url = SAMPLE_VIDEOS[fileName]
  const target = path.join(targetDir, fileName)
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    await writeFile(target, buffer)
    log(`下载示例视频 ${fileName}（${(buffer.length / 1024 / 1024).toFixed(1)} MB，CC0）`)
    return target
  } catch (error) {
    log(`跳过 ${fileName}：${error.message}`)
    return null
  }
}

async function buildMedia(dir) {
  const paths = {}

  log('生成图片…')
  await writePhotoPng(path.join(dir, MEDIA.photo1.file), { hue: 146, seed: 11 })
  await writePhotoPng(path.join(dir, MEDIA.photo2.file), { hue: 198, seed: 23 })
  await writePhotoPng(path.join(dir, MEDIA.photo3.file), { hue: 32, seed: 37 })
  paths.photo1 = path.join(dir, MEDIA.photo1.file)
  paths.photo2 = path.join(dir, MEDIA.photo2.file)
  paths.photo3 = path.join(dir, MEDIA.photo3.file)

  log('生成雨声（8 秒 / 90 秒）…')
  await writeRainWav(path.join(dir, MEDIA['rain-short'].file), { seconds: 8 })
  await writeRainWav(path.join(dir, MEDIA['rain-long'].file), { seconds: 90 })
  paths['rain-short'] = path.join(dir, MEDIA['rain-short'].file)
  paths['rain-long'] = path.join(dir, MEDIA['rain-long'].file)

  log('生成 30 MB 归档附件…')
  await writeArchiveZip(path.join(dir, MEDIA.archive.file), { megabytes: 30 })
  paths.archive = path.join(dir, MEDIA.archive.file)

  if (BIG) {
    log('生成 320 MB 归档附件（--big）…')
    await writeArchiveZip(path.join(dir, '大型归档测试.zip'), { megabytes: 320 })
    paths['archive-big'] = path.join(dir, 'archive-big.zip')
  }

  log('准备示例视频…')
  const mp4 = await downloadSample('楼下的花.mp4', dir)
  const webm = await downloadSample('窗外的街.webm', dir)
  if (mp4) paths['flower-mp4'] = mp4
  if (webm) paths['flower-webm'] = webm

  await writePhotoPng(path.join(dir, MEDIA.orphan.file), { hue: 280, seed: 71 })
  paths.orphan = path.join(dir, MEDIA.orphan.file)

  return paths
}

function payloadFor(mediaPaths) {
  return demoEntries.map((entry) => ({
    date: entry.date,
    title: entry.title,
    tags: entry.tags,
    body: entry.body,
    media: (entry.media ?? [])
      .filter((item) => mediaPaths[item.key])
      .map((item) => ({
        path: mediaPaths[item.key],
        name: path.basename(mediaPaths[item.key]),
        kind: item.kind
      }))
  }))
}

async function seed(page, mediaPaths) {
  const entries = payloadFor(mediaPaths)
  const orphanPath = mediaPaths.orphan

  return page.evaluate(
    async ({ entries: payload, orphan, bigPath }) => {
      const failures = []
      let attachmentCount = 0

      for (const item of payload) {
        const attachments = []
        const links = []
        for (const media of item.media) {
          const result = await window.miniDiary.invoke('attachment:addFromPath', {
            sourcePath: media.path
          })
          if (!result.ok) {
            failures.push(`${item.date} ${media.name}: ${result.error.message}`)
            continue
          }
          attachmentCount += 1
          attachments.push(result.data)
          const prefix = result.data.kind === 'image' ? '!' : ''
          links.push(`${prefix}[${result.data.name}](attachment://${result.data.id})`)
        }

        const body = links.length > 0 ? `${item.body}\n\n${links.join('\n\n')}` : item.body
        const saved = await window.miniDiary.invoke('entry:save', {
          entry: {
            date: item.date,
            title: item.title,
            body,
            tags: item.tags,
            attachments
          }
        })
        if (!saved.ok) failures.push(`${item.date}: ${saved.error.message}`)
      }

      // 一份没有任何日记引用的附件（测试"清理未引用附件"）
      const orphanResult = await window.miniDiary.invoke('attachment:addFromPath', {
        sourcePath: orphan
      })
      if (orphanResult.ok) attachmentCount += 1
      else failures.push(`orphan: ${orphanResult.error.message}`)

      if (bigPath) {
        const big = await window.miniDiary.invoke('attachment:addFromPath', { sourcePath: bigPath })
        if (!big.ok) failures.push(`big: ${big.error.message}`)
        else {
          attachmentCount += 1
          await window.miniDiary.invoke('entry:save', {
            entry: {
              date: '2026-11-06',
              title: '雨停之后',
              body: `下午四点雨停了。\n\n[320MB 测试归档](attachment://${big.data.id})`,
              tags: ['日常', '思考'],
              attachments: [big.data]
            }
          })
        }
      }

      return { attachmentCount, failures }
    },
    { entries, orphan: orphanPath, bigPath: BIG ? mediaPaths['archive-big'] : null }
  )
}

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), 'minidiary-seed-'))
  const mediaDir = path.join(workDir, 'media')
  const appHome = path.join(workDir, 'app')
  await mkdir(mediaDir, { recursive: true })
  await mkdir(path.resolve('demo'), { recursive: true })

  let app = null
  try {
    const mediaPaths = await buildMedia(mediaDir)

    log('启动隔离的 Electron…')
    app = await electron.launch({
      args: ['.'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        MINIDIARY_SILENT: '1',
        MINIDIARY_USER_DATA: path.join(appHome, 'userdata'),
        MINIDIARY_DIARY_DIR: path.join(appHome, 'diary')
      }
    })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => log(`渲染进程异常：${error.message}`))
    await page.waitForLoadState('domcontentloaded')

    const created = await page.evaluate(
      async (password) => window.miniDiary.invoke('vault:create', { password }),
      VAULT_PASSWORD
    )
    if (!created.ok) throw new Error(`建库失败：${created.error.message}`)

    log(`写入 ${demoEntries.length} 篇日记…`)
    const seeded = await seed(page, mediaPaths)
    if (seeded.failures.length > 0) {
      log(`有 ${seeded.failures.length} 个附件/条目写入失败：`)
      for (const failure of seeded.failures) log(`  - ${failure}`)
    }

    log('导出迁移包…')
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, PACKAGE_PATH)
    const packageKey = generatePackageKey()
    const exported = await page.evaluate(
      async ({ password, key }) =>
        window.miniDiary.invoke('migration:export', { packagePassword: password, packageKey: key }),
      { password: demoPassword, key: packageKey }
    )
    if (!exported.ok) throw new Error(`导出失败：${exported.error.message}`)
    if (!exported.data.path) throw new Error('导出被取消')

    const preview = await page.evaluate(
      async ({ filePath, password, key }) =>
        window.miniDiary.invoke('migration:preview', {
          filePath,
          packagePassword: password,
          packageKey: key
        }),
      { filePath: PACKAGE_PATH, password: demoPassword, key: packageKey }
    )
    if (!preview.ok) throw new Error(`迁移包校验失败：${preview.error.message}`)

    await writeFile(
      KEY_PATH,
      `Mini Diary 迁移包附带的公钥（导入时必须一起提供）\n\n` +
        `${formatPackageKey(packageKey)}\n\n` +
        `私钥：${demoPassword}\n` +
        `迁移包：${PACKAGE_PATH}\n` +
        `生成时间：${new Date().toISOString()}\n`,
      { mode: 0o600 }
    )

    const info = await stat(PACKAGE_PATH)
    log('完成')
    log(`迁移包：${PACKAGE_PATH}`)
    log(`大小：${(info.size / 1024 / 1024).toFixed(1)} MB`)
    log(
      `内容：${preview.data.summary.entryCount} 篇日记 · ${preview.data.summary.attachmentCount} 个附件 · ` +
        `${preview.data.summary.firstDate} 至 ${preview.data.summary.lastDate}`
    )
    log(`公钥（私钥之外的必需项）：${formatPackageKey(packageKey)}`)
    log(`私钥（即导入密码）：${demoPassword}`)
    log(`公钥已写入：${KEY_PATH}`)
  } finally {
    await app?.close().catch(() => undefined)
    await rm(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('[seed] 失败：', error)
  process.exitCode = 1
})

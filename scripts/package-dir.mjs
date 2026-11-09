// electron-builder 26 的 CLI 在 Node 24 下会把自身路径当成参数（Unknown argument），
// 这里直接调 API。用法：node scripts/package-dir.mjs [--dir|--mac|--win|--linux] [--arch=arm64|x64|universal]
import path from 'node:path'

import { build as electronBuild } from 'electron-builder'

const args = process.argv.slice(2)
const pick = (name) => args.find((arg) => arg === name)
const archArg = args.find((arg) => arg.startsWith('--arch='))?.split('=')[1]
const mode = pick('--dir') ?? pick('--mac') ?? pick('--win') ?? pick('--linux') ?? '--dir'

// 默认只打当前机器架构：避免在 Apple Silicon 上顺手去下载 x64 的 Electron 包
const arch = archArg ?? (process.arch === 'arm64' ? 'arm64' : 'x64')
if (!['arm64', 'x64', 'universal'].includes(arch)) {
  console.error(`[package] 未知架构：${arch}（可选 arm64 / x64 / universal）`)
  process.exit(1)
}

const options = { publish: 'never' }
// 本机已有 Electron 发行版时直接复用，避免联网下载大体积 zip（架构一致才可用）
if (arch === process.arch) {
  const localDist = path.join(process.cwd(), 'node_modules', 'electron', 'dist')
  options.config = { electronDist: localDist }
}
if (arch === 'arm64') options.arm64 = true
else if (arch === 'x64') options.x64 = true
else options.universal = true

if (mode === '--mac') options.mac = ['dmg', 'zip']
else if (mode === '--win') options.win = ['nsis']
else if (mode === '--linux') options.linux = ['AppImage', 'deb']
else options.dir = true

console.log(`[package] ${mode} ${arch}  →  release/`)
await electronBuild(options)

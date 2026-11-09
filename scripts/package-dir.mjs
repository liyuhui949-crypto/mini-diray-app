// electron-builder 26 的 CLI 在 Node 24 下会把自身路径当成参数（Unknown argument），
// 这里直接调 API。用法：node scripts/package-dir.mjs [--dir|--mac|--win|--linux] [--arch=arm64|x64|universal]
import path from 'node:path'

import { build as electronBuild } from 'electron-builder'

const args = process.argv.slice(2)
const pick = (name) => args.find((arg) => arg === name)
const archArg = args.find((arg) => arg.startsWith('--arch='))?.split('=')[1]
const mode = pick('--dir') ?? pick('--mac') ?? pick('--win') ?? pick('--linux') ?? '--dir'

// 默认架构：mac/dir 跟随当前机器；Windows/Linux 默认 x64（最常见的目标）
const defaultArch =
  mode === '--mac' || mode === '--dir' ? (process.arch === 'arm64' ? 'arm64' : 'x64') : 'x64'
const arch = archArg ?? defaultArch
if (!['arm64', 'x64', 'universal'].includes(arch)) {
  console.error(`[package] 未知架构：${arch}（可选 arm64 / x64 / universal）`)
  process.exit(1)
}

const options = { publish: 'never' }
// 本机已有 Electron 发行版时直接复用，避免联网下载大体积 zip（架构一致才可用）
// 只有“目标平台就是当前平台”时才复用本机 Electron（Windows 上打 win、macOS 上打 mac/dir）
const hostMode =
  process.platform === 'darwin' ? '--mac' : process.platform === 'win32' ? '--win' : '--linux'
if ((mode === '--dir' || mode === hostMode) && arch === process.arch) {
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

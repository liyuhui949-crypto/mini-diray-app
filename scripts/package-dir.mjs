// electron-builder 26 的 CLI 在 Node 24 下会把自身路径当成参数（Unknown argument），
// 这里直接调 API。用法：node scripts/package-dir.mjs [--dir|--mac|--win|--linux]
import { build } from 'electron-builder'

const mode = process.argv[2] ?? '--dir'
const options = { publish: 'never' }
if (mode === '--mac') options.mac = ['dmg', 'zip']
else if (mode === '--win') options.win = ['nsis']
else if (mode === '--linux') options.linux = ['AppImage', 'deb']
else options.dir = true

console.log(`[package] ${mode}  →  release/`)
await build(options)

/* eslint-disable @typescript-eslint/no-require-imports */
// 自定义 electronDist 来自本机 Electron.app 时，Electron 自带的 default_app.asar
// 会被当成目录复制；electron-builder 的 asar integrity 只接受文件，会因此报错。
// 应用自己的 app.asar 已存在，default_app.asar 在打包后没有用途，直接移除。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function afterExtract(context) {
  const resourcesDirs =
    context.electronPlatformName === 'darwin'
      ? fs
          .readdirSync(context.appOutDir)
          .filter((name) => name.endsWith('.app'))
          .map((name) => path.join(context.appOutDir, name, 'Contents', 'Resources'))
      : [path.join(context.appOutDir, 'resources')]
  // Electron 的 fs 补丁会把 .asar 路径当成包处理，交给系统 rm
  for (const resources of resourcesDirs) {
    execFileSync('rm', ['-rf', path.join(resources, 'default_app.asar')])
  }
}

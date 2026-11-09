/* eslint-disable @typescript-eslint/no-require-imports */
// 没有 Developer ID 证书时，electron-builder 会跳过签名，但 App 里仍残留 Electron 的
// 旧链接签名；拷贝/改包名后这个签名就失效，Finder 会报「已损坏，无法打开」。
// 这里在打包后做一次 ad-hoc 签名，保证至少本机/右键打开可用。
const { execFileSync } = require('node:child_process')
const path = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  // 配了正式证书就交给 electron-builder 后面的签名流程
  if (process.env.CSC_LINK || process.env.CSC_NAME) return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  console.log(`[after-pack] ad-hoc signing ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })
}

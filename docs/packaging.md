# 打包与分发（macOS，不上架 App Store）

本项目用 electron-builder 直接产出安装包，**不经过 App Store**，也不需要 App Store Connect。
macOS 走的是「Developer ID + 公证」的直接分发路径；没有证书时先出**未签名包**，见 §2。

## 1. 命令

```bash
pnpm install
pnpm verify                 # 可选：先跑单测/组件/构建
pnpm package:mac            # 当前机器架构（Apple Silicon 出 arm64）
pnpm package:mac:x64        # 需要 Intel 包时
pnpm package:mac:universal  # 一个包同时支持 Intel + Apple Silicon（更慢、包更大）
```

只想快速看 `.app`、不生成 dmg：

```bash
pnpm package:dir            # 产物在 release/mac-arm64/Mini Diary.app
```

产物都在 `release/`：

- `Mini Diary-1.0.0-arm64.dmg`（分发用）
- `Mini Diary-1.0.0-arm64-mac.zip`（备用）
- `release/mac-arm64/Mini Diary.app`（调试用）

版本号来自 `package.json` 的 `version`；图标来自 `build/icon.png`（1024×1024，electron-builder 自动生成 `.icns`）。

## 2. 现在：未签名包（无 Apple 开发者账号）

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package:mac
```

`CSC_IDENTITY_AUTO_DISCOVERY=false` 是为了避免 electron-builder 去钥匙串里找一个不存在的证书。
打出来的包可以直接运行，但 Gatekeeper 会拦首次打开：

- 访达里右键 App →「打开」→ 再点「打开」；
- 或「系统设置 → 隐私与安全性」→ 底部「仍要打开」；
- 或终端：

```bash
xattr -dr com.apple.quarantine "/Applications/Mini Diary.app"
```

这只适合自己用或给熟悉终端的人测试；**不适合公开分发**（用户会看到"无法验证开发者"的提示）。

## 3. 正式分发：Developer ID + 公证（推荐）

需要 Apple Developer Program（个人/公司，99 美元/年），但**不需要上架 App Store**。

1. 在 [developer.apple.com](https://developer.apple.com/account) 创建
   **Developer ID Application** 证书，导入本机钥匙串；
   `security find-identity -v -p codesigning` 应能看到 `Developer ID Application: ...`。
2. 生成 App 专用密码：Apple ID 账号页 →「登录与安全」→ App 专用密码。
3. 用环境变量提供公证凭据（electron-builder 26 会签名、公证并 staple）：

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"

pnpm package:mac
```

   - 不要设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`；
   - 证书多张时可用 `CSC_NAME="Developer ID Application: 你的名字 (TEAMID)"` 指定；
   - `electron-builder.yml` 里已经开启 `hardenedRuntime: true` 并带 `build/entitlements.mac.plist`
     （JIT / unsigned executable memory / disable library validation，Electron 运行所需）。

4. 验证：

```bash
codesign -dv --verbose=2 "release/mac-arm64/Mini Diary.app"
spctl -a -vv "release/mac-arm64/Mini Diary.app"   # 期望 accepted / Notarized Developer ID
xcrun stapler validate "release/mac-arm64/Mini Diary.app"
```

公证通过后，用户双击 dmg 安装即可，不再需要右键打开或 `xattr`。

## 4. 不上架 App Store 意味着什么

- 不需要 App Sandbox、不需要 provisioning profile、不需要 App Store 审核；
- 可以自由读取用户选择的目录（本项目的日记目录在 `~/Documents/Mini Diary`）；
- 首次启动会请求访问「文稿」目录，这是 macOS 的 TCC 行为，属于正常现象；
- 分发渠道可以是自己的网站、Gitee/GitHub Release、网盘等；把 dmg 和校验值一起给用户即可。

## 5. 包体积与内容

| 部分 | 体积 | 说明 |
|---|---|---|
| `Contents/Frameworks` | ~255 MB | Electron 运行时（Chromium + Node + 各 Helper），无法裁剪 |
| `Contents/Resources/app.asar` | ~4.6 MB | 应用代码 + 运行时依赖（不含地图/日志等） |
| `Contents/Resources/fonts` | ~2.2 MB | PDF 用的 4 个 Noto Sans SC 子集，走 `extraResources` |
| **App 总大小** | **~264 MB** | |
| **dmg** | **~117 MB** | 压缩后 |

- **不会打包你的日记数据**：`electron-builder.yml` 的 `files` 只有 `out/**` 和 `package.json`；
  日记库在 `~/Documents/Mini Diary`，偏好与缓存也不在打包目录里。
- 之前 dmg 185 MB / App 344 MB 的原因是 `@fontsource/noto-sans-sc` 整套 75 MB 字体被塞进了 `app.asar`；
  现在只把 PDF 实际用到的 4 个 `.woff2` 放进 `Resources/fonts`，asar 从 76 MB 降到 4.6 MB。
- 如果还想再小一点，可以给 `electron-builder` 加 `electronLanguages: [zh_CN, en]` 裁剪 Electron 的多语言包（省个位数 MB）。

## 6. 升级与卸载

- 本项目没有在线更新（ADR 0007）：发新版本时重新打 dmg，用户下载后覆盖安装；
- 数据在 `~/Documents/Mini Diary`（日记库）与 `~/Library/Application Support/Mini Diary`（偏好），
  覆盖安装不会动它们；卸载 App 也不会删数据（需要用户手动清理）。

## 7. 安装版打不开的两种常见原因

### 6.1 `pnpm dev` 正在运行（单实例锁）

安装版和开发模式共用同一个 `~/Library/Application Support/Mini Diary`，Electron 的单实例锁也在这个目录：

```
~/Library/Application Support/Mini Diary/SingletonLock -> <host>-<pid>
```

如果 `pnpm dev` 已经在跑，再打开安装版，安装版拿不到锁会**静默退出**（看起来就是"双击没反应"）；
反过来，安装版开着时执行 `pnpm dev`，开发窗口也不会出现。

处理：

```bash
pgrep -fl "electron-vite dev"     # 有输出就说明 dev 在跑
osascript -e 'quit app "Mini Diary"'   # 退出安装版
pnpm dev                               # 再启动开发预览
```

开发模式拿不到锁时，现在会弹一个提示框并打印到终端，不再静默退出：

> 无法启动开发预览：已经有一个 Mini Diary 实例在运行，可能是安装版或另一个开发实例。

这是有意的保护：两个实例同时写同一个日记库会损坏数据。开发时要测安装版，先退出 `pnpm dev`。

### 6.2 签名失效（"已损坏，无法打开"）

未签名时 App 里残留的是 Electron 自带的旧签名，改包名后会失效，Finder 报「已损坏」。
`scripts/after-pack.cjs` 会在打包后自动做一次 **ad-hoc 签名**（`codesign --force --deep --sign -`），
所以重新打的 dmg 不会再出现这个问题；已经装坏的旧包可以手动修：

```bash
codesign --force --deep --sign - "/Applications/Mini Diary.app"
open "/Applications/Mini Diary.app"
```

注意 ad-hoc 签名只是让包"完整"，**没有公证**：从网上下载（带 quarantine）后仍需右键 →「打开」。

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| `xcrun: error: unable to find utility "notarytool"` | 安装/升级 Xcode Command Line Tools：`xcode-select --install` |
| 打包卡在 `downloaded label=electron` 或很慢 | electron-builder 在下载对应架构的 Electron；网络差时可先跑一次 `--arch=arm64`，避免同时拉 x64 |
| 公证报 `Invalid` / `The binary is not signed with a valid Developer ID certificate` | 证书类型不对（要 Developer ID Application，不是 Apple Development）或 `hardenedRuntime`/entitlements 被改坏 |
| 用户仍看到"已损坏，无法打开" | 未公证或公证后没有 staple；重新执行 `xcrun stapler staple`，或让用户临时 `xattr -dr com.apple.quarantine` |
| 想同时支持 Intel | `pnpm package:mac:universal`（首次会下载 x64 Electron），或分别出 arm64/x64 两个 dmg |

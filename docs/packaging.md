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

## 5. Windows 安装包

流程与 macOS 相同（`electron-vite build` → electron-builder），只是目标平台和签名方式不同。
**推荐在 Windows 10/11 x64 上打包**；macOS/Linux 交叉打包见 §5.6。

### 5.1 前置条件

- Windows 10/11 x64（ARM64 包见 §5.5）；
- Node.js 24（含 Corepack），或直接安装 pnpm 11；
- 无需 Visual Studio / Python：项目没有原生模块。

```powershell
node -v          # v24.x
corepack enable
pnpm -v          # 11.x
```

### 5.2 从源码打包（推荐流程）

```powershell
# 1. 取得代码（或直接拷贝整个项目目录）
git clone <仓库地址> "mini diary"
cd "mini diary"

# 2. 安装依赖
pnpm install

# 3. 可选：先跑单测/组件测试与构建，确认源码没问题
pnpm verify

# 4. 打包（内部会先 pnpm build，再调 electron-builder）
pnpm package:win
```

产物在 `release\`：

| 文件 | 说明 |
|---|---|
| `Mini Diary-1.0.0-setup.exe` | NSIS 安装包（x64，默认） |
| `win-unpacked\Mini Diary.exe` | 免安装目录（`pnpm package:dir` 时生成） |
| `builder-debug.yml` | 构建配置快照，排查打包问题用 |

版本号来自 `package.json` 的 `version`；文件名规则在 `electron-builder.yml` 的
`win.artifactName: ${productName}-${version}-setup.${ext}`。

### 5.3 安装包内容与行为

- `app.asar`：应用代码 + 运行时依赖；
- `resources\fonts\*.woff2`：PDF 只带 4 个中文字体子集；
- `resources\app.asar.unpacked\`：如后续引入原生模块会出现，目前为空；
- 安装选项：可选安装目录、桌面/开始菜单快捷方式、`.minidiary` 文件关联（NSIS 的
  `oneClick: false`、`allowToChangeInstallationDirectory: true`）；
- 不会打包日记数据：日记在 `%USERPROFILE%\Documents\Mini Diary`，偏好在 `%APPDATA%\Mini Diary`；
- 卸载程序保留上述两个数据目录（和 macOS 一致，避免误删日记）。

### 5.4 安装后自检

1. 安装并启动，确认版本（设置 → 关于）为当前 `package.json` 版本；
2. 建库 → 写一篇（含标题/正文/标签）→ 添加一张图片和一份 PDF；
3. 锁定 → 解锁，确认正文与附件仍在；
4. 导出 Markdown / PDF（PDF 应带中文字体）、导出迁移包；
5. 关闭窗口再打开，确认单实例行为（第二次启动只聚焦已有窗口）。

### 5.5 架构与免安装目录

```powershell
# 默认 x64
pnpm package:win

# Windows on ARM（Surface 等）
node scripts/package-dir.mjs --win --arch=arm64

# 只出免安装目录，不生成 NSIS 安装包（调试用，最快）
pnpm package:dir
```

`pnpm package:dir` 在 Windows 上输出 `release\win-unpacked\Mini Diary.exe`，可以直接双击验证，
不必反复安装/卸载。

### 5.6 在 macOS / Linux 上交叉打包

```bash
pnpm package:win
```

- 会下载 Windows 版 Electron（约 120 MB）与 NSIS 工具；
- macOS 上编辑 exe 图标/版本信息依赖 **Wine**（`brew install --cask wine-stable`），
  没有 Wine 时通常会在 `winCodeSign` / `rcedit` 阶段失败；
- 更稳的替代方案：Windows 机器、Windows VM，或 CI 的 `windows-latest`（见 §5.8）。

### 5.7 代码签名与 SmartScreen

未签名的 exe 首次运行会出现「Windows 已保护你的电脑」：

- 临时绕过：点「更多信息」→「仍要运行」；
- 正式分发：购买代码签名证书（OV/EV），打包时提供：
  ```powershell
  $env:CSC_LINK="C:\path\to\cert.pfx"   # 或 base64
  $env:CSC_KEY_PASSWORD="证书密码"
  pnpm package:win
  ```
  electron-builder 会自动签名 exe；EV 证书还能减少 SmartScreen 警告的积累时间。
- 签名后可用 `signtool verify /pa /v "release\win-unpacked\Mini Diary.exe"` 校验。

### 5.8 GitHub Actions（可选，无需本地 Windows）

```yaml
name: package-windows
on: [workflow_dispatch]
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm package:win
      - uses: actions/upload-artifact@v4
        with:
          name: windows-installer
          path: release/*.exe
```

### 5.9 Windows 常见问题

| 现象 | 处理 |
|---|---|
| `pnpm` 命令不存在 | 先 `corepack enable`，或 `npm i -g pnpm@11` |
| 打包时报 `winCodeSign` / `rcedit` 相关错误 | 这是交叉打包的 Wine 依赖；改用 Windows 机器或 CI |
| 安装时被杀软/Defender 拦 | 未签名安装包的常见误报；签名，或把目录加入信任后重试 |
| 双击 exe 没反应 | 检查是否已有 Mini Diary 在运行（单实例锁）；看任务管理器或 `%APPDATA%\Mini Diary\logs` |
| 想改安装包文件名 | 改 `electron-builder.yml` 的 `win.artifactName` |
| 卸载后数据还在 | 预期行为：日记与偏好分别在 Documents / AppData，需手动删除 |

## 6. 包体积与内容

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

## 7. 升级与卸载

- 本项目没有在线更新（ADR 0007）：发新版本时重新打 dmg，用户下载后覆盖安装；
- 数据在 `~/Documents/Mini Diary`（日记库）与 `~/Library/Application Support/Mini Diary`（偏好），
  覆盖安装不会动它们；卸载 App 也不会删数据（需要用户手动清理）。

## 8. 安装版打不开的两种常见原因

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

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| `xcrun: error: unable to find utility "notarytool"` | 安装/升级 Xcode Command Line Tools：`xcode-select --install` |
| 打包卡在 `downloaded label=electron` 或很慢 | electron-builder 在下载对应架构的 Electron；网络差时可先跑一次 `--arch=arm64`，避免同时拉 x64 |
| 公证报 `Invalid` / `The binary is not signed with a valid Developer ID certificate` | 证书类型不对（要 Developer ID Application，不是 Apple Development）或 `hardenedRuntime`/entitlements 被改坏 |
| 用户仍看到"已损坏，无法打开" | 未公证或公证后没有 staple；重新执行 `xcrun stapler staple`，或让用户临时 `xattr -dr com.apple.quarantine` |
| 想同时支持 Intel | `pnpm package:mac:universal`（首次会下载 x64 Electron），或分别出 arm64/x64 两个 dmg |

# Mini Diary

本地优先、默认加密、离线可用的桌面日记。默认纯本地存储，没有账号；可选 Git 同步只推送正文与批注的密文，附件仍走手动迁移。

- **技术栈**：Electron + React 19 + Vite + TypeScript + SCSS
- **界面语言**：仅简体中文（文案集中在 `src/shared/copy.ts`，不引入 i18n）
- **平台**：macOS / Windows / Linux 源码；当前 Release 仅 macOS arm64
- **当前版本**：1.0.0

## 下载

当前提供 macOS Apple Silicon 版本：

[下载 Mini Diary 1.0.0](https://github.com/liyuhui949-crypto/mini-diray-app/releases/latest) · [安装说明](https://liyuhui949-crypto.github.io/mini-diray-app/download.html)

安装包未使用 Apple Developer ID 签名，也未经过 Apple 公证；首次打开可能被 Gatekeeper 拦截，处理方式见安装说明。

## 功能

| 区域 | 内容 |
|---|---|
| 写作 | 一天一篇、标题 + Markdown 正文、加粗/斜体/列表工具栏、实时字数、800ms 自动保存、失焦/切日期/锁定前 flush；预览/源码模式跨日记保留 |
| 日历 | 6×7 月历（周一开始）、有内容日期圆点、未来日期限制、回到今天、跳转日期、键盘导航 |
| 列表 | 默认跟随日历当前月份；可切到「全部」跨月浏览；标签与搜索始终是全库视图 |
| 附件 | 图片 / 音频 / 视频 / 其他文件，全部流式加密写入；`attachment://` 解密代理支持 Range，视频可拖动进度 |
| 附件库 | 侧栏「附件」按格式聚合全部附件：分类 tab 带实时计数、可预览类图片墙、文件类行列表；右上角可切换「点击预览附件 / 预览日记」（持久化，预览内也能互切）；「未引用」tab 查看并清理孤儿附件；零新存储 |
| 批注 | 历史日记正文只读，批注是与正文平行的第二条记录流：选中一句加批注（锚点双向定位）、空日期整篇批注、日历红点、列表「批注 n」角标；与正文同 DEK 加密、只增不改、随迁移包走 |
| 搜索 | 检索洞察：命中篇数 + 最早/最近范围、逐月时间线柱状、按年份分组的证据（连续段徽标）、预览对话框不打断检索；320ms 防抖 + 回车立即检索；中文子串、NFKC 归一化、多词 AND |
| 统计 | 总条目、每周平均、最长/当前连续、总字数、每篇平均 + 近 12 周柱状图 + 13 周热力图 + 存储占用 |
| 安全 | 密码解锁、锁屏/挂起立即锁定、可选应用内无操作自动锁定、改密只重包 DEK |
| 迁移 | `.minidiary` 整库迁移包（公钥 + 私钥双因子、ZIP64、replace/merge、staging + 原子切换 + 回滚；携带 Git 仓库/分支/开启状态，不带 token/代理）；首次安装页导入，数据页只保留导出 |
| Git 同步 | 可选、默认关闭；侧栏「同步」在右侧面板配置；开启后使用系统 `git` 只同步正文与批注，今天和附件不同步；仓库里只有密文；附件用带公钥+私钥的 `.inkatt` 手动迁移；恢复密钥 `.inkkey` 用于清空后重新解密 Git 仓库；令牌用日记库密钥加密保存 |
| 导入导出 | Day One JSON/TXT、jrnl JSON、Mini Diary JSON；导出 JSON / Markdown / PDF / Day One TXT |

## 快速开始

```bash
corepack enable
pnpm install

pnpm dev            # 开发（HMR）
pnpm build          # 构建到 out/
pnpm start          # 用构建产物启动

pnpm typecheck      # 三套 tsconfig
pnpm lint           # ESLint + Stylelint
pnpm test:unit      # Vitest 单元测试
pnpm test:component # Vitest + RTL 组件测试
pnpm test:e2e       # Playwright + 真实 Electron（先 build）
pnpm verify         # typecheck + lint + unit + component + build
pnpm docs:dev       # 本地预览文档站
pnpm docs:build     # 构建文档站到 docs/.vitepress/dist
pnpm docs:preview   # 预览文档站构建结果
```

打包（需要 Electron 二进制，公司网络可设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）：

```bash
pnpm build
node scripts/package-dir.mjs     # 未签名 .app，输出到 release/
pnpm package:mac                 # macOS arm64 dmg + zip；未签名，正式签名/公证需要 Developer ID
```

## 目录结构

```text
src/
├─ main/                 主进程：文件、加密、附件流、迁移、导入导出、窗口与菜单
│  ├─ vault/             加密信封（scrypt + AES-256-GCM）、仓库、临时回滚点
│  ├─ attachments/       MDAT v1 分块 AEAD、流式 store、Range 解密代理
│  ├─ migration/         .minidiary 导出/导入/staging
│  ├─ import/ export/    外部格式解析与导出（含 PDF 打印链路）
│  ├─ core/zip.ts        yazl/yauzl 流式 ZIP64
│  ├─ menu/              原生菜单与窗口命令
│  └─ ipc/               类型化 IPC + Zod 校验 + sender 校验
├─ preload/              contextBridge 白名单（不暴露 ipcRenderer/fs）
├─ renderer/             React 三栏界面（日历 / 条目列表 / 编辑器）
└─ shared/               类型、Zod、纯函数、中文文案、Markdown 渲染
tests/
├─ unit/ component/ e2e/ fixtures/
docs/                           VitePress 项目介绍站，GitHub Pages 公开介绍
├─ index.md                    首页
├─ features.md                 功能介绍
├─ privacy.md                  隐私与安全
├─ usage.md                    使用说明
├─ download.md                 下载与安装说明
└─ .vitepress/
   └─ config.mts               导航、主题与站点配置
```

## 安全基线

- 正文、附件、DEK 不明文落盘；DEK 不跨 IPC。
- 附件读写全部流式，禁止把整个附件读入内存。
- `attachment://<uuid>` 只做解密代理：未解锁 423、未知 404、单区间 Range 206、非法 Range 416、`Cache-Control: no-store`，锁定即中止所有流。
- 渲染进程拿不到原始文件路径、文件句柄或 Node 能力；IPC 全部校验 sender + Zod。
- 迁移包导入防 Zip Slip / Zip Bomb / 符号链接 / 重复条目，staging 校验通过后才原子切换。
- 日志不含密码、密钥、正文、附件名。
- Git 同步只走系统 `git`：只推送正文/批注密文，今天与附件不进入仓库；令牌用日记库密钥加密保存，代理只影响同步子进程。

## 已知限制

- 不做自动备份：迁移包是唯一的完整副本；删除/重置前会提示先导出。
- 视频只支持 Chromium 自带的解码能力（无 ffmpeg、无转码、无缩略图/波形）。
- 密码无法找回，迁移包密码也一样。
- 当前 Release 只有 macOS arm64；没有 Intel、Windows、Linux 正式安装包。
- 未使用 Apple Developer ID，未公证，也不在 App Store 上架；首次打开可能被 Gatekeeper 拦截，且没有自动更新。
- 正式签名、公证和自动更新需要在有 Apple 开发者账号的环境完成。

项目介绍见 [GitHub Pages 文档](docs/index.md)；使用说明见 [使用说明](docs/usage.md)；
隐私与安全见 [隐私与安全](docs/privacy.md)；下载与安装见 [下载说明](docs/download.md)。
文档站使用 VitePress，由 `.github/workflows/deploy-docs.yml` 在推送 main 时自动部署。

## 许可证

本项目采用 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）。

Copyright (C) 2026 李玉辉。

## 社区

本项目在 [LINUX DO](https://linux.do) 社区分享与讨论，感谢社区的反馈与监督。

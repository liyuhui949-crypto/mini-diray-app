# Mini Diary 4.0

本地优先、默认加密、离线可用的桌面日记。纯本地存储，没有账号，不上传任何数据。

- **技术栈**：Electron + React 19 + Vite + TypeScript + SCSS
- **界面语言**：仅简体中文（文案集中在 `src/shared/copy.ts`，不引入 i18n）
- **平台**：macOS / Windows / Linux
- **当前版本**：4.0.0

## 功能

| 区域 | 内容 |
|---|---|
| 写作 | 一天一篇、标题 + Markdown 正文、加粗/斜体/列表工具栏、实时字数、800ms 自动保存、失焦/切日期/锁定前 flush；预览/源码模式跨日记保留 |
| 日历 | 6×7 月历（周一开始）、有内容日期圆点、未来日期限制、回到今天、跳转日期、键盘导航 |
| 列表 | 默认跟随日历当前月份；可切到「全部」跨月浏览；标签与搜索始终是全库视图 |
| 附件 | 图片 / 音频 / 视频 / 其他文件，全部流式加密写入；`attachment://` 解密代理支持 Range，视频可拖动进度 |
| 搜索 | 检索洞察：命中篇数 + 最早/最近范围、逐月时间线柱状、按年份分组的证据（连续段徽标）、预览对话框不打断检索；320ms 防抖 + 回车立即检索；中文子串、NFKC 归一化、多词 AND |
| 统计 | 总条目、每周平均、最长/当前连续、总字数、每篇平均 + 近 12 周柱状图 + 13 周热力图 + 存储占用 |
| 安全 | 密码解锁、锁屏/挂起立即锁定、可选空闲自动锁定、改密只重包 DEK |
| 迁移 | `.minidiary` 整库迁移包（公钥 + 私钥双因子、ZIP64、replace/merge、staging + 原子切换 + 回滚） |
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
```

打包（需要 Electron 二进制，公司网络可设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）：

```bash
pnpm build
node scripts/package-dir.mjs     # 未签名 .app，输出到 release/
pnpm package:mac                 # dmg + zip（需要 Developer ID 证书才能签名/公证）
```

## 目录结构

```text
src/
├─ main/                 主进程：文件、加密、附件流、迁移、导入导出、菜单、更新
│  ├─ vault/             加密信封（scrypt + AES-256-GCM）、仓库、临时回滚点
│  ├─ attachments/       MDAT v1 分块 AEAD、流式 store、Range 解密代理
│  ├─ migration/         .minidiary 导出/导入/staging
│  ├─ import/ export/    外部格式解析与导出（含 PDF 打印链路）
│  ├─ core/zip.ts        yazl/yauzl 流式 ZIP64
│  └─ ipc/               类型化 IPC + Zod 校验 + sender 校验
├─ preload/              contextBridge 白名单（不暴露 ipcRenderer/fs）
├─ renderer/             React 三栏界面（日历 / 条目列表 / 编辑器）
└─ shared/               类型、Zod、纯函数、中文文案、Markdown 渲染
tests/
├─ unit/ component/ e2e/ fixtures/
docs/
├─ implementation-pipeline-v2.md   执行入口与阶段状态
├─ adr/                            架构决策记录
└─ usage.md                        使用说明（含迁移与隐私）
```

## 安全基线

- 正文、附件、DEK 不明文落盘；DEK 不跨 IPC。
- 附件读写全部流式，禁止把整个附件读入内存。
- `attachment://<uuid>` 只做解密代理：未解锁 423、未知 404、单区间 Range 206、非法 Range 416、`Cache-Control: no-store`，锁定即中止所有流。
- 渲染进程拿不到原始文件路径、文件句柄或 Node 能力；IPC 全部校验 sender + Zod。
- 迁移包导入防 Zip Slip / Zip Bomb / 符号链接 / 重复条目，staging 校验通过后才原子切换。
- 日志不含密码、密钥、正文、附件名。

## 已知限制

- 不做自动备份：迁移包是唯一的完整副本；删除/重置前会提示先导出。
- 视频只支持 Chromium 自带的解码能力（无 ffmpeg、无转码、无缩略图/波形）。
- 密码无法找回，迁移包密码也一样。
- 当前仓库只有 macOS arm64 的打包验证记录；Windows/Linux 与签名/公证需要在有证书的环境完成。
- macOS App Store 分发不在范围内。

更多实现细节见 [执行流水线](docs/implementation-pipeline-v2.md) 与 [ADR](docs/adr/0001-rewrite.md)。

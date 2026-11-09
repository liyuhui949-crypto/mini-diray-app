# ADR 0001：用 Electron + Vite 重写 Mini Diary

- 状态：已采纳
- 日期：2026-11-06
- 决策者：项目所有者
- 关联：`implementation-pipeline-v2.md`

## 背景

旧版 Mini Diary 3.3.0 是 React 16 + Redux + Webpack 4 + Electron 8 的实现，
仓库位于 `/Users/wxm/Desktop/LYH/project/mini-diary`，内容为单文件 `mini-diary.txt`
（PBKDF2-SHA512 + AES-192-CBC），无附件、无迁移能力、无中文界面。

v2 需求带来了四项无法在旧架构上温和演进的变化：

1. 只做简体中文，删掉 i18n 基础设施；
2. 图片/音频/视频必须加密存储且支持大文件与视频拖动进度；
3. 一键迁移必须可靠（整库含附件、replace/merge、失败可回滚）；
4. 取消备份功能，迁移包成为唯一的完整副本。

## 决策

### 1. 重写而不是改造

- 新工程放在当前工作区，`electron-vite` 一套配置构建 main / preload / renderer。
- 旧仓库保持原样（**不删除、不修改**），只作为旧加密格式与导入导出的参考。
  本次没有在旧仓库打 `legacy-v3.3.0` tag，也没有创建 `rewrite/vite-electron` 分支：
  老旧代码与本仓库互不影响，避免在没有备份的情况下动用户的历史提交。
- 因此 P0 的"旧 tag + 新分支"以"旧仓库保持只读参考"的方式落地。

### 2. 应用身份

| 项 | 取值 | 说明 |
|---|---|---|
| `appId` | `com.minidiary.desktop` | 与旧版 `com.samuelmeuli.minidiary` 不同，避免自动更新链与新数据目录互相污染 |
| 首发版本 | `4.0.0`（后调整为 `1.0.0`，见 ADR 0007） | 数据格式与旧版不兼容，且不支持旧密码体系以外的迁移路径 |
| 签名 | 暂无证书 | P13 的签名/公证需要有证书的环境；本仓库只提供配置与文档 |
| 分发 | Developer ID + DMG/ZIP（规划） | 不做 App Store 分发 |

### 3. 数据与加密

- 容器 `formatVersion = 1`：`diary.vault` 为 JSON 信封，`scrypt(N=2¹⁷, r=8, p=1)` 派生 KEK，
  AES-256-GCM 包裹随机 DEK，HKDF 派生子密钥（`payload-v1` / `attachment-v1`）。
- 附件 `MDAT v1`：64 字节头 + 1 MiB 分块 AEAD；`attachment://<uuid>` 解密代理支持 Range。
- 附件上限：图片 50 MB、音频 500 MB、视频 2 GB、其他 2 GB；>300 MB 二次确认。
- 改密只重包 DEK，已导出的迁移包继续使用导出时的包密码。

### 4. 迁移包

- `.minidiary` = ZIP64（yazl/yauzl），成员固定为 `manifest.json`、`vault.inkv`、`prefs.json`、
  `attachments/<uuid>.mdat`、`checksums.sha256`。
- 附件密文原样复制（不解密、不压缩）；只重包 DEK。
- 导入一律 staging + 校验 + 原子切换 + 回滚；replace/merge 的语义见流水线第 8 章。

### 5. 不做备份

不生成 `backups/`、不保留历史版本、不提供备份列表/恢复 UI；
高风险操作（改密、导入、迁移、重置）只保留临时回滚点，成功后立即删除。

## 与流水线文档的偏差（均已实装且有测试覆盖）

| 文档要求 | 实际实现 | 原因 |
|---|---|---|
| `file-type` 识别媒体类型 | 自写魔数嗅探（PNG/JPEG/GIF/WebP/AVIF/SVG、MP3/M4A/WAV/OGG/FLAC、MP4/WebM） | `file-type` 只提供 ESM，主进程是 CJS；为 20 行判断引入互操作风险不划算 |
| 主进程用 `marked` + `sanitize-html` 生成 PDF HTML | 渲染进程用 `react-markdown` 生成 HTML，主进程再用 `sanitize-html` 二次清理 | PDF 与界面预览保持一致；主进程仍然执行白名单清理（只允许 `attachment:` / `data:` 协议） |
| PDF 隐藏窗口加载本地 `print.html` | 用内存 `print://<token>/doc` + 独立 session，字体经同一代理提供 | 不产生明文临时文件；窗口销毁后立即解绑协议、清缓存 |
| 无备份但要求临时回滚点 | 改密/重置/外部导入复制回滚点；迁移导入用 rename 回滚目录 | 2 GB 附件整目录复制代价过高，rename 同样能保证原子性 |
| 迁移包 replace 已有库"保留目标 DEK" | 已按此实现（附件解密后用目标 DEK 重新加密） | 与文档一致 |
| 迁移包 replace 无库"采用包内 DEK" | 已按此实现（附件密文原样复制） | 与文档一致 |

### 测试隔离（仅测试/开发）

主进程支持两个环境变量，用于把真实用户目录隔离到临时路径：

- `MINIDIARY_USER_DATA`：覆盖 `app.getPath('userData')`（必须在 ready 前设置）；
- `MINIDIARY_DIARY_DIR`：覆盖默认日记目录（`~/Documents/Mini Diary`）。

生产启动不会设置它们；Playwright E2E 与冒烟脚本依赖这两个变量，避免污染用户数据。

## 后果

- 旧版数据只能通过"导入旧版 Mini Diary 文件"（实验性，PBKDF2-SHA512 + EVP_BytesToKey + AES-192-CBC）读取，
  新格式一旦写入不复用旧算法。
- 无 i18n：未来若要多语言，需要重做文案层（文案已集中，成本可控）。
- 无备份：用户必须理解"迁移包是唯一完整副本"，为此在设置页与危险操作前都做了显式提示。

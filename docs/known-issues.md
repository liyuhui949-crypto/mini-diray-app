# 已知问题与清理清单（待统一修复）

| | |
|---|---|
| 状态 | **仅记录，未修复**（按约定留到后续任务统一处理） |
| 来源 | 2026-11-06 全项目代码审计（静态扫描 + 人工核对），对应提交 `97d8793` |
| 范围 | 除「检索洞察」已交付部分外的全项目；检索迭代的**已知取舍**单列在 §5，不算 bug |
| 行号 | 基于 `97d8793`；代码变动后行号会漂移，定位以**函数名/文件**为准 |

严重度：**P1** = 功能错误；**P2** = 体验/一致性；**P3** = 清理项。安全与数据完整性未发现 P0 级问题。

---

## 1. 汇总

| 编号 | 严重度 | 一句话 | 位置 |
|---|---|---|---|
| B1 | P1 | NFKC 归一化后索引错位，罕见字符会切错片段/高亮 | `shared/search.ts` |
| B2 | P1 | 迁移/导出任务的"互斥"只写在注释里，并发会互相踩 | `main/jobs.ts` |
| B3 | ✅ 已关闭 | 在线更新整体移除（安装包分发），见 ADR 0007 | — |
| B4 | P2 | 清空检索后预览对话框仍开着、仍按旧词高亮 | `stores/ui.ts`、`Shell.tsx` |
| B5 | P2 | 自动保存会让刚点选的月份聚焦失效 | `features/search/SearchPane.tsx` |
| B6 | P3 | 50 字关键词上限只做在 UI 层 | `app/Shell.tsx` |
| B7 | P3 | 10 个无参 IPC 通道没有 validator（实际无害） | `shared/ipc.ts` |
| B8 | P3 | 至少 10 处用户可见文案绕过 `copy` 集中管理 | 渲染层 |
| D1–D9 | ✅ 已修复 | 重复实现（`escapeHtml`、两个 `searchEntries`、三套摘要、高亮 CSS…） | 见 §3（2026-11-09 归一化） |
| U1–U3 | P3 | 死导出 28 个、`copy` 未用键 79 个、未用依赖 2 个 | 见 §4 |

---

## 2. 潜在 bug

### B1 · NFKC 归一化后索引错位（P1）

- **位置**：[`src/shared/search.ts`](../src/shared/search.ts) 的 `highlightSegments()`（L121）、`mergedMatches()`（L244）、`buildSnippets()`（L267）
- **根因**：在 `normalizeText()`（NFKC + 小写）后的字符串上找下标，却用这个下标去切**原文**。NFKC 可能改变长度（`㍿`→`株式会社` 1→4、`ﬁ`→`fi` 1→2、`①`→`1` 长度不变）。
- **现象**：`㍿abc` 搜 `abc` —— 归一化后下标为 4，原文只有 4 个字符 → 片段切出空串、高亮丢失。实测已确认。
- **影响面**：检索片段与预览高亮（列表、证据行、预览对话框三处共用同一函数）；普通中文/英文不受影响。
- **建议修法**：归一化后若 `normalized.length !== text.length`，退回长度不变的 `text.toLowerCase()` 做匹配（全角字母长度不变，仍能命中）。
- **验证**：单测新增 `analyzeSearch([entry('…㍿abc…')], 'abc')` 断言片段包含命中；`highlightSegments('㍿abc','abc')` 至少一个 `match` 段。

### B2 · 任务互斥未真正生效（P1）

- **位置**：[`src/main/jobs.ts`](../src/main/jobs.ts) `create()`（L35）、`isBusy`/`activeJobId`（L27–33）
- **根因**：注释写着"迁移/导入/导出互斥"，但 `create()` 直接覆盖 `busyJobId`，不拒绝也不排队；`isBusy`/`activeJobId` **全项目没有任何调用**（死代码）。
- **现象**：同时启动两个迁移/导出时，前一个结束时不会清空 `busyJobId`（它已指向后一个）；staging 目录可能被两条流程同时改写。
- **建议修法**：`create()` 里若 `kind !== 'attachment'` 且 `busyJobId` 存在 → 抛 `AppError('BUSY', '有任务在进行中，请稍候')`；IPC 层把它转成友好提示；为 `jobs` 补单测（连续 create 第二次应失败）。
- **验证**：单测覆盖；手测：打开两个迁移对话框（一个在导入时点另一个导出）应提示"有任务在进行中"。

### B3 · ~~更新流程断头~~（已关闭）

**结论**：本项目**不支持在线更新**，只做安装包分发，因此整条更新链路被移除（ADR 0007）：
`updater.ts`、`electron-updater`、`app:checkForUpdates`、`update:status`、菜单「检查更新…」
与 `UPDATE_UNAVAILABLE` 错误码全部删除；版本号同时定为 `1.0.0`，升级方式为下载新安装包覆盖安装。

### B4 · 预览对话框与检索词解耦（P2）

- **位置**：[`src/renderer/src/stores/ui.ts`](../src/renderer/src/stores/ui.ts) `searchPreviewDate`；[`src/renderer/src/app/Shell.tsx`](../src/renderer/src/app/Shell.tsx) 的 `clearAndLeave()`
- **现象**：打开预览对话框后按 Esc 清空检索，对话框仍开着，且仍按旧 query 高亮；此时检索结果已清空。
- **建议修法**：`clearSearch()`（或 Shell 的 `clearAndLeave`）里顺带 `closeSearchPreview()`；`query` 变化时也关闭。
- **验证**：e2e 增加"打开预览 → 清空检索 → 对话框消失"。

### B5 · 月份聚焦被自动保存重置（P2）

- **位置**：[`src/renderer/src/features/search/SearchPane.tsx`](../src/renderer/src/features/search/SearchPane.tsx) 的 `useEffect(() => setSelectedBucket(null), [analysis])`
- **现象**：`analysis` 依赖 `entries`；后台保存或别处写入条目时 `entries` 数组变化 → 刚点柱子选中的月份被清空。
- **建议修法**：依赖改成 `[query]`（或 `[analysis?.query]`），只在换检索词时清除。
- **验证**：手测「点柱子 → 在编辑器里改别的日记并等自动保存 → 返回检索视图，选中月份仍在」。

### B6 · 50 字关键词上限只在 UI 层（P3）

- **位置**：[`src/renderer/src/app/Shell.tsx`](../src/renderer/src/app/Shell.tsx) 的 `commit()`
- **现象**：`commitSearch()` 自身不截断，其它入口（测试、将来新增的调用方）可绕过；提示文案也只在这一处。
- **建议修法**：截断与提示入口收敛到 store 的 `commitSearch()`（返回被截断的标志，UI 负责 toast）。
- **验证**：单测直接调 `commitSearch('x'.repeat(80))` 断言 `searchQuery.length === 50`。

### B7 · 无参 IPC 通道缺 validator（P3，实际无害）

- **位置**：[`src/shared/ipc.ts`](../src/shared/ipc.ts)
- **清单**：`app:bootstrap`、`app:openDiaryDir`、`attachment:addFromDialog`、`prefs:read`、`stats:storage`、`theme:changed`、`vault:lock`、`vault:locked`、`vault:snapshot`
- **说明**：全部是无参数通道（或只读事件），缺失不影响安全；与"所有通道都校验"的约定不一致。
- **建议修法**：给无参通道补 `z.undefined()`（或 `z.object({}).strict()`），让校验表与契约表一一对应；可加一个"契约/校验表键集合相等"的单测。

### B8 · 用户可见文案绕过 `copy`（P3）

| 位置 | 文案 |
|---|---|
| [`AccountDialogs.tsx:164`](../src/renderer/src/features/preferences/AccountDialogs.tsx#L164) | 日记密码 |
| [`AccountDialogs.tsx:246`](../src/renderer/src/features/preferences/AccountDialogs.tsx#L246) | 扫描中… |
| [`JumpToDateDialog.tsx:37`](../src/renderer/src/features/calendar/JumpToDateDialog.tsx#L37) | 日期不合法 |
| [`JumpToDateDialog.tsx:61`](../src/renderer/src/features/calendar/JumpToDateDialog.tsx#L61) | 跳转 |
| [`JumpToDateDialog.tsx:66`](../src/renderer/src/features/calendar/JumpToDateDialog.tsx#L66) | 日期 |
| [`Lightbox.tsx:63`](../src/renderer/src/features/attachments/Lightbox.tsx#L63) | 音频 |
| [`Lightbox.tsx:74`](../src/renderer/src/features/attachments/Lightbox.tsx#L74) | 这个文件不能预览，可以直接另存为。 |
| [`Lightbox.tsx:79`](../src/renderer/src/features/attachments/Lightbox.tsx#L79) | 已加密 |
| [`MigrationImportDialog.tsx:226`](../src/renderer/src/features/migration/MigrationImportDialog.tsx#L226) | 包含可移植偏好设置 |

- **建议修法**：挪进 `copy`（与现有"所有文案集中"的约定一致）。

---

## 3. 重复实现（P3）—— 已于 2026-11-09 全部归一化

> 处理结果见每行「处理」列；新增的共享模块：`src/shared/text.ts`（文本匹配/片段）、
> `src/shared/limits.ts`（跨进程阈值）、`src/renderer/src/styles/_hitMark.scss`（命中高亮 mixin）。

| 编号 | 位置 | 情况 | 处理 |
|---|---|---|---|
| D1 | [`shared/markdown.ts:12`](../src/shared/markdown.ts#L12)、[`main/export/index.ts:140`](../src/main/export/index.ts#L140)、[`main/export/pdf.ts:154`](../src/main/export/pdf.ts#L154) | `escapeHtml` 三份，后两份与第一份逐字符相同 | 主进程两处改为 `import { escapeHtml } from '@shared/markdown'`，本地副本删除 |
| D2 | [`shared/date.ts:70`](../src/shared/date.ts#L70) / [`:77`](../src/shared/date.ts#L77) | `startOfIsoWeek` 与 `startOfWeek` 实现完全一样，前者无人调用 | 删除 `startOfIsoWeek`（与 `startOfWeek` 完全重复且无人使用） |
| D3 | [`shared/search.ts:74`](../src/shared/search.ts#L74) / [`:369`](../src/shared/search.ts#L369) | `searchEntries` 与 `analyzeSearch` 两套"分词 + 标题/正文/标签"匹配；列表与洞察已统一用后者，`searchEntries` 只剩测试引用 | 删除 `searchEntries` / `SearchHit`；列表与洞察统一用 `analyzeSearch`，原「标题优先」用例改为断言命中集合 |
| D4 | [`search.ts:59`](../src/shared/search.ts#L59)、[`:267`](../src/shared/search.ts#L267)、[`words.ts:39`](../src/shared/words.ts#L39) | 三套摘要：`buildSnippet`（旧搜索）、`buildSnippets`（洞察）、`makeSnippet`（列表） | `plainText` / `previewSnippet` / `buildSnippets` / `highlightSegments` 全部收进 `shared/text.ts`；`words.makeSnippet` 改为调用 `previewSnippet` |
| D5 | [`search.ts:43`](../src/shared/search.ts#L43) / [`words.ts:46`](../src/shared/words.ts#L46) | `deriveLocalTitle` 与 `deriveTitle` 逻辑重复 | 删除 `deriveLocalTitle`，改为 `hitTitle()` 复用 `words.deriveTitle` |
| D6 | [`search.ts:121`](../src/shared/search.ts#L121) / [`:244`](../src/shared/search.ts#L244) | 两套"区间合并"（`highlightSegments` / `mergedMatches`） | 合并区间逻辑抽成 `text.findRanges()` + `mergeRanges()`，高亮与片段共用 |
| D7 | [`main/attachments/store.ts:40`](../src/main/attachments/store.ts#L40) / [`EditorPane.tsx:34`](../src/renderer/src/features/editor/EditorPane.tsx#L34) | 300MB 大文件阈值两份，主进程那份完全没用 | 新增 `shared/limits.ts`：`LARGE_FILE_CONFIRM_BYTES` / `PASTE_IMAGE_MAX_BYTES`；store 里的重复常量删除 |
| D8 | [`schemas.ts:109`](../src/shared/schemas.ts#L109) + 3 处 UI | 密码"至少 8 位"校验与文案重复 4 次 | `schemas.PASSWORD_MIN_LENGTH = 8`，建库/改密/导出私钥三处校验改用它 |
| D9 | [`list.module.scss:172`](../src/renderer/src/features/entry-list/list.module.scss#L172)、[`search.module.scss:268`](../src/renderer/src/features/search/search.module.scss#L268)、[`styles/markdown.scss:2`](../src/renderer/src/styles/markdown.scss#L2) | 命中高亮样式三处（`.hit` / `.mark` / `mark.mdHit`+`.cmHit`） | 新增 `_hitMark.scss` mixin；React 侧统一 `mark.hitMark`，CodeMirror 装饰层类名保留但复用同一 mixin |

---

## 4. 无用代码（P3）

### U1 · 死导出（18 个，完全无引用；2026-11-09 又清掉 8 个）

| 模块 | 导出 |
|---|---|
| `src/main/attachments/format.ts` | `uuidBytesToHex` |
| `src/main/core/zip.ts` | `createByteCounter`、`ensureWritableDirectory` |
| `src/main/export/dayOneTxt.ts` | `dayOneTxtPreview` |
| `src/main/vault/crypto.ts` | `bytesToUuid`、`constantTimeEqual`、`hmacSha256`、`uuidToBytes` |
| `src/main/vault/format.ts` | `CipherBlock`、`VAULT_FILE_NAME` |
| `src/main/vault/paths.ts` | `assertPathInside`、`isManagedAttachmentName`、`statOrNull` |
| `src/main/window.ts` | `forgetWebContents` |
| `src/shared/ipc.ts` | `Unwrapped` |


### U2 · ~~`copy` 未被引用的键~~（已清零，2026-11-09）

两轮清理（文案精简 + 本次死键删除）后，`copy.ts` 里 **0 个**未被引用的键（346 个全部有静态引用）。
删除的 68 个键里，一批描述的是从未实现的功能（自动保存间隔、重试按钮、删除撤销、统计错误提示…）；
其中三处按"功能修复"接上了界面：附件另存为的「已导出到 …」、统计存储失败提示、批注引文丢失提示。

### U3 · 未使用的依赖

- `date-fns`（源码/脚本零引用，日期逻辑都是自写的）
- `eslint-plugin-react-refresh`（`eslint.config.mjs` 未引用）
- `@vitest/coverage-v8`：只在手动 `vitest --coverage` 时用到；如果从不跑覆盖率可以移除

---

## 5. 检索迭代的已知取舍（不算 bug，先记着）

1. **子串匹配的误报**：「感冒」会命中「感冒药」「感冒好了」——片段能让人自己判断语境，属于产品取舍。
2. **标签命中计入篇数但没有正文片段**：证据行只显示日期（没有可高亮的正文）。
3. **不落盘全文索引**：解锁后在内存中分析，锁定即销毁；> 5000 篇时才需要重新评估。
4. **年份配色按出现顺序轮换**：超过 6 个年份会重复同一色系（`YEAR_TONES` 长度 6）。
5. **时间线按年聚合时**：点某根年柱会把日历切到该年 1 月。
6. **预览对话框元信息仍显示「n 天前 / 字数」**：与列表徽标不同，是有意保留（PRD 的对话框 meta 要求）。
7. **`analyzeSearch` 的 `streakOf`（连续段）仍计算但不展示**：界面上已无徽标，留着供以后使用。

---

## 6. 建议的修复顺序

| 批次 | 内容 | 说明 |
|---|---|---|
| 第一批 | B1（NFKC）、B2（任务互斥） | 两个 P1，先做；都各自补单测 |
| 第二批 | B4、B5、B6 | B3 已随在线更新移除而关闭 |
| 第三批 | D1–D9 + U1–U3 | 纯清理；建议单独一个 `chore:` 提交，便于回滚 |
| 随行 | B7、B8 | 顺手做，量很小 |

每批验收口径一致：

```bash
pnpm verify                 # typecheck + lint + 单测 + 组件测试 + build
pnpm exec playwright test   # 4 条 e2e（app / migration / merge / search）
```

---

## 7. 本次审计的扫描方法（可复跑）

| 目标 | 做法 |
|---|---|
| 死导出 | 正则收集 `export (const\|function\|interface\|type\|class)` 名称，统计跨文件 ```\bName\b``` 引用（含 `tests/`），0 引用即死 |
| 未使用本地变量 | `pnpm exec tsc -p tsconfig.node.json --noEmit --noUnusedLocals`（web 同理）——当前 0 报错 |
| 未使用文案 | 解析 `copy` 对象路径，检索 `copy.<path>` 字面引用 |
| 未使用依赖 | 遍历 `package.json` 依赖名，在 `src/`+`scripts/`+配置文件里检索 |
| 重复实现 | 按函数名/函数体比对 + 人工核对（`escapeHtml`、日期工具、搜索匹配、摘要、阈值、密码校验、高亮 CSS） |
| 潜在 bug | 针对"归一化/索引、并发、事件订阅、状态耦合、边界截断"逐项走读并做最小复现 |

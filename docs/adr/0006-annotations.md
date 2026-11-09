# ADR 0006：批注——历史不可改，但可以补充

- 状态：已采纳
- 日期：2026-11-07
- 决策者：项目所有者
- 关联：`ANNOTATION-PRD.md` v1.0、原型 `prototype-v2.html`（`#annot` 系列）
- 影响：存储格式（新增文件与 vault 字段）、写权限规则、IPC 契约、迁移包成员

## 背景

产品铁律是「只能写今天」。在此之前，应用允许修改任意日期的正文/标题/附件，历史与今天的边界并不存在。
批注功能的前提正是**历史正文不可改**：它是与正文平行的第二条记录流，只增不改不删。

实现前确认了两个决定（用户拍板）：

1. **严格执行可写性铁律**：历史正文/标题/附件只读；
2. **按 PRD 全量交付**：批注栏 + 锚点 + 空日期批注 + 日历红点 + 列表角标 + 迁移包。

## 决策

### 1. 可写性（主进程强制）

| 日期 | 正文/标题/附件 | 批注 |
|---|---|---|
| 今天 | 可写 | 可加 |
| 未来（`allowFutureEntries` 打开） | 可写 | 不可加（批注只针对已发生的日子） |
| 历史（有正文/空日期） | **只读** | 可加（空日期为整篇批注） |

- 判定收敛到 `src/shared/writeGuard.ts` 的 `isWritableDate()`，`entry:save` / `entry:delete` 在主进程校验；
- 渲染层的只读态与空日期「已封存」CTA 只是体验层；
- **测试/演示通道**：环境变量 `MINIDIARY_ALLOW_HISTORY_WRITE=1` 放行历史写入（e2e 夹具、`seed-demo` 使用）。
  它不影响产品逻辑，只用于造数据；正式使用不会设置它。

### 2. 存储：`annotations/<YYYY-MM-DD>.ann`

```
行 1:  INKANN1
行 n:  base64( nonce(12B) ‖ tag(16B) ‖ AES-256-GCM(record_json) )
AAD:   ann:{date}:{行号}
key:   HKDF(DEK, salt=vaultId, info='annotation-v1')   // 与附件、payload 各自独立
```

- `record = { id, date, quote, tag, body, at, createdAt }`；`quote=''` 表示整篇批注（schema 不分支）；
- `id = 'n' + 库内单调序号`，序号存在 vault 的 `annotationSeq`；
- vault 新增 `annotationDigests: { date: sha256(ann 文件) }`，用于发现历史批注被外部篡改；
- **追加写**：读取既有有效记录后**原子重写**整文件（临时文件 + rename）。PRD 写的是纯 append，
  这里改用「读有效记录再原子重写」，牺牲一点写入成本换取"断电半行不会让文件永久损坏"；
- 坏行处理：只有**最后一行**看起来被截断（base64 长度异常或长度过短）时才丢弃，其余解不开即报 `CORRUPT_VAULT`；
- 哈希不符只在解锁时记日志 + `logger.warn`，不阻断进入（避免一个坏文件锁死整库）。

### 3. IPC

```ts
'annotation:add': { req: { date, quote, tag, body }, res: { annotation, annotations, revision } }
```

- **没有 update / delete 通道**——append-only 落在契约里，而不是靠 UI 自觉；
- `vault:snapshot` 增加 `annotations`，解锁/导入/重置后随快照下发；
- 主进程校验：日期 ≤ 今天、quote ≤ 90、tag 去 `#`/trim/≤24、body 非空且 ≤ 100000 字。

### 4. 渲染层

- **批注栏**位于正文右侧：历史日期恒显示（含空态），今天仅在有批注/编辑中时出现；展开编辑区时 326→384px；
- **锚点**：预览模式用 rehype 插件把引文包成 `<mark class="ann-mark" data-ann-id>`；
  源码模式用 CodeMirror `Decoration.mark({ class: 'cmAnn' })`；两边点击都跳到卡片，卡片点击滚动到锚点；
- **选中浮条**：预览用 `window.getSelection()`，源码用 `EditorHandle.getSelection()`（选区文本 + rect）；
- **空历史日期**：显示「已封存 · 不可新增正文」+「给这一天加批注」，保存后日历该日变红点；
- **日历**：绿点=有日记，红点=仅批注；悬停提示带条数；
- **列表**：有批注的行显示「批注 n」角标；
- **状态栏**：历史显示「只读 · 批注 n 条」（无正文时「只读 · 无正文 · 批注 n 条」）。

### 5. 迁移包

- 包内新增 `annotations/<date>.ann` 成员（计入 manifest 的 `annotationCount` 与 `checksums.sha256`）；
- 导出时按文件原样复制，不解密、不重加密；
- 导入：
  - 整库接管（全新/锁定替换）：批注文件直接随 staging 切换，密钥一致；
  - 原地替换：用目标密钥重新加密写回，旧批注目录整体进回滚点；
  - 合并：保留目标已有批注，包内记录**重排 id** 后续接（避免 `n1` 撞车），再整体重写文件并更新 digest / `annotationSeq`；
- 导入完成后 `repository.reloadAnnotations()` 重新载入内存，快照里能看到新批注。

## 兼容性

- 旧库没有 `annotationSeq` / `annotationDigests`：按 0 / 空处理，下次写入批注时补齐；
- 旧迁移包没有 `annotations/`：导入后批注为空，正常可用；
- 迁移包格式仍只接受 `packageFormat = 2`（见 ADR 0004），本次没有再加格式版本；
- 已有条目的正文/标题/附件结构未变，批注完全独立存放。

## 后果与偏差

- **历史不可编辑**是行为级变更：之前「翻到旧日记改错字」的用法不再可用，改为写批注；
- PRD 的「纯 append-only」改为「原子重写」，理由见 §2；
- PRD 的「哈希失败明确报错并建议恢复」降级为日志告警，避免坏文件锁死整库；
- PDF「含批注」开关按 PRD 顺延，本期不做；
- 批注不进入检索域、不参与统计（PRD 非目标）。

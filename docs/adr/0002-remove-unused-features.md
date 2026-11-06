# ADR 0002：移除「每周第一天」「拼写检查」「旧版 Mini Diary 导入」

- 状态：已采纳
- 日期：2026-11-06
- 决策者：项目所有者
- 关联：`implementation-pipeline-v2.md` 的需求矩阵 C7 / D10 / P2 / P5 / F8

## 背景

v2 流水线来自对标文档，包含了三项在实际使用中不需要的能力：

1. **自定义每周第一天**（A15 / C7 / P2）：日历与统计按 `firstDayOfWeek` 偏好计算；
2. **拼写检查开关**（D10 / P5）：偏好 + Electron session + 编辑器 `spellcheck`；
3. **旧版 Mini Diary 3.3.0 加密文件导入**（F8）：PBKDF2-SHA512 + OpenSSL `EVP_BytesToKey` + AES-192-CBC 的一次性迁移。

产品负责人确认这三项都不需要，要求删除按钮与相关逻辑。

## 决策

| 项 | 处理 |
|---|---|
| 每周第一天 | 固定**周一**开头：`buildCalendarGrid` / `startOfWeek` / `weekdayHeadersCN` 不再接受参数；统计的「每周平均、12 周柱状图、热力图」也统一按周一分组；从 `Preferences` 与迁移包 `prefs.json` 中删除 `firstDayOfWeek` |
| 拼写检查 | 删除偏好、主进程 session 配置与编辑器开关；`webPreferences.spellcheck` 与 CodeMirror `contentAttributes.spellcheck` 固定为 `false`，不再有红波浪线 |
| 旧版导入 | 删除 `src/main/vault/legacy.ts`、`legacy:importPreview` / `legacy:commit` 两个 IPC 通道、设置页入口与对话框；旧库如需迁入，先用旧版导出 JSON，再用「导入 Mini Diary JSON」 |

## 兼容性

- **旧偏好文件**：`preferencesSchema` 默认丢弃未知字段，老 `preferences.json` 仍可读，下次保存时自动去掉这两项，不会报错。
- **旧迁移包**：`prefs.json` 里的多余字段同样被忽略；包内其余内容（vault、附件、校验和）不受影响，仍可正常导入。
- **新迁移包**：`prefs.json` 只包含主题、隐藏标题、允许未来日期、自动锁定四项。

## 后果

- 日历与统计少了一个可配置维度，但代码路径更短：不用再为「周起始」做两套边界推导。
- 编辑器不再有拼写标记，英文单词的拼写检查需要自己留意。
- 旧版用户从 3.3.0 迁移需要多一步（先导出 JSON），旧加密文件不再能直接解密。

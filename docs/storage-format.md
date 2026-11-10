# 存储与加密格式

本文描述 Mini Diary 在磁盘上**实际写入了什么**、每类数据用什么密钥和 AAD 加密、以及解锁/保存/迁移时的生命周期。
面向维护者与安全审查；不包含任何真实密钥。

- 适用范围：`formatVersion = 1`、`schemaVersion = 1`、迁移包 `packageFormat = 2`
- 相关代码：
  - `src/main/vault/format.ts`：信封、KDF、DEK 包裹
  - `src/main/vault/crypto.ts`：scrypt / HKDF / AES-256-GCM
  - `src/main/vault/repository.ts`：读写、解锁、改密、清空
  - `src/main/vault/annotations.ts`：批注文件格式
  - `src/main/attachments/format.ts`：MDAT 容器
  - `src/main/migration/`：迁移包导出/导入

## 0. 一句话结构

```
<日记目录>/
├─ diary.vault                 # 信封：KDF 参数 + 被 KEK 包裹的 DEK + 加密后的全部条目
├─ annotations/
│  └─ 2026-11-09.ann          # 每天一个文件：文件头 + 每行一条独立 AEAD 批注
├─ attachments/
│  └─ <uuid>.mdat             # 分块 AEAD 附件（流式、可 Range）
└─ migration/                  # 导入 staging / 回滚点；staging 与回滚数据均为密文副本
                               # （rollback 的 meta.json 只有 jobId/时间/hasAttachments）
```

只有 `diary.vault` 是必须存在的；`annotations/` 与 `attachments/` 按需创建。目录权限 `0700`，文件 `0600`。

## 1. 密钥层级

```
用户密码
  │  scrypt(N=2^17, r=8, p=1, 16B salt)      ── 128 MiB 内存，约 0.5–1s
  ▼
KEK (32B)
  │  AES-256-GCM 解包 keyWrap
  ▼
DEK (32B，随机生成，永不落盘明文)
  ├─ HKDF-SHA256(salt=vaultId, info="payload-v1")     → 条目 payload 密钥
  ├─ HKDF-SHA256(salt=vaultId, info="attachment-v1")  → 附件主密钥
  │     └─ HKDF-SHA256(salt=fileId, info="mdat-v1")   → 单个附件 fileKey
  └─ HKDF-SHA256(salt=vaultId, info="annotation-v1")  → 批注密钥
```

- 密码先做 Unicode NFC 规范化再交给 scrypt；密码本身不落盘。
- **DEK 是随机生成的**，不是从密码直接派生；改密码只重新包裹 DEK，不重加密 payload/附件/批注。
- 所有 HKDF 都以 `vaultId` 为 salt，`info` 做用途隔离；不同用途的密钥绝不混用。
- `vaultId` 是创建库时生成的 UUID，同时写进信封和 payload。

## 2. `diary.vault`：信封 + 全量 payload

`diary.vault` 是一个 UTF-8 JSON 文件（外层可见字段都是元数据）：

```json
{
  "magic": "MINIDIARY",
  "formatVersion": 1,
  "vaultId": "<uuid>",
  "createdAt": "2026-11-09T...",
  "kdf": {
    "name": "scrypt",
    "N": 131072,
    "r": 8,
    "p": 1,
    "salt": "<base64, 16B>"
  },
  "keyWrap": {
    "alg": "AES-256-GCM",
    "iv": "<base64, 12B>",
    "ciphertext": "<base64, 32B>",
    "tag": "<base64, 16B>"
  },
  "payload": {
    "alg": "AES-256-GCM",
    "iv": "<base64, 12B>",
    "ciphertext": "<base64>",
    "tag": "<base64, 16B>"
  }
}
```

| 字段 | 说明 |
|---|---|
| `magic` | 固定 `MINIDIARY` |
| `formatVersion` | 容器版本，当前 `1`；大于当前版本直接拒绝（`VAULT_VERSION_TOO_NEW`） |
| `vaultId` | 库 UUID，参与 HKDF |
| `kdf` | scrypt 参数与 salt（明文，必须可读才能派生 KEK） |
| `keyWrap` | `AES-256-GCM(KEK, DEK)` |
| `payload` | `AES-256-GCM(payloadKey, JSON(VaultData))` |

### AAD

```
keyWrap:  MINIDIARY|keyWrap|1|scrypt|<N>|<r>|<p>|<salt base64>
payload:  MINIDIARY|payload|1|<vaultId>
```

`keyWrap` 的 AAD 绑定全部 KDF 参数：改 salt/迭代次数会让 DEK 解包失败（不会被误当成“密码错误”之外的状态）。
错误密码与密文损坏在解锁时统一报 `WRONG_PASSWORD`，不区分是哪一步失败。

### payload 明文结构（`VaultData`）

```ts
{
  schemaVersion: 1,
  vaultId: string,
  createdAt: string,
  updatedAt: string,
  entries: DiaryEntry[],
  annotationSeq?: number,                  // 已分配的最大批注序号
  annotationDigests?: Record<date, sha256> // 每个 .ann 文件整体字节的哈希
}
```

`DiaryEntry`：

```ts
{
  date: 'YYYY-MM-DD',     // 唯一键
  title: string,          // ≤500
  body: string,           // Markdown 源码
  tags: string[],         // 小写、去重、不含 #
  attachments: Attachment[],
  wordCount: number,      // 缓存值
  createdAt: string,
  updatedAt: string
}
```

`Attachment`（**元数据在 vault 里，二进制在 `.mdat`**）：

```ts
{
  id: string,             // UUID v4，文件名 & attachment:// 的 ID
  name: string,           // 原始文件名，仅展示，不参与路径拼接
  mime: string,
  kind: 'image' | 'audio' | 'video' | 'file',
  size: number,           // 明文字节数
  sha256: string,         // 明文 SHA-256
  chunkSize: number,      // 默认 1 MiB
  totalChunks: number,
  createdAt: string
}
```

### 保存语义

- 每次保存（`persist`）都用**同一个 DEK**、**新的随机 IV** 重新加密**整个 `VaultData`**，然后原子替换 `diary.vault`。
- 因此：单次文件大小只由条目内容决定；但**每次保存都会产生一份全新的密文**（随机 IV），不同版本之间无法做 delta 压缩。
- 写入顺序：临时文件 `diary.vault.tmp-<pid>-<time>` → `fsync` → `rename` → `fsync` 目录；失败不会留下半截 vault。
- `revision` 是进程内计数器，不写盘；重启/重新解锁后从 0 重新计。

## 3. 批注：每天一个 `.ann`，每行独立 AEAD

```
annotations/2026-11-09.ann
第 1 行: INKANN1
第 2 行: base64( nonce(12B) || tag(16B) || ciphertext )
第 3 行: base64( nonce(12B) || tag(16B) || ciphertext )
...
```

- 密钥：`annotationKey = HKDF(DEK, salt=vaultId, info="annotation-v1")`。
- 每行明文是一个 `Annotation` 的 JSON；单条 AEAD 加密，使用随机 12B nonce。
- **AAD = `ann:<date>:<lineNumber>`**（行号从 1 开始，对应文件中的记录行）。把记录挪到别的日期或别的行号就解不开。
- id 为 `n<seq>`，`seq` 由 vault 里的 `annotationSeq` 单调分配；导入合并时通过 `renumberAnnotations` 重排，避免两库的 `n1` 撞车。
- 追加一条批注时：先解密并读取当天全部有效记录 → 重新序列化整份文件 → 写 `.tmp` → `rename`；也就是说**追加会重写整个 `.ann` 文件**（文件很小）。
- `annotationDigests[date] = sha256(.ann 文件整体字节)` 存在 vault 里；解锁时逐日比对，不一致只记日志、不阻断解锁（历史批注被外部篡改时可见）。
- 解析时只容忍“最后一行被截断”的断电场景；长度完整但解不开视为篡改，报 `CORRUPT_VAULT`。

## 4. 附件：MDAT v1 分块 AEAD

路径：`attachments/<uuid>.mdat`，文件名就是 `Attachment.id`。写入先写 `<uuid>.mdat.part`，完成后 `rename`。

### 4.1 文件头（64 B）

| 偏移 | 长度 | 字段 |
|---:|---:|---|
| 0 | 4 | magic `MDAT` |
| 4 | 1 | version `1` |
| 5 | 1 | flags（当前 0） |
| 6 | 2 | headerSize `64`（大端） |
| 8 | 16 | fileId（UUID 原始 16 字节） |
| 24 | 4 | chunkSize（默认 1 MiB） |
| 28 | 4 | totalChunks |
| 32 | 8 | plaintextSize（大端） |
| 40 | 8 | noncePrefix（随机） |
| 48 | 16 | headerTag：`HMAC-SHA256(fileKey, header[0..48])` 截断 16B |

### 4.2 分块

```
nonce = noncePrefix(8B) || uint32BE(chunkIndex)
AAD   = header[0..48] || uint32BE(chunkIndex) || uint32BE(chunkPlainLength)
密文  = AES-256-GCM(plaintextChunk) || 16B tag
```

- `fileKey = HKDF-SHA256(attachmentKey, salt=fileId(16B), info="mdat-v1")`
- 每个分块独立 AEAD；文件总大小 `64 + plaintextSize + totalChunks * 16`。
- 分块设计是为了：2 GB 视频不整体读入内存、视频 seek 可只解密目标块、Range 请求可只解所需块。
- 选择 `chunkSize` 时最大允许 16 MiB；读取时校验 `totalChunks` 与 `plaintextSize` 一致、分块长度与头部一致。
- 附件大小上限（`SIZE_LIMITS`）：图片 50 MB、音频 500 MB、视频/普通文件 2 GB。

### 4.3 读取代理

渲染进程不直接读文件，只通过 `attachment://<uuid>`：

- 未解锁 → `423`
- 未知 id → `404`
- 合法单区间 Range → `206`，`Content-Range` 正确
- 非法 Range → `416`
- 响应头 `Cache-Control: no-store`
- 锁定/退出时中止所有进行中的流

### 4.4 附件与条目的关系

- 条目只保存附件**元数据**；没有独立的附件表。
- 删除条目/移除附件引用后，`.mdat` 文件可能暂时成为“未被引用”；「清理未引用附件」按“vault 里是否有元数据”判断。
- 迁移包导出时附件密文原样复制，不解密、不重新加密。

## 5. 偏好与日志（明文，但不含内容）

### `preferences.json`

位置：`app.getPath('userData')/preferences.json`：

- macOS：`~/Library/Application Support/Mini Diary/`
- Windows：`%APPDATA%\Mini Diary\`
- Linux：`~/.config/Mini Diary/`

内容仅本机路径与界面开关：`version`、`theme`、`hideTitle`、`allowFutureEntries`、`autoLockMinutes`、`diaryDir`、`lastOpenedDate`、`lastImportDir`、`lastExportDir`、`sidebarCollapsed`、`listWidth`、`annotationCollapsed`、`attachmentPreviewMode`。

- **不存密码、DEK、子密钥或令牌**；
- 原子写入（临时文件 + rename），避免半截 JSON 让应用起不来。

### 日志

`electron-log` 默认目录（macOS `~/Library/Logs/Mini Diary/`）。日志只记录技术事实：数量、字节数、jobId、错误码；**不记录密码、密钥、正文、附件内容或原始文件名**。

## 6. 迁移包 `.minidiary`（`packageFormat = 2`）

ZIP64 容器，成员：

```
manifest.json
vault.inkv
prefs.json
annotations/YYYY-MM-DD.ann      （可选，逐日）
attachments/<uuid>.mdat         （可选，逐个）
checksums.sha256                （必须是最后一个成员）
```

### 6.1 两把“钥匙”

- **公钥**：应用随机生成的 128 字符（56 符号表，约 743 bit 熵），只展示给用户，**不写进包、不保存**；
- **私钥**：用户设置的迁移包密码；
- 真正参与 KDF 的口令是 `MINIDIARY|pkgkey-v1|<公钥>|<密码>`（大小写敏感）。

导出时只做一件事：用这个组合口令**重新包裹 DEK**，payload、批注、附件密文全部保持不变：

```ts
vault.inkv = rewrapEnvelope(原信封, DEK, composePackageSecret(packageKey, packagePassword))
```

所以包被拿走但缺公钥/密码任一项，都无法解开 DEK；导入时统一报“公钥或私钥不正确”，不透露是哪一半错。

### 6.2 明文部分

- `manifest.json`：`packageFormat`、`appVersion`、`createdAt`、`formatVersion`、`schemaVersion`、`vaultId`、`entryCount`、`attachmentCount`、`annotationCount`、`totalAttachmentBytes`、`firstDate`、`lastDate`、`hasPreferences`。
  这些是**明文**（数量、日期范围、总字节数），但不含标题/正文。
- `prefs.json`：只含 `theme`、`hideTitle`、`allowFutureEntries`、`autoLockMinutes`。
- `checksums.sha256`：每个成员的 SHA-256（附件是**密文**哈希），格式 `<sha256>  <member>`。

### 6.3 导入时的两种模式

| 模式 | 条件 | 行为 |
|---|---|---|
| `replace`（接管） | 没有库 / 库被锁定 | 采用包内 `vaultId` 与 DEK；附件密文原样复制；批注用包内密钥重写；vault 用用户新密码重新包裹；staging 校验后原子切换 |
| `merge`（合并） | 目标库已解锁 | 每个附件生成新 UUID，正文里的 `attachment://` 同步改写；附件先解密再用**目标 DEK** 重新加密；批注重排 id 并用目标密钥重写；条目按“导入合并”语义合并（标题 `旧 \| 新`、正文 `---` 拼接、标签/附件并集） |

导入全程在 `migration/staging-<jobId>/` 中完成，校验通过后才切换；失败保留原库并回滚。

## 7. 生命周期

### 创建

1. 生成随机 `vaultId`、随机 DEK；
2. scrypt 派生 KEK，包裹 DEK；
3. 用 `payload-v1` 密钥加密空 `VaultData`；
4. 原子写 `diary.vault`，创建目录。

### 解锁

1. 读 `diary.vault`，解析信封；
2. scrypt 派生 KEK，解包 DEK（失败统一 `WRONG_PASSWORD`）；
3. 用 `payload-v1` 解密 payload，Zod 校验 `VaultData`；
4. 派生附件/批注密钥，载入 `annotations/*.ann`，比对 digests；
5. 返回不含密钥的 `VaultSnapshot` 给渲染进程。

### 保存条目

- 只写 `diary.vault`：更新 `entries` / `updatedAt` → 重新加密整个 `VaultData` → 原子替换；
- 批注另走 `annotations/<date>.ann`；
- 附件另走 `.mdat`。

### 修改密码

- 验证旧密码；
- 新 salt + 新 scrypt 参数派生新 KEK；
- 只重新包裹 DEK，payload/附件/批注密文全部不变；
- 先建回滚点，失败回滚。

### 清空全部日记

- 清空 `entries`、`annotationSeq`、`annotationDigests`；
- 删除 `attachments/` 与全部 `.ann`；
- `vaultId`、DEK、密码保持不变（因此旧附件密文仍能被同一 DEK 解开，只是文件已被删除）。

### 锁定

- 清零 DEK、附件密钥、批注密钥；
- 清空内存中的 `data`/`annotations`/`envelope`；
- 不写盘。

## 8. 威胁模型与已知边界

### 已保护

- 正文、标题、标签、附件内容、批注内容不以明文落盘；
- DEK 不以明文落盘；跨 IPC 不传密钥；
- 附件流式加解密，不把整个附件读入内存；
- 密码错误与密文损坏统一错误，减少 oracle；
- 迁移包需要“公钥 + 密码”两因素才解得开 DEK。

### 仍可见（元数据）

- `diary.vault` 存在、大小、修改时间；
- `vaultId`、`createdAt`、scrypt 参数与 salt；
- `annotations/YYYY-MM-DD.ann` 的**文件名**（哪些天有批注）与文件大小；
- `attachments/<uuid>.mdat` 的数量、单文件大小（约等于明文大小 + 16B/块 + 64B 头），但文件名是随机 UUID，不泄漏原始文件名；
- 迁移包 `manifest.json` 的条目数、附件数、批注数、总字节数、首末日期；
- `preferences.json` 中的本机路径与界面开关；
- 日志中的技术计数与错误码（不含内容/文件名）。

### 不承诺

- 不防“解锁状态下”的内存抓取、调试器、恶意软件或键盘记录；
- 不提供密码找回：忘记密码且没有迁移包 = 数据不可恢复；
- 不隐藏“库存在/大小/修改时间”这类文件系统元数据；
- 批注 digest 不一致只告警，不自动阻断（否则外部改一个字节就会让用户打不开库）。

## 9. 版本与兼容

| 常量 | 当前值 | 行为 |
|---|---|---|
| `formatVersion` | 1 | 大于当前值 → `VAULT_VERSION_TOO_NEW` |
| `schemaVersion` | 1 | 大于当前值 → `VAULT_VERSION_TOO_NEW` |
| `packageFormat` | 2 | 小于 2（旧版无公钥包）→ `PACKAGE_VERSION_UNSUPPORTED`；大于 2 → 提示升级应用 |

新增字段一律 optional（如 `annotationSeq`、`annotationDigests`），旧库可以继续打开；修改容器结构必须升 `formatVersion` 并提供迁移/双读。

## 10. 对 git 同步的影响（背景）

- `diary.vault` 每次保存都是**整份 payload 的新密文**（随机 IV），git 无法做 delta 压缩；仓库增长 ≈ 同步次数 × 当时 vault 大小 × 约 0.75（base64 开销）。
- 批注每天一个文件，追加会重写该日文件；单文件很小。
- 附件不进入文本同步；若未来同步附件，需要 LFS 或独立的二进制同步通道。
- 这也是讨论“按条目拆分为 `entries/<date>.ink`”的原因：把“全量快照”变成“只改当天密文”，代价是格式、迁移和原子性的改造。
- 当前实现采用「同步镜像」而不是改本地格式：见 [Git 同步](sync.md)。

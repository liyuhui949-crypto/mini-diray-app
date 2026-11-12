---
title: 下载
---

# 下载

当前只提供 **macOS Apple Silicon（arm64）** 版本，版本号 `1.0.0`。

[下载 Mini Diary 1.0.0（.dmg）](https://github.com/liyuhui949-crypto/mini-diray-app/releases/latest)

- 文件：`Mini Diary-1.0.0-arm64.dmg`
- 大小：约 117 MB
- 适用：Apple Silicon Mac（M1/M2/M3/M4 等）
- 暂不提供 Intel Mac、Windows、Linux 安装包

SHA-256：

```text
9066c709d50484777a034738dcaf56429d0d450dd9a99e27fc589cede05a04fc
```

可以在终端校验：

```bash
shasum -a 256 ~/Downloads/Mini\ Diary-1.0.0-arm64.dmg
```

## 安装

1. 下载 `.dmg`；
2. 双击打开；
3. 把 **Mini Diary** 拖到「应用程序」；
4. 从「应用程序」启动。

## 为什么 macOS 可能拦截

这个版本**没有 Apple Developer ID 签名，也没有经过 Apple 公证（notarization）**。

当前是 ad-hoc 签名，只用于避免应用包自身签名损坏；它不能替代 Developer ID，也不能消除 Gatekeeper 的警告。

因此 macOS 可能提示：

- 「无法验证开发者」
- 「Apple 无法验证此 App 是否包含恶意软件」
- 或「已损坏，无法打开」

这不是因为应用一定有问题，而是因为系统无法通过 Apple 的签名/公证链确认发布者。

## 打开方式

先尝试：

```text
右键点击 Mini Diary.app → 打开 → 仍要打开
```

如果仍被拦截：

```text
系统设置 → 隐私与安全性 → 仍要打开
```

如果提示「已损坏」，可以移除下载隔离标记：

```bash
xattr -dr com.apple.quarantine "/Applications/Mini Diary.app"
```

然后重新打开。

不建议为了一个应用关闭整个系统的 Gatekeeper。

## 没有开发者账号带来的限制

- **没有公证**：首次打开会遇到 Gatekeeper 提示；
- **没有 Developer ID**：系统无法显示可信发布者；
- **没有 App Store 上架**：不能通过 App Store 安装或更新；
- **没有自动更新**：新版本需要手动下载替换；
- **macOS 版本兼容性**没有经过 Apple 的完整分发验证；
- **企业/学校管理的 Mac** 可能直接禁止运行未签名应用；
- 某些 macOS 版本对 ad-hoc 应用的限制可能更严格。

这些限制不影响应用本身的本地加密、日记读写和 Git 同步逻辑，但会影响首次安装和系统信任体验。

## 安全说明

- 应用不联网、不需要账号；
- 源码公开，可以自行审查或从源码构建；
- 如果不信任预编译包，请按 README 的「快速开始」自行构建；
- 校验 SHA-256 后再安装；
- 不要从非官方地址下载。

## 后续

如果之后获得 Apple Developer 账号，可以补上：

1. Developer ID Application 签名；
2. Apple 公证；
3.  stapling；
4. 自动更新。

在这些完成之前，Release 页面会持续标注「未签名/未公证」。

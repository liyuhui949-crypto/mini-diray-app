# ADR 0007：只做安装包分发，不做在线更新；版本定为 1.0.0

- 状态：已采纳
- 日期：2026-11-09
- 决策者：项目所有者
- 关联：`implementation-pipeline-v2.md` N5 / P13、`known-issues.md` B3

## 背景

流水线早期按「正式包可用 electron-updater 检查/下载/安装」规划了在线更新（N5、P13）。
实际交付形态是**离线优先的本地日记**：用户从安装包安装，应用不做任何网络请求。
在线更新不仅用不上，还带来两处问题：

1. 需要维护 `publish` 配置与 GitHub Releases 的发布链路，增加了「应用会联网」的疑问；
2. 代码里保留了一套"检查到新版本却无法下载"的半成品（审计 B3），只会误导。

## 决策

- **移除在线更新**：删除 `src/main/updater.ts`、`electron-updater` 依赖、`app:checkForUpdates` IPC、
  `update:status` 事件与渲染层订阅、菜单「检查更新…」、`UPDATE_UNAVAILABLE` 错误码与相关文案；
- `electron-builder.yml` 去掉 `publish` 段，打包只产出安装包（dmg/nsis/AppImage+deb），不再生成 `latest*.yml`；
- **版本号定为 `1.0.0`**（`package.json`），「关于」里的版本改为从 `app.getVersion()` 读取，不再硬编码；
- 升级方式：下载新安装包覆盖安装，数据目录与迁移包格式不变。

## 兼容性

- 不涉及任何数据格式、加密格式或迁移包格式变化；
- 旧的「检查更新」入口消失，但菜单其余项、快捷键与 IPC 契约不受影响；
- 由于应用零网络请求，隐私说明可以写得更绝对（见 `docs/usage.md`）。

## 后果

- 发布流程简化为「构建 → 打包 → 分发安装包」，不再需要 Release 元数据；
- 若将来确实需要在线更新，需要重新引入依赖、签名/公证链路与发布配置，并新写一份 ADR。

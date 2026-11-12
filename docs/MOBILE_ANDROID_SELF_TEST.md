# 安卓 APK 自测记录（2026-11-12）

本轮直接安装实际 ARM64 APK，在隔离的 Android 15 模拟器中操作，使用 Android 官方 CLI、ADB、系统输入法和系统文件选择器。测试记录与附件均为本轮虚拟数据，未连接个人云账号，也未改动个人 OS 日记。关联 [#22](https://github.com/VondeSong/hub-search/issues/22)。

## 环境和安装包

- AVD：`Hub_SelfTest_20261112`，API 35 / Google APIs x86_64，ARM64 翻译；设备 `emulator-5562`。这不是用户手机的实机验收。
- 包名 `com.craftsearch.desktop`，版本 `0.16.396` / `16396`，APK 仅含 `arm64-v8a`。
- 本地交付文件：`desktop/.local/Hub-Android-0.16.396-mobile-20261112.apk`；已用通过自测的包覆盖原链接，未发布 Release。
- 大小：74,218,047 字节；SHA-256：`f7e2065084bde4381aa39b5a836e2c8d2bd79299d7cfb75f0f8a64684d95718e`。
- APK v2/v3 签名及 16 KB 压缩包对齐通过，沿用旧测试包证书。已核对安装到模拟器的 APK 与交付包 SHA-256 相同；包内原生库与当前 JNI 构建产物相同，包含当前 `dist` 的全部 129 个资源路径。

## 自测发现及修复

1. Android 15 全屏布局下，输入法会遮住“记下”。除 `adjustResize` 外，在原生内容视图处理 IME inset，并防止 WebView 重复消费。同一包实际打开键盘后，“记下”下边界为 1201，键盘上边界为 1507；带附件的草稿也通过。
2. 实际父页面仍显示桌面月份栏和外层搜索，造成手机日志重复布局。手机日志改为独立卡片流，隐藏该页外层搜索，保留桌面布局；增加父组件回归测试。
3. 第二次返回曾把 Hub 切到后台。原生返回先隐藏键盘，再回退 WebView 历史，只有根页面才进入后台。实体返回事件与屏幕边缘返回手势均实际验证：第一次隐藏输入法，第二次关闭速记并保留 Hub，重新打开恢复原草稿。

## 实际 APK 操作结果

| 场景 | 结果与证据 |
| --- | --- |
| 中文草稿关闭、重开、覆盖安装后恢复 | 通过，使用原生草稿存储，原文保留；`reopened-draft.json`、`final-draft-restored.json` |
| 系统照片选择器及普通文件选择器 | 通过，导入一张 PNG 和一个文本文件，图片原生预览正常；`photo-selected.json`、`attachments-draft.json` |
| 带照片和文件的草稿关闭重开 | 通过，正文和两个附件均恢复；`attachments-restored.json`，同时通过 IME 边界检查 |
| 断网保存后立即锁屏 | 本机保存成功，WorkManager 持久任务仍在，等待网络约束满足；`locked-jobs.txt`。未连接 OSS，不能据此声称后台上传成功 |
| 恢复网络、强停后重开及多次覆盖安装 | 两条已保存记录仍在，无重复；`after-restart.json`、`tested-final-records.json`。手动强停后的任务恢复以重新打开应用为边界 |
| 照片和普通文件导出 | 通过系统保存对话框导出，内容与原件逐字节一致；文本 64 字节，PNG 930 字节 |
| 返回事件和返回手势 | 两种路径均通过三步检查，草稿保持不变；`back-fixed-*.json`、`gesture-fixed-*.json` |
| 手机日志布局 | 一个日志标题、无桌面月份栏、无重复全局搜索，照片正常显示；`tested-final-records.json/png` |
| 速记到同步设置及返回 | 通过，显示真实队列 2 条待上传；未启用同步时给出具体原因，没有误报已上传；`capture-sync-settings.json`、`sync-disabled-result.json` |
| 任务、复习、Agents 入口 | 页面打开和返回通过；隔离环境未配置资料库、云端模型，不代表联网业务已验收；`tasks-smoke.json`、`review-smoke.json`、`agents-smoke.json` |
| 崩溃检查 | 最终测试后 Android crash buffer 为空；`final-crash-log.txt` |

附件原件及导出件 SHA-256：

- 文本：`89482cc312b42f4459abb3843340438e1c7f68c4e6cb5c447e879e3e08eb987c`。
- PNG：`da14e7053fd9a670877483fdfbaa8dafb50c5477bfb8fb0a2d41ae080f086138`。

## 开发检查与复测入口

- 16 个相关前端测试文件、59 项通过；类型检查和生产构建通过。日志：工作树 `desktop/.local-mobile-selftest-full.log`、`.local-mobile-selftest-build.log`。
- ARM64 原生构建及最终 Kotlin/Gradle 组装通过，最终日志 `back-final-build.log`。
- 另运行电脑当前主线 `673636f` 的既有 Windows 测试程序中 `quick_journal::` 15 项，均通过，覆盖临时库的按天写入、去重、人工编辑保护及回执等。测试程序已核对既有构建 SHA-256；这是电脑逻辑回归，不是本轮 APK 的云端集成测试，也不是个人 OS 库验收。
- 差异格式检查通过。未运行与本轮无关的全仓库测试。

可重复检查实际 Android 界面快照：

```text
node qa/android-ime-check.mjs keyboard-open.json
node qa/android-back-check.mjs first-back.json second-back.json reopened.json
```

第一项必须在真实输入法打开时采集；第二项用非空草稿依次采集隐藏键盘、关闭弹层、重新打开三份快照，也适用于边缘返回手势。快照来自 `android --no-metrics layout --device SERIAL --output FILE`，不是浏览器模拟状态。

本机完整证据保留于 `desktop/.local/mobile-selftest-20261112/`，不提交 APK、AVD、运行日志和原始界面快照。模拟器测试结束后关闭，桌面现有开发实例保留。

## 仍未完成的验收

本记录初次自测时未连接 OSS。后续已在独立安卓模拟器中补做 [真实 OSS → 当前电脑 → 实际 OS 日记联调](MOBILE_OSS_OS_ROUNDTRIP.md)，包括锁屏上传、进程终止后恢复、附件及回执和去重。当前仍未连接真实手机，厂商省电策略及实体设备长期后台行为保持待验证；Issue #22 保持打开。

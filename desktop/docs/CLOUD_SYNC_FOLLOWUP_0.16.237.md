# 0.16.237 阅读云同步补充联调交付

生成时间：2026-10-08T10:12:26.967321+00:00。台账状态：`scope_complete_with_external_unqualified_dida`。

本轮可执行的已接受范围已完成；真实滴答新任务的来源链仍未验证，不能将整份原计划 R1–R5 标为全部通过。本文件补充既有 `.237` 历史交付记录，旧安装包、旧回执和失败记录均保留。

## 最终阅读行为

用户明确选择“只在打开应用时自动补同步”。Android **阅读云同步**在冷启动或返回前台时补同步，后台不启动新的阅读自动同步；已有进行中的一轮可以结束。前台保留原 60 秒周期，返回前台绕过该间隔；约每 5 秒检查补同步请求，实际启动与完成时间受已有同步及网络影响。总开关、自动同步开关、阅读模块开关与网络规则继续优先。闪卡和来源采集的既有后台行为属于独立范围，本轮没有修改。

原 Home 后持续后台同步的实测失败保留：第一轮到达，第二轮在等待后未推进。该失败没有改成通过；用户选择后的前台补同步行为以新包十项实机证据验收。

## 安装包与源码依据

| 用途 | 文件 | 字节数 | SHA256 |
| --- | --- | ---: | --- |
| Windows 便携版 | [Hub_0.16.237_x64_portable_followup.exe](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/packaging/Hub_0.16.237_x64_portable_followup.exe>) | 54,046,208 | `5d6899c4f57217398cf635d45765931565c4f66a801c5c93f8245e5b6bd0dac2` |
| Android 正式 APK | [Hub_0.16.237_android_arm64_followup.apk](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/packaging/Hub_0.16.237_android_arm64_followup.apk>) | 57,378,529 | `44bba962637dcf3e44c33cba47255ac2cee1f620ca45155077c6456dfe25df83` |
| Android 联调专用 APK | [Hub_0.16.237_android_arm64_integration_followup.apk](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/android/Hub_0.16.237_android_arm64_integration_followup.apk>) | 58,472,608 | `3ba39662cfea25a74abfd2a8d2e25cfd38e523a488e3a702d4fcbb7a5a6723ee` |

Windows 实际源码摘要：`010d2f4647fa0c49b2684d00899cdf3e5d3d04d7c9bd1d1773eb0e2c03d606c7`，480 项输入，前端入口 `index-B9RmsWh2.js`。

Android 实际源码摘要：`5cd87e0273bb863c0ee40dcfaa9364c8463c99b96648845b7864d1fc2e6106d5`，481 项输入，前端入口 `index-DBJJo7kG.js`，ARM64 native SHA256 `c4bf47b950d39de877e5cd302c222e4ec5dbb4fc1eb5b69a4f19143553588d0f`，签名证书 SHA256 `0c8494ca73723ba13f4eb2bd2c0d53ee4ab14d403175553129bcf7bcef41e7e6`。

Windows 包复用已封存的隔离修复结果；Android 后续改动经编译条件、非移动端文案与同步包装语义审阅确认没有改变桌面行为。**两端不是相同完整源码冻结，也未声称 Windows 从新的 481 项输入重新构建。** 依据：[Windows 复用范围回执](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/packaging/windows-reuse-android-foreground.json>)。

联调 APK 使用独立应用 ID `com.craftsearch.desktop.integration`，可调试，仅四个已批准的 Android 外壳文件有差异；其 native 与内嵌前端字节与正式 APK 完全一致。联调 APK 不作为正式生产包使用。

## 实际验证结果

- Windows：两个独立测试目录并发启动；实际 WebView 子进程数据目录均位于各自 `webview-v1/main/EBWebView`；冲突继承的用户数据目录配置被覆盖；测试目录中的 junction 被拒绝并退出 2；无启动器 UDF 辅助。实际调用 12 次相关原生命令，另有 6 次视觉复核调用。
- 阅读与网络：原联调轮次中 12 个阶段实际通过，包括双向状态/标签、归档恢复、离线附件、蜂窝计费网络限制、任意网络允许、Wi-Fi 恢复与离线待同步收敛。该轮整体为 `restoration_requires_attention`，只按阶段与未改动的业务依赖范围复用，未记作完整成功。
- 迁移：真实标准 WebDAV 与 OSS 的迁移及当前 OSS 前缀变更通过；三个全新独立消费者分别读回 2 篇正文和 2 个原附件。迁移窗口内旧对象保留；之后独立测试向原来源空间新增事实，不声明整个执行期间来源对象集合不变。
- 维护 S3 阶段：真实 WsgiDAV/Cheroot；检查点 8/8 验证通过；实际仅删除 5 个预览指定的测试历史对象，保留 2 个 blob 与 1 个并发正式事实对象。设备退役/恢复、暂停拒绝、新消费者恢复、旧设备重启后事实保留、终态删除防复活通过。这里的 S3 是维护阶段名，不是 AWS S3。

### 新 Android 阅读十项实机验收

| 用例 ID | 内容 | 结果 | 执行依据 |
| --- | --- | --- | --- |
| `retainedDataUpgrade` | 联调应用保留数据升级 | 通过 | 原失败轮次中的实际通过阶段，带摘要复核复用 |
| `foregroundPendingUpload` | 前台自动上传原有待同步修改 | 通过 | 原失败轮次中的实际通过阶段，带摘要复核复用 |
| `homeGateThenNativeResume` | Home 后不启动新轮次，返回前台补同步 | 通过 | 本轮实机执行 |
| `rapidNativeResumeBypassesThrottle` | 短时间返回绕过 60 秒间隔 | 通过 | 本轮实机执行 |
| `coldReopenDataPreserved` | 关闭后重开保留本地数据 | 通过 | 本轮实机执行 |
| `coldReopenCatchup` | 冷启动补同步 | 通过 | 本轮实机执行 |
| `masterOffBlocksResume` | 总开关关闭阻止自动补同步 | 通过 | 本轮实机执行 |
| `automaticOffBlocksResume` | 自动同步关闭阻止自动补同步 | 通过 | 本轮实机执行 |
| `readingModuleOffBlocksResume` | 阅读模块关闭阻止自动补同步 | 通过 | 本轮实机执行 |
| `manualAllowedWithAutoOff` | 自动同步关闭时允许显式手动同步 | 通过 | 本轮实机执行 |

自动验收用例中手机手动同步调用为 0。复用项逐项核对原失败轮次中的实际通过 payload、原回执摘要、同一手机及 QA/native/frontend 身份；其余用例在新轮次实际执行。原失败整轮仍保留为失败。

正式个人应用以 `install -r` 升级到新 `44bba962` APK，UID、数据目录和首次安装时间保持一致；实际 Activity 启动和受限观察通过，设置页与阅读页已实际显示并由根代理目视复核。升级前界面：总开关开启、自动同步开启、阅读开启；升级后分别为开启、开启、开启，保持一致。早期“阅读关闭”的历史基线已过时。本项未读取个人私有数据库，也不声称逐条记录校验和一致。

最终独立只读审计通过：同一已资格化手机、新 QA 安装摘要匹配、测试 QA 暂停同步并恢复网络策略、原无线网络与 USB 保持唤醒标量恢复、仅关闭已有归属证据的转发、测试桌面/DAV 进程剩余 0。

## 测试计数与构建记录

历史交付的前端 93、后端 111 为复用的既有唯一用例统计；798 是收集数量，没有执行整个 798 全套。本轮 Windows 隔离定向 4 项（含旧 2 项）、Android 新前台门禁 7 项、受影响既有后端回归重跑 3 项、既有设置前端重跑 9 项分别通过，不将这些与历史数字直接相加。ignored 正式造数器是测试输入生产者，不算新增产品断言测试。

Windows 构建约 633.5 秒；Android 正式包构建与打包约 675.0 秒；QA Java 外壳约 89.7 秒。Android 官方命令的实际退出码 1 及符号链接打包失败保留；该命令已完成新的 native 编译，随后仅使用已验证的新 native 进行离线单 worker Gradle 打包、签名及 ELF/ZIP 对齐检查，回退退出码 0，没有第二次 native 编译或系统权限修改。

## 明确的未验证项与范围

真实滴答新任务的创建、导入、当前来源附件恢复授权及来源删除链未资格化：本次没有可调用的滴答 adapter，公共 `sync_x_bookmarks` 会扫描整个启用阅读库，缺少只选择测试任务的入口，因此未用于本轮测试。正式本地生产者的合成任务与云恢复回执不能替代真实滴答会话。

PNG 已实际加载；PNG/PDF 附件的受控本地字节、MIME、清单和 SHA256 已验证，未验收外部 PDF 阅读器的视觉渲染。没有承诺持续后台、锁屏或应用被关闭后仍进行阅读同步。

用户明确排除通用网页剪辑和 Hub 独立添加链接/浏览器剪辑入口；本轮未扩展可配置“标签＋收件箱”规则。本轮没有新增端到端加密、AWS、分片上传、常驻后台服务、自动来源/blob 删除或完整月度费用预算。

## 主要回执

- [最终封存台账](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/verification-ledger.json>)
- [Android 前台验收](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/android/foreground-b0072ad498/report.json>)
- [正式个人应用保留数据升级及界面复核](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/android/production-upgrade-ffeacf7b6066/result.json>)
- [最终只读审计](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/android/final-audit-667c9fadf6/report.json>)
- [桌面迁移](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/sessions/live-a0487d33/desktop-chain/result.json>)
- [真实标准 WebDAV 维护阶段](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/sessions/live-a0487d33/desktop-chain/clean-s3/result.json>)
- [历史 Home 后台失败](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/sessions/live-a0487d33/home-background.json>)
- [滴答外部访问边界](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/dida-tool-inventory.json>)

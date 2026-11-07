# 0.16.237 真实滴答阅读链路 R5 交付

生成时间：2026-10-08T20:07:44.443886+08:00。本轮状态：真实测试任务的导入、原附件保存、OSS 恢复、独立消费者恢复和活动来源清理通过；Hub 直连 OAuth 建立及自动恢复会话仍未实测。此文件新增交付记录，不替换上一轮封存结果。

## 实际结果

- 仅使用“Hub 联调测试”中的两条可删除任务。加上“稍后读”后，Hub 正式导入流程保存两篇笔记到独立 Obsidian 测试库；标题及正文在标签准备阶段保持不变。
- 原始 PNG 为 96,318 字节，PDF 为 252,471 字节。实际文件的大小、SHA256、文件头和真实来源附件元数据均匹配，两篇 Markdown 导出也独立读回通过。
- 未开启来源清理时，正式流程保留两条滴答原项，并通过独立查询确认。真实 OSS 已保存正文、原附件及来源恢复材料，两个来源恢复检查均完整通过。
- 全新 Hub 环境没有滴答会话，只连接同一独立 OSS 测试目录，恢复了两篇相同正文及两个原附件。实际消费者文件再次读回，正文及文件校验值与生产者完全一致。
- 以上证明通过后，由 Hub 的正式写入流程发起两次真实来源删除。两条回执均为 `processed=true`、`localVerified=true`、`deleteState=deleted`。独立按 ID 查询均明确返回 `resource_not_found`，指定测试项目的活动任务列表为空。
- 删除后，本地两篇笔记和两个原附件保持完整；来源清理开关重新关闭。联调桥接、消费者、生产者及原控制进程均已退出，自建后代进程剩余 0。

测试库：[R5Vault](<D:/03_Resources/Software/Apps/Craft/search/.local/cloud-followup-20261007/w/974fd1eb/R5Vault>)。独立 OSS 测试目录和恢复材料保留。

## 来源读取修复

此前连接器的任务详情没有提供完整附件数组，不能据此认定附件已迁移。本轮统一修复导入、删除前核对及最终写入授权三个读取点：使用已登录的原生附件会话，读取真实用户身份和指定任务的完整详情，核对正文、标签及版本。未知或不完整的原附件/子任务信息仍阻止来源清理。没有通过补造数组或跳过完整性检查获得通过。

联调入口只在显式测试构建中启用，限定两个测试任务及独立资料目录，禁用后台全账号采集。实际来源运输为“Hub 正式流程 → 有界本机桥接 → 官方滴答连接器”，每次均转交真实请求和原始响应。正常 Windows/Android 包未启用该入口；Windows 实际调用两个测试命令均确认不存在。不能用本轮证明替代 Hub 直连 OAuth 登录及会话恢复验证。

## 删除查询差异

滴答删除后，普通按 ID 查询和活动项目清单确认两条任务已不可见；带项目 ID 的精确查询仍返回原对象，且连接器未暴露删除标志。原始响应全部保留。结论限定为“活动来源清理已确认”，不声称永久擦除、所有接口都返回不存在，或已证明具体回收站机制。一次额外的精确原生读取尝试因诊断协议不支持而停止，没有将其算作通过。

## 新生产包

| 平台 | 文件 | 字节数 | SHA256 |
| --- | --- | ---: | --- |
| Windows 便携版 | [Hub_0.16.237_x64_portable_r5.exe](<D:/03_Resources/Software/Apps/Craft/search/.local/r5-real-dida-20261008/packaging/Hub_0.16.237_x64_portable_r5.exe>) | 54,282,240 | `ec841bf4644a3232b7854162b27094a94cc34da1229005ecbe469d8798c10b41` |
| Android ARM64 | [Hub_0.16.237_android_arm64_r5.apk](<D:/03_Resources/Software/Apps/Craft/search/.local/r5-real-dida-20261008/packaging/Hub_0.16.237_android_arm64_r5.apk>) | 57,591,521 | `9fe9c3a10efaad594eb9656b2b41859d124010f80aa32742580895007eb97f7f` |

两包均来自同一冻结源码 `0a4890de88e8c8462e1b9dc35e1a21189007a165b250cc55de6b1b987e6c6acf`，共 483 项输入，前端入口 `index-DBJJo7kG.js`。Windows 正常包隔离冷启动通过，六个正式设置命令可用，来源清理默认为关闭；实际 Authenticode 状态为 `NotSigned`。

Android 应用 ID 为 `com.craftsearch.desktop`，版本码 `16237`，签名证书 SHA256 为 `0c8494ca73723ba13f4eb2bd2c0d53ee4ab14d403175553129bcf7bcef41e7e6`，与上一版一致；native 和 APK 的 16KiB 对齐检查通过。本轮没有安装到个人手机，前台补同步的实机行为沿用上一轮独立证据，不称为新 APK 的实机验收。手机继续采用用户选定的“只在打开应用时自动补同步”。

## 验证范围与保留诊断

31 项定向测试全部实际通过：完整来源读取 6 项、来源恢复 6 项、滴答阅读既有回归 19 项。这不是全量测试，未与历史重叠用例相加。旧六份产物和其回执保持原摘要。

首次编译发现的类型推断问题已在最终冻结前修复。原生构建成功后的 Windows 签名检查脚本环境问题，使用独立后处理续跑解决；Android native 构建后的已知 Windows 符号链接权限错误保留，使用本次真实 native 完成离线 Gradle 封装、签名与对齐检查。未修改系统权限，也没有用旧 native 代替。

联调中重复登录检查误调用、一次连接器超时、Windows 扩展路径造成的校验误判均保留为失败尝试。超时期间来源未删除；重试成功后才进入恢复验证。路径修复仅调整独立联调脚本对合法 Windows 路径表示的归一化，保留严格路径归属、源元数据及实际字节校验，并继续使用原登录进程。全仓格式检查中的未改动文件格式差异保留，改动源文件的定向格式检查通过。

本轮未扩展通用网页剪辑、Hub 独立添加链接入口、可配置“指定标签＋收件箱”组合规则、完整月度预算、端到端加密或分片上传。外部 PDF 阅读器视觉渲染仍未验收。因此不把全部原规划项统一标记为完成。

## 证据

- [本轮封存台账](<D:/03_Resources/Software/Apps/Craft/search/.local/r5-real-dida-20261008/verification-ledger.json>)
- [真实来源链路报告](<D:/03_Resources/Software/Apps/Craft/search/.local/r5-real-dida-20261008/continuation-04a0532b1931/report.json>)
- [独立来源链路审计](<D:/03_Resources/Software/Apps/Craft/search/.local/r5-real-dida-20261008/final-chain-audit.json>)
- [独立双端包审计](<D:/03_Resources/Software/Apps/Craft/search/.local/r5-real-dida-20261008/packaging/final-package-audit.json>)
- [Windows 正常包启动验证](<D:/03_Resources/Software/Apps/Craft/search/.local/r5-real-dida-20261008/production-cold-start.json>)
- [31 项定向测试记录](<D:/03_Resources/Software/Apps/Craft/search/.local/r5-real-dida-20261008/packaging/tests.json>)
- [上一轮手机及同步交付记录](<D:/03_Resources/Software/Apps/Craft/search/desktop/docs/CLOUD_SYNC_FOLLOWUP_0.16.237.md>)

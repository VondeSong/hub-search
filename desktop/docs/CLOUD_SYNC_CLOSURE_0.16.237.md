# 0.16.237 同步收尾验收

日期：2026-10-08。用户确认的三项收尾、原始九个完成条件均已取得本轮证据。此前云同步与 R5 来源联调记录保持原样；本记录补齐它们之后的实现与验证边界。

| 发现 | 本轮结果 | 证据 |
| --- | --- | --- |
| SYNC-CLOSE-1：手机后端保存与导出限制 | 两个入口在获取锁、写配置或启动任务前拒绝；实际新版手机调用无配置、正文、标签、任务或原件副作用。正式 Windows 的保存与导出入口仍成功完成。 | [手机回归](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/android/extra-5c038480f1/report.json)；[正式 Windows 启动与导出](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/runtime/production-49e25905de/report.json) |
| SYNC-CLOSE-2：滴答直连及自动恢复 | 正式 OAuth 直连成功；关闭旧进程后已有前端启动流程自动建立新会话，两次官方只读业务调用通过，未手动恢复或枚举任务。 | [OAuth 验收](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/oauth-validation.json)；[独立审计](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/oauth-runtime-audit.json) |
| SYNC-CLOSE-3：新 Android 升级与回归 | 正式 APK 保留数据覆盖升级，公开同步设置保留；同一原生代码的独立测试应用通过返回前台补同步、断网恢复和三个关闭开关门禁。双端正式包可启动。 | [正式升级](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/android/production-upgrade-6b98796d36be/result.json)；[新版手机回归](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/android/extra-5c038480f1/report.json) |

## 正式交付

| 平台 | 安装包 | SHA-256 |
| --- | --- | --- |
| Windows x64 便携版 | [Hub_0.16.237_x64_portable_closure.exe](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/packaging/Hub_0.16.237_x64_portable_closure.exe) | `6aee636d52b854df319b7aa9d74d8a0227ed6984f253c8ceaef87eb7d5f6c514` |
| Android ARM64 | [Hub_0.16.237_android_arm64_closure.apk](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/packaging/Hub_0.16.237_android_arm64_closure.apk) | `29352aa8c161846521ec1263e08b46f7d78ef67653f343bc2d6e6c35e9abb573` |

版本仍为 0.16.237，文件名使用 closure 后缀区分本轮候选。两端使用同一冻结的 484 个源码输入，摘要为 `46ba6a4172a2b468691f391bd10a929fabf0b1fe2a7f3906cb91fa384fd113fd`。正式包均关闭 OAuth 联调特性；Windows 实际调用三个测试命令均返回不存在。Android 正式包与测试壳的原生库和内嵌前端逐字节相同。Windows Authenticode 状态为 NotSigned；Android 签名与原正式安装一致。

手机已安装本轮正式 APK。安装使用 `install -r`，UID、数据目录、首次安装时间与已有权限保持；升级前后的公开总开关、自动同步、阅读模块设置一致。未清除或卸载正式应用，未读取个人数据库，未宣称逐条个人记录校验。Windows 交付为新便携包，未替换个人安装目录。

## 实测范围

- 23 项后端测试、2 项相关界面测试及所改 Rust 文件格式检查通过；测试先正式收集唯一身份，再核对实际执行结果。未运行全量套件。
- OAuth 在自有独立目录中，复用正式连接、保存授权、恢复 helper 与已有前端启动调度；新进程实际记录未连接到已连接。只读取官方偏好，前后没有任务或文档被索引。没有强制令牌过期，未把本结果扩大为个人普通配置目录的完整启动或真实过期刷新实测。
- Android 独立测试应用先保留原两篇正文、状态、标签与两份物理原附件升级，再验证实际手机命令拒绝。通过正式迁移从原测试 OSS 到本轮独立 WebDAV，新的正式 Windows 消费端真实恢复两篇文章；原 OSS 未删除。
- 手机网络状态来自实际原生系统；断网时保留待处理内容，网络恢复并返回应用后自动补齐。WebDAV 使用标准服务经 USB 反向连接传输，不能据此宣称公网无线 WebDAV 传输实测。自动场景的手机手动同步调用为 0。
- 返回前台、断网等待与总开关／自动／阅读开关关闭观察覆盖返回前台约 5 秒触发周期，关闭门禁各观察至少 8 秒。未据此扩称约 60 秒常规间隔或长时间后台行为。原正文与两份原附件在测试末尾仍一致；测试应用的新增标签仅属于隔离数据。
- 测试应用、Windows 临时进程与 WebDAV 已关闭，本轮连接映射已移除；手机网络与保持唤醒设置恢复原值。正式手机应用保留供用户使用。

## 非通过事件与处理

以下事件保留原始结果，不宣称每一次检查都通过。它们不再阻塞当前九个条件；最终通过只取当前候选的定向检查和真实验收。

| 事件 | 分类 | 处理依据 |
| --- | --- | --- |
| verification\closure-android-production-1791465015250258700\result.json | environment | Official Android CLI completed the fresh native compilation then could not create the JNI symbolic link under current Windows privileges. The same frozen native bytes were copied into the reviewed offline Gradle packaging route, which produced the signed current APK; original nonzero exit is retained. |
| verification\rust-prepare-closure-1791462873091829800\result.json | product | Earlier candidate E0308 fixed; same targeted prepare and tests passed on frozen candidate2 |
| verification\sentinel-closure-1791462756262705300\result.json | verifier | Expected controlled official CLI rejection proved exit propagation |
| old-qa-qualification-attempt-1 | verifier | AttributeError in shared QA connection helper: config was None before the helper appended its values to in-memory redactions. Resolved before actual business verification. Evidence: D:\03_Resources\Software\Apps\Craft\search\.local\sync-closure-20261008\mobile-before-fix-attempt-1.json |
| old-qa-qualification-attempt-2 | verifier | Shared QA connection helper required the old OSS configuration comparison; this local command regression intentionally had no cloud configuration loaded. Resolved before actual business verification. Evidence: D:\03_Resources\Software\Apps\Craft\search\.local\sync-closure-20261008\mobile-before-fix-attempt-2.json |
| old-mobile-backend-defect-reproduction | product | Old APK reached validation or started an export job. The frozen current APK now refuses before side effects in actual phone calls. Original evidence: D:\03_Resources\Software\Apps\Craft\search\.local\sync-closure-20261008\mobile-before-fix.json |
| final-handback-initial-verifier-encoding | verifier | Initial Windows verifier could not decode Android UTF-8 foreground output under its default encoding and subsequently failed on an unavailable stdout value. All preceding APK/radio/mapping/QA-absence checks had passed, with no device mutations. Explicit UTF-8 was applied only to the scratch verifier; the next actual handback passed. Original receipt: D:\03_Resources\Software\Apps\Craft\search\.local\sync-closure-20261008\android\final-handback-d50e4936b06d\receipt.json |

## 收口与证据

本轮仅关闭已接受的三项收尾。手机采用打开或返回应用时自动补同步；持续后台、通用网页剪辑、独立添加链接及未接受的可选增强仍在既定范围之外。

[原始三项九条件](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/original-findings.json) · [逐项终态](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/findings-closure.json) · [确定性结项核验](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/findings-closure-validation.json) · [证据身份清单](D:/03_Resources/Software/Apps/Craft/search/.local/sync-closure-20261008/delivery-evidence.json)

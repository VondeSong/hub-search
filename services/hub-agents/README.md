# Hub 云端 Agents

Android 底部「Agents」和桌面云朵按钮使用同一个 VPS 服务。每台设备用各自的密钥连接，可读取同一位用户的云端会话。VPS 只处理用户发送的文字和附件，模型通过 VPS 上的 Codex ChatGPT 登录运行。手机从相机或系统选图，可在本地为 30 秒以内的视频抽取最多六张带时间戳的帧。

Agents 默认打开会话列表，显示最后一轮摘要、更新时间以及「当前／已归档／全部」范围。搜索同时检查标题和历史消息；选中会话后进入聊天，返回保留搜索条件和滚动位置。会话选项支持重命名、归档和恢复，状态保存在 VPS，连接同一服务的设备可读到相同结果。归档保留全部消息、附件和固定技能，恢复后继续使用原线程；有排队或运行中轮次时先等待或停止，归档状态不接受新轮次，已接受消息的原编号重试仍保持幂等。

兼容接口：`GET /v1/threads?q=...` 返回全部摘要及各条 `matches`，客户端组合搜索与范围、保持总数量准确；查询按字面匹配，最多 200 字符。`POST /v1/threads/{id}/metadata` 只接受 `title`（1–80 字符）和 `archived`（布尔值），仍需设备鉴权。旧数据库启动时增量添加归档字段，不迁移或删除原会话；重复设置同一状态不改变更新时间。具体模拟器与真实云端检查见 [会话管理验收](../../desktop/docs/CLOUD_AGENTS_CONVERSATIONS_20261114.md)。

客户端可在「使用固定技能」中明确选择一个已保存文字技能及配套文件。网关校验清单、文件字节和哈希，将该版本固定到对话，后续消息沿用。切换版本时新建对话。网关需要更新到支持固定技能的版本，凭现有的设备密钥接收请求，无需 OSS 密钥。与会话文字一样，发到 VPS 的技能是该会话的一部分。技能脚本、二进制附件、桌面连接器和目录权限不随请求发送。

## Debian VPS

需要 Python 3.11 或更新版本、官方 `codex` 和一个受控的 HTTPS 入口。本服务不开放模型执行命令或调用桌面工具。服务单用户运行，示例使用独立 Linux 账号和 `/var/lib/hub-agents`。以下命令由 VPS 管理员从本目录运行。已有 VPS 上的测试版 Codex 可以复用同版本的可执行文件，正式服务用独立的登录目录。

```sh
sudo useradd --system --home-dir /var/lib/hub-agents --shell /usr/sbin/nologin hub-agents
sudo install -d -m 0700 -o hub-agents -g hub-agents /var/lib/hub-agents /var/lib/hub-agents/codex
sudo install -d -m 0755 /opt/hub-agents
sudo install -m 0644 server.py codex.py /opt/hub-agents/
sudo install -m 0644 hub-agents.service /etc/systemd/system/
sudo -u hub-agents env HOME=/var/lib/hub-agents CODEX_HOME=/var/lib/hub-agents/codex /usr/local/bin/codex login --device-auth
sudo systemctl daemon-reload
sudo systemctl enable --now hub-agents
```

登录请使用计划给 Hub 使用的 ChatGPT 账号。可执行文件路径与服务文件的 `ExecStart` 应相同。后续重新授权使用同一条 `codex login` 命令。服务每轮检查认证类型，只有 ChatGPT 登录才能继续，额度限制和登录失效会显示在对话中。

将受控网络上的 HTTPS 反代指向 `http://127.0.0.1:8787`。例如 VPS 已在 Tailscale 私网中，可运行 `tailscale serve --bg http://127.0.0.1:8787`，并在手机和桌面连接同一私网。已有 HTTPS 反代也可用，保留 `Authorization` 头，单次上传限制至少为 17 MiB。App Server 通过本机标准输入输出接入，VPS 的 HTTP 监听也绑定回环地址。

### 无域名：公网 IP 与自动续证

个人使用可以配置公网 IP 的受信任证书，无需购买域名。证书只加密连接，设备密钥仍是访问会话的凭据。[Let's Encrypt 的 IP 证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)使用有效期约六天的 `shortlived` 配置，必须自动续期并重载 Nginx。以下配置适用于本服务；不替换 VPS 已有的 443 服务。

1. 从 Debian 软件仓库安装 Nginx、Python venv。在独立 `/opt/hub-agents-acme` venv 安装支持 IP webroot 的 Certbot 5.4 或更高版本。本轮实际验证版本为 5.4.0。
2. 先只启用 `nginx-ip.conf.example` 的 HTTP server，替换 `HUB_PUBLIC_IP`，创建 `/var/lib/hub-agents-acme/webroot`。80 端口只允许读取 ACME 验证文件，其余请求返回 404；不在 HTTP 上代理 Hub。检查 `nginx -t` 并启用该配置，放行 TCP 80。
3. 以该 IP 申请证书；首次注册时按管理员实际选择提供邮件地址和接受签发机构协议，不将账号或私钥放入仓库。先加 `--dry-run` 检查，再移除该参数签发正式证书。

   ```sh
   /opt/hub-agents-acme/bin/certbot certonly --non-interactive \
     --required-profile shortlived --webroot \
     -w /var/lib/hub-agents-acme/webroot \
     --ip-address YOUR_PUBLIC_IP --cert-name hub-agents-ip
   ```

4. 证书存在后启用完整的 `nginx-ip.conf.example`，放行 TCP 9443。客户端填写 `https://YOUR_PUBLIC_IP:9443`；8787 始终只绑定回环，不开放原始 HTTP 服务。模板保留上传限制和请求频率限制，不更改客户端的证书校验。
5. 将 `reload-nginx.sh` 以 0755 安装到 `/etc/letsencrypt/renewal-hooks/deploy/hub-agents-nginx`，将 `hub-agents-cert-renew.service` 和 `.timer` 安装到 `/etc/systemd/system/`，执行 `systemctl daemon-reload` 与 `systemctl enable --now hub-agents-cert-renew.timer`。每六小时检查一次续证，成功后先检查 Nginx 配置再重载。
6. 执行 `certbot renew --cert-name hub-agents-ip --dry-run --run-deploy-hooks` 验证完整续证/重载路径，并回读 `systemctl list-timers`。从外部验证 IP 主机名、证书链及无密钥时的 403，再使用独立设备密钥验证会话。

模板和定时器不包含设备密钥、证书私钥或 Codex 凭据。公网入口可达不等于会话公开；每台设备独立发放、撤销密钥。

为手机和桌面各发一个设备密钥。命令输出包含密钥和用于撤销的设备 ID。把密钥填进相应设备的「连接 VPS」。

```sh
sudo -u hub-agents python3 /opt/hub-agents/server.py --state /var/lib/hub-agents/gateway add-device Android
sudo -u hub-agents python3 /opt/hub-agents/server.py --state /var/lib/hub-agents/gateway add-device Windows
sudo -u hub-agents python3 /opt/hub-agents/server.py --state /var/lib/hub-agents/gateway devices
sudo -u hub-agents python3 /opt/hub-agents/server.py --state /var/lib/hub-agents/gateway revoke-device DEVICE_ID
```

## 运行与验收

### 桌面分析交接与手机取回

桌面文件成果提供「手机继续查看」：选择当前有效版的成果和一份 Markdown 报告，预览目标个人 VPS 后确认发送。手机在同名云端会话中查看「桌面已有分析」、取回文件并继续讨论报告。后续回答由 VPS 的订阅模型执行，明确以桌面报告为依据；本接口不在 VPS 运行上传的脚本或重新读取原始表格。

- `handoffs.py` 与 `server.py` 一起安装。`GET /v1/threads` 的 `handoffs: true` 表示网关支持这一合同；所有交接路由沿用设备鉴权，属于同一个个人空间。
- `POST /v1/handoffs/{UUID}` 准备固定清单；`POST .../files/{SHA256}` 逐文件上传；`POST .../commit` 以 `{"confirm":true}` 完整发布。未完整发布时不会建立可见会话。同编号同内容可重试，不重复建立会话或发起模型调用；同编号异内容返回 409。服务重启保留已上传文件和交接状态。
- 限 1–16 个文件、每文件 10 MiB、合计 50 MiB；供阅读及续聊的 UTF-8 Markdown 正文最多 48,000 字节，必须与所选报告文件哈希及大小一致。允许已有 CSV、JSON、XLSX、PNG、SVG、Markdown、PDF 成果；固定清单包含桌面工作、成果、执行及修订身份和输入标题/哈希。
- `GET .../files/{SHA256}` 返回 `sha256`、`bytes`、Base64 `data`。客户端核对清单、字节数和 SHA-256 后放入本机 BlobStore；Android 复用原生系统保存与回读校验，打开保存窗口不算保存成功。
- `POST .../withdraw` 接收 `{"confirm":true}`，移除 Hub 云端交接副本、停止文件下载与该会话后续提问。已发给 Codex 的内容、历史回答、备份和此前保存的副本仍保留。正在回答时须先结束该轮。桌面本地授权撤回不会自动删除已显式导出的云端副本。
- `GET /v1/handoffs` 列出未完成交接，可在连接设置中核对并撤回不再需要的临时副本。最多 8 份未完成交接，全部未撤回交接的清单预算合计不超过 512 MiB，避免无限占用个人 VPS。
- 已读会话按设备连接分别缓存。离线时标明缓存截至时间；只可取用本机已下载文件，恢复连接后核对远端状态。收到认证拒绝会隐藏云端内容并清除该连接缓存；未联网的设备只能知道上次读取的状态。Android 保留最近查看的会话和成果页，已发送但未确认的消息沿用既有原编号恢复流程。

部署前等待 Agents 与语音任务结束，备份服务源码和完整 `/var/lib/hub-agents`，更新后逐表核对原有记录。T17 的模拟器结果与 #32 的实体手机、Windows 真关机及自然认证/额度边界分别记录。

### 日志录音转写

语音复用现有 HTTPS 地址和设备连接。阿里与 OpenAI 的 API Key 只放在 VPS 的 `/etc/hub-agents/transcription.json`，不填入手机、不放进 APK、Git 或公开原型。目录权限 `0750`，文件 `root:hub-agents 0640`。对象中按 `aliyun`、`openai` 分别配置 `apiKey`；阿里北京业务空间另填实际 `workspaceId`。此文件可通过 `HUB_TRANSCRIPTION_CONFIG` 指定其他受控位置。

- Debian 依赖：`python3-websocket`、`ffmpeg`。语音路由的 Nginx 上传上限单独设为 29 MiB；其它 Agents 路由保持原限制。
- 实时转写使用 WebSocket。阿里使用 `paraformer-realtime-v2`，OpenAI 使用 `gpt-live-transcribe`，输入为 24 kHz PCM16。Android 同时编码 M4A 原音，暂停不计入音频时长。
- 录完后转写和手动补转写提交本机已保存的原音附件。个人云端校验 SHA-256 后生成完整的 MP3 请求。阿里走 `qwen3-asr-flash` 的兼容 HTTP 接口，每段最多 5 分钟。OpenAI 走 `/v1/audio/transcriptions` 的 `gpt-transcribe`，Hub 每段最多 30 分钟。阿里请求内直接带音频数据，无需公开录音 URL。
- `/v1/voice/providers` 返回服务配置状态及 `fileModel` 能力。新版客户端依靠该字段启用文件转写。已有客户端提交文件和查询历史任务沿用原路由。`jobs/{UUID}`、`chunks`、`finish`、`cancel` 均需设备认证和任务归属。共限两段并发，本机原音附件最多 20 MiB。
- 手机本机持久化任务号和原音，可先保存记录。个人云端接收后的文件任务独立完成，重开原记录可以读取结果或按原任务号补交。断网后待提交的任务在重新打开原记录时恢复。VPS 重启把处理中任务记为中断，避免重复计费。
- 停止操作立即保留手机上已有的识别文字，云端回执随后更新。正在处理的文件请求能丢弃迟到的结果，供应商已接收的请求仍可能计费。识别结果归属原录音，校对并确认后加入同一条笔记正文。
- 原型仍只演示流程，不调用真实识别服务。服务接入和 API 测试不等于实体手机、蓝牙、来电及后台录音已验收；当前离开应用会结束并保留本段。

[阿里实时转写](https://help.aliyun.com/en/model-studio/websocket-for-paraformer-real-time-service) · [阿里文件转写](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen-asr-api-reference) · [OpenAI 实时转写](https://developers.openai.com/api/docs/guides/realtime-transcription) · [OpenAI 文件转写](https://developers.openai.com/api/docs/guides/speech-to-text)

- 同一个发送编号和内容可安全重试。服务每次执行一条任务，已接收的任务保存在 SQLite 中。运行中的一轮遇到服务重启会标记失败并保留已有文字，等待中的任务会继续执行。
- 一条消息最多 20,000 字、6 个附件。JPEG、PNG 和 WebP 单张最多 4 MiB，附件合计最多 12 MiB。视频只上传抽取的图片，短暂画面可能落在帧间。
- `systemctl status hub-agents` 和 `journalctl -u hub-agents` 用于检查后台。升级时先等待当前轮次结束再重启服务。备份应覆盖整个 `/var/lib/hub-agents`，包括网关数据库与 Codex 会话；目录内含账号凭据和聊天内容。
- 本地回归运行 `python -m unittest discover -s services/hub-agents -v`。真机验收用手机发文字及图片、追问、停止一轮，切换网络或退出重开后取回结果，再用桌面读取并继续同一会话。

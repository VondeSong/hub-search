# Hub 云端 Agents

Android 底部「Agents」和桌面云朵按钮使用同一个 VPS 服务。每台设备用各自的密钥连接，可读取同一位用户的云端会话。VPS 只处理用户发送的文字和附件，模型通过 VPS 上的 Codex ChatGPT 登录运行。手机从相机或系统选图，可在本地为 30 秒以内的视频抽取最多六张带时间戳的帧。

## Debian VPS

需要 Python 3.11 或更新版本、官方 `codex`、`bubblewrap` 和一个受控的 HTTPS 入口。服务单用户运行，示例使用独立 Linux 账号和 `/var/lib/hub-agents`。以下命令由 VPS 管理员从本目录运行。已有 VPS 上的测试版 Codex 可以复用同版本的可执行文件，正式服务用独立的登录目录。

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

为手机和桌面各发一个设备密钥。命令输出包含密钥和用于撤销的设备 ID。把密钥填进相应设备的「连接 VPS」。

```sh
sudo -u hub-agents python3 /opt/hub-agents/server.py --state /var/lib/hub-agents/gateway add-device Android
sudo -u hub-agents python3 /opt/hub-agents/server.py --state /var/lib/hub-agents/gateway add-device Windows
sudo -u hub-agents python3 /opt/hub-agents/server.py --state /var/lib/hub-agents/gateway devices
sudo -u hub-agents python3 /opt/hub-agents/server.py --state /var/lib/hub-agents/gateway revoke-device DEVICE_ID
```

## 运行与验收

- 同一个发送编号和内容可安全重试。服务每次执行一条任务，已接收的任务保存在 SQLite 中。运行中的一轮遇到服务重启会标记失败并保留已有文字，等待中的任务会继续执行。
- 一条消息最多 20,000 字、6 个附件。JPEG、PNG 和 WebP 单张最多 4 MiB，附件合计最多 12 MiB。视频只上传抽取的图片，短暂画面可能落在帧间。
- `systemctl status hub-agents` 和 `journalctl -u hub-agents` 用于检查后台。升级时先等待当前轮次结束再重启服务。备份应覆盖整个 `/var/lib/hub-agents`，包括网关数据库与 Codex 会话；目录内含账号凭据和聊天内容。
- 本地回归运行 `python -m unittest discover -s services/hub-agents -v`。真机验收用手机发文字及图片、追问、停止一轮，切换网络或退出重开后取回结果，再用桌面读取并继续同一会话。

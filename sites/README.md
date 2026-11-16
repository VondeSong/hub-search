# Hub 站点原型源码

这里保存两个既有 ChatGPT Sites，以及用户于 2026-11-14 明确要求新建的独立任务流程实验室的完整可运行源码，供 Claude Code、Codex 和 ChatGPT 接续编辑。它们是 Hub 的浏览器交互原型；正式桌面产品仍在 `desktop/`，VPS Agents 服务仍在 `services/hub-agents/`。

## 站点与目录

| 站点 | GitHub 源码目录 | 原站入口 | 首次导入的已发布版本 |
| --- | --- | --- | --- |
| Hub 手机端原型 | [hub-mobile-lab](hub-mobile-lab) | [浏览](https://hub-mobile-lab-von11.song02211368537057.chatgpt.site/#browse) | v6 |
| Hub · 工作与生活工作台 | [hub-workspace](hub-workspace) | [全部内容](https://hub-workspace-von11.song02211368537057.chatgpt.site/?view=all) | v80 |
| Hub · 任务流程实验室（独立评估） | [hub-task-flow-lab](hub-task-flow-lab) | [任务工作台](https://hub-task-flow-lab-von11.song02211368537057.chatgpt.site) | v1 |

首次同步日期：2026-11-12（北京时间）。两个来源版本均已核验发布成功。

任务流程实验室于 2026-11-14 独立发布 v1（私有预览），没有修改原两个站点或正式桌面程序。全部数据、AI 与来源同步都是本机模拟。发布回执已成功；本地浏览器完成流程验收，发布后的云浏览器访问停在 ChatGPT 登录页，未把登录门禁当作线上内容验收通过。使用站点所属 ChatGPT 账号打开；详情与图解见该目录 README 和 `docs/task-flow.md`。

2026-11-14 工作台已沿用原项目发布 **v81**，包含此前保留的云同步调整，以及洞察依据确认、替代关系和限定事项的旧知识查找。原型使用示例资料，桌面真实接入另行验收。此前 Sites 编辑连接阻碍已解除；源码提交 `f1b88180c62b436a7f8b3c51f1f6d3ad0b2e27ed`、部署 `appgdep_6af7cd2def3481919c7661aa121fb55e` 成功，225 个来源文件已导回并核验，`.source-snapshot.json` 记录实际来源。类型、相关原型状态检查和生产构建通过；保留原地址与访问范围，没有新建替代站点。


| 来源 | 原始源码 Git commit | 原始文件数 |
| --- | --- | ---: |
| 手机端 v6 | `46d6fc81061a00a2abbdb564f7aa0bb06f247e81` | 20 |
| 工作台 v80 | `29ed068217aebecbba4ae83a249b3058d38fe88d` | 222 |
| 任务流程实验室 v1 | `2a99c02d3923b7e04751adcdaa383d19b305431a` | 17 |

这些 SHA 是各自 Sites 源码仓库的提交，与 `hub-search` 的提交编号不同。每个目录的 `.source-snapshot.json` 保存当前导入来源、发布版本、部署 ID，以及所有原始文件的 SHA256、模式和大小；本表的 v6/v80 保留为首次导入记录，后续状态以快照为准。

2026-11-17 工作台沿原项目发布 **v108**：补充助手工作过程的语义图标、网站标识、分组/部分失败及子任务演示（#56）。类型、构建与原型交互检查通过；263 个来源文件已导回，实际源提交为 `5475054ad9d5bfe7ece65e98179ce165506c5527`，部署为 `appgdep_6afb343e910081918e7fe7dec521433e`。示例不等于真实运行；桌面原生接入与验收见 [验收记录](../desktop/docs/AGENTS_NATIVE_ACTIVITY_ACCEPTANCE_20261117.md)。

## 在 Claude Code / Codex 中继续编辑

连接私有仓库 `VondeSong/hub-search`，先读取根 `AGENTS.md`、本目录 [AGENTS.md](AGENTS.md)，再进入所需目录。普通 Claude 的 GitHub 文件上下文与 Claude Code 的仓库编辑流程是不同能力；实际改代码可使用 Claude Code 本地或云端仓库任务。

- 调整工作台界面、助手、洞察、阅读、任务等：进入 `sites/hub-workspace/`。
- 调整手机浏览、搜索、日志、复习或 Agents 演示：进入 `sites/hub-mobile-lab/`。
- 评估新的桌面任务闭环、候选整理、行动池、等待与完成日志：进入独立的 `sites/hub-task-flow-lab/`，不要覆盖原工作台。
- 任务指向网站原型时，保持在该目录内修改；不要因此直接改动桌面业务源码。

### 手机端：静态源码，直接预览

本项目没有依赖安装或构建步骤。`dist/` 内 HTML、CSS、JavaScript、SVG 就是手写的原始源码与发布内容，必须保留。根 `.gitignore` 已为这一目录设置精确例外。

```bash
cd sites/hub-mobile-lab
python3 -m http.server 5174 --bind 127.0.0.1 --directory dist
```

打开 <http://127.0.0.1:5174/#browse>。Windows 若使用 Python Launcher，将命令中的 `python3` 换成 `py`。修改源码后刷新页面。

现有状态检查：

```bash
node checks/mobile-checks.cjs
```

### 任务流程实验室：独立静态源码

进入 `sites/hub-task-flow-lab/` 运行 `npm run check`（38 项模型与静态 UI 检查），再通过 HTTP 服务预览 `dist/`。不需要安装依赖或构建；`dist/` 是手写源码。顶部的“体验完整案例”和“流程图”可以演示完整闭环，详细验证边界见 [验证记录](hub-task-flow-lab/docs/verification.md)。

### 工作台：React / TypeScript / Vinext

准备 Node.js **≥22.13.0** 和项目指定的 **pnpm 11.25.0**。使用原锁文件，保持 pnpm 项目结构。

```bash
cd sites/hub-workspace
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://localhost:5173/?view=all>。生产构建命令：

```bash
pnpm build
```

普通克隆默认使用 `portable` 运行模式；无需复刻生成站点时的临时目录。`npm run install:ci` 是 Sites 的 Linux 辅助安装入口，通用 Windows 开发请使用上面的 pnpm 流程。生成的 `dist/`、`.next/`、`node_modules/` 等继续忽略。

## 后续修复：同时更新站点和 GitHub

用户已授权：以后修复或优化这两个站点，在同一任务内完成对应站点源码的远程 GitHub 同步，不需要逐次询问。具体约定保存在根和本目录的 `AGENTS.md`，Claude 入口保存在 `CLAUDE.md`。

这是一项随开发任务执行的交付要求。目前没有配置后台监听或 GitHub 自动部署；GitHub 提交与 Sites 发布都需要独立完成和核验。

### 从 Sites 开始修改

1. 读取原站配置、最新源码和本仓库最新分支，核对 `.source-snapshot.json`，保留两端可能存在的较新修改。
2. 在对应的 Sites 源码项目中修改，完成与改动有关的检查，沿用既有 `.openai/hosting.json` 发布原站；不要新建站点代替原网址。
3. 确认发布成功，记录实际发布版本、部署 ID 和源码提交。使用下方导入命令同步该提交的全部受 Git 跟踪文件。
4. 验证清单与哈希，审查本任务差异，按项目约定创建中文提交并推送 `hub-search` 当前已配置的上游；核验远端确实包含该提交。
5. 交付时同时提供原站 URL/版本与 GitHub 路径/提交。若一端失败，说明其实际状态，不把另一端成功当作全部完成。

### 从 GitHub / Claude Code 开始修改

1. 在上述对应目录修改并检查，保留来源快照作为变更基线。
2. 读取原 Site 最新源码；如果线上已有新改动，先审查、合并，再将本次修改应用到正确 Site 源码仓库。不要复制嵌套 `.git`、依赖缓存或 GitHub 专用的 `.source-snapshot.json`。
3. 保留原 Site 项目 ID 和原网址，完成构建与发布。若当前 Claude 会话没有 Sites 发布能力，将代码保存在 GitHub 并明确说明“源码已更新，原站尚待发布”，由有 Sites 能力的会话继续完成。
4. 发布后，用实际源码提交重新导入并核验镜像。如果镜像中的本次修改已与发布源逐字节一致，可使用 `--accept-matching-changes` 更新来源快照；这个选项只接受与新源完全一致的修改，不覆盖有冲突的内容。
5. 推送最终来源记录，确认站点更新与 GitHub 同步两项结果。用户当次要求暂不发布时，保存代码并注明待发布，不能把未发布代码标成线上版本。

## 导入与核验工具

[scripts/sync-site-sources.py](../scripts/sync-site-sources.py) 使用 Python 标准库，仅从本地 Sites Git checkout 的指定提交复制源码，不访问网络、不持有令牌、不执行推送或部署。

以下占位参数必须替换为本次核实的真实路径、源码提交和成功发布记录：

```bash
python3 scripts/sync-site-sources.py import \
  --site mobile \
  --source /path/to/mobile-site-checkout \
  --commit FULL_PUBLISHED_SOURCE_COMMIT \
  --version PUBLISHED_VERSION_NUMBER \
  --deployment-id VERIFIED_DEPLOYMENT_ID
```

工作台使用 `--site workspace` 和其自己的来源参数；独立任务流程实验室使用 `--site taskflow`。在仓库根目录统一核验：

```bash
python3 scripts/sync-site-sources.py verify
```

工具从 Git 提交读取全部源码，保留静态资源与可执行模式；检查项目 ID，阻止明显凭据/缓存进入镜像，拒绝覆盖未合并的目标修改，更新时仅移除旧快照已管理且新源已经删除的文件。默认遇到镜像已变更即拒绝覆盖；不要删除快照或手改哈希来绕过保护。导入期间应独占该站点目录，暂停其他编辑任务；工具的互斥锁只约束同时运行的导入，不代替编辑器协作。工具不能验证远程部署是否成功，来源版本与部署状态需要先通过 Sites 核实。

## 本次导入验证与边界

- 20 个手机端文件、222 个工作台文件从各自已发布的源码 Git 提交原样导入；逐文件核验内容与模式，并保存来源清单。
- 手机端现有 `node checks/mobile-checks.cjs` 通过，6 个 JavaScript 文件的 `node --check` 全部通过。
- 工作台保留完整配置、组件、静态资源、文档和 `pnpm-lock.yaml`；本次未改应用逻辑，未重新安装依赖、构建或开展浏览器验收。既有 README 中的历史验证记录仍是历史记录。
- 源码导入不包含用户浏览器的 localStorage / IndexedDB 记录、运行数据库、账户连接或密钥。两站各自 README 中的演示能力和真实后端限制继续适用。
- 这次同步没有把移动端原型当作 Issue #32 的真实 VPS / Android 验收，也未因此修改业务 Issue 或看板状态。

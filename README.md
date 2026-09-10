# Codex Telegram Bot

通过 Telegram 查看本机 Codex 任务、最近 48 小时聊天记录、订阅进度、排队后续消息，并在任务回合完成后收到通知。

## 接入方式

- **任务列表、消息排队**：用 Codex CLI 启动独立的 stdio App Server，调用公开的 `thread/list` 和实验性的 `thread/queue/add`。
- **运行进度、历史和完成事件**：只读访问 Codex 的本地历史日志数据库 `thread_history_1.sqlite`。使用 SQL 读取结构化记录，不扫描 SQLite 二进制文本。
- **Telegram**：本地长轮询 `getUpdates`，不需要部署服务、域名或开放入站端口。

不再使用桌面私有 socket，不需要 `CODEX_CONTEXT_THREAD_ID` 或 `CODEX_APP_TOOLS_PIPE_PATH`；旧 `.env` 中这两项会被忽略。也不需要安装 CLI 的受管理 standalone daemon。

**排队成功不等于桌面开始执行。** 回复会写入原任务队列；桌面跨进程自动消费尚未保证，如任务没有继续，请在桌面中启动排队消息。Bot 不会自动恢复一个正在执行的桌面任务，也不会启动重复执行进程。

## 启动

要求 Node.js 22.13+（支持 `node:sqlite`）、提供 `app-server` 与 `thread/queue/add` 的 Codex CLI，以及包含 `thread_items` / `thread_turns` 的分页历史数据库。已在本机内置 CLI 0.153.4 上验证。

```sh
npm install
cp .env.example .env
```

编辑 `.env`：

```dotenv
TELEGRAM_BOT_TOKEN=从BotFather获取
ALLOWED_TELEGRAM_USER_IDS=你的Telegram数字用户ID
```

如果 `.env` 已存在，保留并编辑它，不要覆盖已有 Token。

可选配置：

| 配置 | 用途 |
| --- | --- |
| `CODEX_CLI_PATH` | CLI 可执行文件的绝对路径；默认优先使用 macOS 桌面内置 CLI，其次 PATH |
| `CODEX_HOME` | 数据目录，默认 `~/.codex` |
| `CODEX_HISTORY_DB` | 历史数据库的绝对路径；默认从数据目录发现 |
| `BOT_STATE_DIR` | Bot 状态目录；默认按 Bot 身份隔离在 `.bot/` 下 |
| `POLL_INTERVAL_MS` | 进度与完成事件检查间隔，默认 5000，最少 3000 毫秒 |

```sh
sh scripts/run-local.sh doctor
sh scripts/run-local.sh start
```

`doctor` 不需要 Telegram 配置。它临时启动独立 App Server，只读检查列表、历史和完成事件，不发送消息、不调用模型。`start` 会注册 Telegram 命令，并切换到长轮询（保留未接收的更新）。

向 Bot 发送 `/start` 后即可使用。只接受白名单用户的私聊；每位接收通知的用户都必须先与 Bot 对话。

## 命令

| 命令 | 功能 |
| --- | --- |
| `/list` | 最近最多 100 个本机主任务，排除子代理，按本地记录标示状态 |
| `/history` | 最近 48 小时的消息预览，点击编号查看全文 |
| `/reply 内容` 或直接发送文字 | 向选中任务排队后续消息 |
| `/watch` | 持续更新选中任务的最新进度卡片 |
| `/unwatch` | 取消进度卡片订阅，不关闭完成通知 |
| `/notify on` / `/notify off` | 开关所有已发现主任务的完成通知，默认开启 |
| `/status` | 检查独立 App Server 和本地数据访问 |
| `/cancel` | 取消选中任务 |

历史记录默认从最新消息开始，每页最多 12 条，每条预览最多 160 个字符。点击消息编号查看全文，长消息按最多 2800 个字符分段，可前后翻页，再返回原来的列表页。翻页会更新原来的 Telegram 卡片；如果卡片已被删除，则发送一张新卡片。

列表支持查看更早、较新的记录。浏览时固定本次查询的截止时间，避免新消息插入后打乱页序；点击“刷新到最新”重新查询。所有内容仍限制在最近 48 小时内，已过期的记录会提示不可查看。预览直接截取原文，不调用模型生成摘要；全文按需读取，不再截断到 16000 字符。

完成通知独立于 `/watch`。每次收到明确的 `thread_turns.status = completed` 记录，会推送任务标题、完成时间和该回合最终输出。以任务 ID、回合 ID 和接收用户去重，状态与发送队列持久化，重启不会重新生成同一条通知。首次启用不会推送以前的完成记录；停机期间的完成事件最多补查 48 小时。关闭后再开启也不补发关闭期间的通知。

## 状态与可靠性

- 当前实现适配分页 SQLite 历史。只产生旧 JSONL 的版本暂不支持，需要兼容的 Codex 版本。
- 独立 App Server 的 `notLoaded` 不能描述桌面运行状态，因此 Bot 使用本地回合记录。`inProgress` 且最近 30 分钟有记录时显示进行中；超过该时限显示未知，绝不因静默推断完成。长时间无日志的工具执行也可能显示未知。
- 部分任务的当前 rollout 文件采用 `任务ID_日志ID.jsonl` 命名，历史库使用末尾的日志 ID。Bot 根据 App Server 返回的当前文件路径及历史库记录关联这两个 ID；状态、进度、历史和完成通知读取对应日志，回复与通知按钮使用原桌面任务 ID。
- 完成通知表示**一个任务回合完成**，不保证持续目标或整个多回合工作流已经结束。失败、中断和未知状态不会冒充完成。
- 运行进度取最近的助手消息，速度受日志落盘和轮询间隔影响，不是模型逐 token 流。App Server 临时断连时，已发现任务的日志进度和完成检查继续工作；新任务发现需等待连接恢复。
- 回复超时或连接中断后，结果可能未知；程序不会自动重试写入，避免重复排队。Telegram 网络错误和 429 会重试。发送响应丢失的极端情况下仍可能出现重复通知。
- 完成通知发送队列保留 48 小时。Bot 需保持运行且电脑在线；用户屏蔽 Bot 或 Telegram 返回永久错误时无法送达。
- 本地 `.env` 和 `.bot/` 已加入忽略规则。不要提交 Token 或复制个人日志进仓库。

## 验证

```sh
npm run check
sh scripts/run-local.sh doctor
```

测试覆盖 stdio 协议与断线恢复、排队不重试、只读历史与明确完成事件、完成推送去重/重启/开关、白名单、按钮作用域、历史卡片翻页与返回、长消息全文还原与时间范围、长轮询游标与 Telegram 重试。

先前的实测过程见 [CLI 与桌面执行实例验证](docs/cli-daemon-verification.md)。

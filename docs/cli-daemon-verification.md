# CLI 与桌面任务共用执行实例验证

日期：2026-09-10。验证对象为当前机器的 ChatGPT 桌面应用及其内置 `codex-cli 0.153.4`。

## 结论

当前桌面 App Server 与另行启动的 CLI App Server **没有共用运行中的任务实例**。后者可以读取同一个任务 ID 的持久化摘要，并接受真实 `codex queue` 命令对该 ID 的排队请求。

因此，“CLI 完全不能为桌面任务排队消息”的判断不成立；但“排队成功等于已送入桌面正在执行的回合”也没有得到验证。当前结果不足以把 CLI queue 作为具有即时回复保证的桌面控制接口。

## 本机实测

| 检查 | 结果 |
| --- | --- |
| 桌面运行进程 | App Server PID 75346，父进程为桌面应用 PID 74854 |
| 桌面连接方式 | 启动参数没有 `--listen`，默认 `stdio://`；FD 0/1/2 为无文件路径的 Unix socket pair，没有发现具名 Unix 监听入口或 TCP 监听端口 |
| CLI 默认共享 daemon | 默认控制 socket 不存在 |
| `app-server daemon start` | 失败；要求受安装器管理的 `~/.codex/packages/standalone/current/codex`，当前机器没有该安装 |
| 替代验证 | 使用同一个内置二进制、默认本机数据目录，在临时具名 Unix socket 上手动启动独立 App Server；通过 WebSocket Upgrade 连接 |
| 桌面当前任务 | 原生桌面工具在验证前后均报告 `active` |
| 独立服务 `thread/loaded/list` | 排队前后均返回空数组 |
| 独立服务 `thread/read` | 同一个任务 ID 可读，`status.type = notLoaded`，`historyMode = paginated` |
| 真正的 CLI `queue --remote unix://…` | 退出码 0，返回 `Queued message … for thread …` |
| 排队后观察 | 2 秒后诊断项仍在队列，独立服务的已加载任务列表仍为空 |
| 清理 | 按返回的精确队列项 ID 删除，返回 `deleted: true`；再次读取确认诊断项已不存在。测试服务和临时 socket 已停止/清理 |

被测任务 ID：`01a089ce-60b5-75c0-a2a6-054e5f5ef0f9`，即本次验证所在任务。没有对其他真实任务发送消息。

## queue 的协议行为

先把 CLI 连接到隔离的本机模拟服务，捕获并拒绝所有任务操作。观察到以下序列：

```text
initialize (clientInfo.name = codex-tui, experimentalApi = true)
initialized
thread/queue/add (threadId, input, clientUserMessageId)
```

该 CLI 请求序列没有出现 `thread/resume`、`turn/start`、`turn/steer` 或 `thread/queue/start`。此项只证明客户端的请求行为，不能单独排除服务端的自动消费逻辑。

随后在真实的临时 App Server 上执行：

```sh
/Applications/ChatGPT.app/Contents/Resources/codex queue \
  --remote unix:///private/tmp/codex-bot-probe-20260910/server.sock \
  --thread 01a089ce-60b5-75c0-a2a6-054e5f5ef0f9 \
  --message '<明确标注的连通性诊断消息>'
```

命令成功，且通过另一个连接的 `thread/queue/list` 找到了对应项。诊断项随后被删除。这里的临时端点已关闭，以上命令只用于记录验证方法。

## 仍未得到证明的能力

- 桌面端是否会在当前回合结束后，自动发现并消费由独立服务写入的队列项。为避免触发额外执行，诊断项在回合结束前已删除；2 秒内未消费不代表永远不会消费。
- 桌面是否在其他版本、安装方式或正式配置下可以连接 CLI 的共享 daemon。本次结果仅针对当前机器和版本，没有安装 standalone 版来验证它。
- 独立服务能否准确报告桌面正在运行任务的实时状态。当前对比中，同一个任务在桌面为 `active`，在独立服务为 `notLoaded`，所以不能把后者用作桌面的实时状态来源。

桌面打包代码中的队列管理器会请求 `thread/queue/list`，并监听 `thread/queue/changed` 后刷新。这提供了后续查证线索，但本次没有证明该通知会跨独立服务进程传播，也没有证明所有自动消费路径。

## 对 Bot 的影响

可以继续研究将 CLI queue 用作“排队后续消息”的入口；产品上必须把“已排队”和“桌面已接收/开始执行”分开。当前不能仅靠另起 App Server 替代桌面原生的运行状态、实时推进或中断控制。

本次没有修改 Bot 的实现、桌面配置或鉴权设置，没有调用真实任务的 `turn/start`、`turn/steer`、`thread/resume` 或 `thread/queue/start`。

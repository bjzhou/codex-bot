import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient, codexBinary } from './app-server.ts';
import { HistoryStore } from './history.ts';
import { CodexService } from './service.ts';

const home = process.env.CODEX_HOME || join(homedir(), '.codex');
const server = new AppServerClient(codexBinary(), home);
let history: HistoryStore | undefined;
console.log(`运行时：${process.execPath} (${process.version})`);
console.log(`Codex CLI：${server.binary}`);
try {
  history = new HistoryStore(home, process.env.CODEX_HISTORY_DB || undefined);
  console.log(`✓ 本地历史日志可只读访问：${history.path}`);
  await server.connect();
  console.log('✓ 独立 App Server 已通过 stdio 连接，无需桌面内部接口或 standalone daemon');
  const service = new CodexService(server, history);
  const threads = await service.list();
  console.log(`✓ 读取 ${threads.length} 个本机任务；日志显示 ${threads.filter(t => t.status === 'running').length} 个正在进行`);
  if (threads[0]) {
    const page = await service.execute({ action: 'history', threadId: threads[0].id });
    if (page.kind === 'history') console.log(`✓ 48 小时历史首屏：${page.messages.length} 条`);
  }
  console.log(`✓ 完成事件读取正常：最近 48 小时 ${service.completions(Date.now() - 172800000).length} 条`);
  console.log('检查完成，未向 Telegram 发消息，也未调用模型。回复使用 queue/add；排队成功不保证桌面立即执行。');
} catch (error) { console.error(`✗ ${(error as Error).message}`); process.exitCode = 1; }
finally { await server.close(); history?.close(); }

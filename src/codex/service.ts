import { createHash, randomUUID } from 'node:crypto';
import type { AppServer } from './app-server.ts';
import { HistoryStore } from './history.ts';
import type { Command, CommandResult, Thread } from '../shared/protocol.ts';

export class CodexService {
  private catalog = new Map<string, Thread>();
  private logIds = new Map<string, string>();
  private logOwners = new Map<string, string>();
  private logId(id: string) { return this.logIds.get(id) || id; }
  constructor(readonly server: AppServer, readonly history: HistoryStore) {}
  async list(): Promise<Thread[]> {
    const data: any[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.server.call('thread/list', { limit: 100, sortKey: 'updated_at', sortDirection: 'desc', cursor,
        archived: false, useStateDbOnly: true, sourceKinds: ['cli', 'vscode', 'appServer', 'exec'] });
      if (!Array.isArray(result.data)) throw new Error('App Server 任务列表格式不兼容');
      data.push(...result.data.filter((t: any) => !t.parentThreadId && !(t.source && typeof t.source === 'object' && t.source.subAgent)));
      cursor = result.nextCursor || undefined;
      if (cursor && seen.has(cursor)) throw new Error('App Server 返回了重复的分页游标');
      if (cursor) seen.add(cursor);
    } while (cursor && data.length < 100 && seen.size < 20);
    const threads: Thread[] = data.slice(0, 100).map((t: any) => {
      const id = String(t.id);
      const logId = this.history.resolveThreadId(id, t.path);
      this.logIds.set(id, logId);
      this.logOwners.set(id, id);
      this.logOwners.set(logId, id);
      return { id, title: String(t.name || t.preview || '未命名聊天').slice(0, 500),
        status: this.history.logStatus(logId), updatedAt: Number(t.updatedAt || 0) * 1000, preview: String(t.preview || '').slice(0, 2000) };
    });
    for (const t of threads) this.catalog.set(t.id, t);
    return threads;
  }
  completions(since: number) {
    return this.history.completions(since).flatMap(e => {
      const threadId = this.logOwners.get(e.threadId);
      const thread = threadId && this.catalog.get(threadId);
      return thread ? [{ ...e, threadId: thread.id, title: thread.title }] : [];
    });
  }
  localThreads(): Thread[] {
    return [...this.catalog.values()].map(t => ({ ...t, status: this.history.logStatus(this.logId(t.id)) }));
  }
  async execute(command: Command): Promise<CommandResult> {
    if (command.action === 'list') return { kind: 'list', threads: await this.list() };
    const target = (await this.list()).find(t => t.id === command.threadId);
    if (!target) throw new Error('聊天不在最近的本机 Codex 列表中，请 /list 重新选择。');
    if (command.action === 'history') return { ...this.history.page(this.logId(target.id), command.before, command.since, Date.now(), command.until), threadId: target.id };
    if (command.action === 'message') return { ...this.history.message(this.logId(target.id), command.itemId, command.page, command.since, Date.now(), command.until), threadId: target.id };
    const result = await this.server.call('thread/queue/add', { threadId: target.id,
      input: [{ type: 'text', text: command.text }], clientUserMessageId: randomUUID() });
    if (!result?.queuedSubmission?.id) throw new Error('排队结果未确认；请查看原任务，避免重复发送。');
    return { kind: 'reply', threadId: target.id, message: '消息已加入原任务队列。尚未确认桌面已开始执行；如未自动继续，请在桌面任务中启动排队消息。' };
  }
  progress(thread: Thread) {
    const latest = this.history.progress(this.logId(thread.id));
    return { type: 'progress' as const, thread, text: latest.text,
      fingerprint: createHash('sha256').update(`${thread.status}:${latest.itemId}:${latest.text}`).digest('hex') };
  }
}

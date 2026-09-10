import { randomUUID } from 'node:crypto';
import { labels, type Command, type CommandResult, type Thread } from '../shared/protocol.ts';
import { authorized, splitText, updateSchema, TelegramError, type Keyboard, type TelegramApi, type TelegramUpdate } from './telegram.ts';
import { Store } from './store.ts';
import type { Completion } from '../codex/history.ts';
import { previewText } from '../shared/text.ts';

export interface CodexBackend {
  list(): Promise<Thread[]>;
  execute(command: Command): Promise<CommandResult>;
  progress(thread: Thread): { thread: Thread; text: string; fingerprint: string };
  completions?(since: number): Array<Completion & { title: string }>;
  localThreads?(): Thread[];
}
type Session = { selected?: string; threads?: Thread[]; watch?: string; watchVersion?: string; progressMessageId?: number; fingerprint?: string; notify?: boolean; notifySince?: number };
type Action = { chatId: number; expires: number; op: string; threadId?: string; before?: number; since?: number; until?: number; page?: number; itemId?: string; newer?: string; returnTo?: string };
export type Job = { id: string; chatId: number; command: Command; expires: number; state: 'pending' | 'running'; viewMessageId?: number; newer?: string; returnTo?: string };
type Watch = { chatId: number; threadId: string; version: string; fingerprint: string };
type Outbox = { method: string; body: Record<string, any>; expires: number; revision: string; watch?: Watch; historyView?: boolean };
const HELP = 'Codex Telegram Bot\n\n/list — 最近聊天，状态来自本地记录\n/history — 选中聊天的最近 48 小时记录\n/watch — 订阅进度\n/unwatch — 取消进度订阅\n/notify on 或 off — 开关所有任务的完成通知（默认开启）\n/status — 检查本地服务\n/reply 内容 — 向选中聊天排队消息\n/cancel — 取消选择\n\n点击列表里的聊天后，直接发送文字即可排队。已排队不代表桌面已开始执行。完成通知不需要 /watch；仅推送启用通知后完成的任务回合。';

export class Bot {
  private jobsBusy = false;
  private progressBusy = false;
  private outboxBusy = false;
  constructor(readonly store: Store, private codex: CodexBackend, private api: TelegramApi, private allowed: string, private now = Date.now) {
    if (store.get('monitorSince') === undefined) store.put('monitorSince', now());
  }
  private isAllowed(chatId: number) { return this.allowed.split(',').map(s => s.trim()).includes(String(chatId)); }
  private queue(id: string, method: string, body: Record<string, any>, watch?: Watch) {
    this.store.put(`out:${id}`, { method, body, expires: this.now() + 3600000, revision: randomUUID(), watch } satisfies Outbox);
  }
  private say(id: string, chatId: number, text: string, keyboard?: Keyboard) {
    const parts = splitText(text);
    parts.forEach((part, i) => this.queue(`${id}:${String(i).padStart(3, '0')}`, 'sendMessage', {
      chat_id: chatId, text: part, ...(i === parts.length - 1 && keyboard ? { reply_markup: keyboard } : {}),
    }));
  }
  private button(chatId: number, text: string, action: Omit<Action, 'chatId' | 'expires'>) {
    const id = randomUUID().replaceAll('-', '').slice(0, 20);
    this.store.put(`action:${id}`, { ...action, chatId, expires: this.now() + 86400000 });
    return { text, callback_data: `a:${id}` };
  }
  private controls(chatId: number, id: string): Keyboard {
    return { inline_keyboard: [[
      this.button(chatId, '📜 48 小时记录', { op: 'history', threadId: id }),
      this.button(chatId, '📡 订阅进度', { op: 'watch', threadId: id }),
    ], [this.button(chatId, '💬 回复此聊天', { op: 'select', threadId: id })]] };
  }
  private listPage(key: string, chatId: number, session: Session, page = 0) {
    const threads = session.threads || [];
    const start = Math.max(0, page) * 8;
    const items = threads.slice(start, start + 8);
    if (!items.length) return this.say(key, chatId, '没有最近的本机 Codex 聊天。');
    const rows = items.map(t => [this.button(chatId, `${labels[t.status]} · ${t.title.slice(0, 42)}`, { op: 'select', threadId: t.id })]);
    const nav = [];
    if (start > 0) nav.push(this.button(chatId, '← 上一页', { op: 'page', page: page - 1 }));
    if (start + 8 < threads.length) nav.push(this.button(chatId, '下一页 →', { op: 'page', page: page + 1 }));
    if (nav.length) rows.push(nav);
    const counts = Object.entries(labels).map(([status, label]) => `${label} ${threads.filter(t => t.status === status).length}`).filter(s => !s.endsWith(' 0')).join(' · ');
    this.say(key, chatId, `最近聊天 · 第 ${page + 1}/${Math.ceil(threads.length / 8)} 页\n${counts}\n点击选择聊天。`, { inline_keyboard: rows });
  }
  private job(key: string, chatId: number, command: Command, view?: Pick<Job, 'viewMessageId' | 'newer' | 'returnTo'>) {
    this.store.put(`job:${key}`, { id: key, chatId, command, expires: this.now() + 90000, state: 'pending', ...view } satisfies Job);
  }
  private historyView(job: Job, text: string, keyboard: Keyboard) {
    if (!job.viewMessageId) return this.say(job.id, job.chatId, text, keyboard);
    this.queue(job.id, 'editMessageText', { chat_id: job.chatId, message_id: job.viewMessageId, text, reply_markup: keyboard });
    const key = `out:${job.id}`;
    this.store.put(key, { ...this.store.get<Outbox>(key)!, historyView: true });
  }
  /** Commit offset and effects together before getUpdates acknowledges the update. */
  ingest(raw: unknown) {
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) {
      // Unsupported future update formats must not poison the polling cursor.
      const id = (raw as any)?.update_id;
      if (Number.isSafeInteger(id) && id >= 0) this.store.put('offset', Math.max(this.offset, id + 1));
      return;
    }
    const update = parsed.data;
    this.store.transaction(() => {
      if (!this.store.get(`seen:${update.update_id}`)) {
        const chatId = authorized(update, this.allowed);
        if (chatId !== undefined) {
          const key = `${this.now()}:${update.update_id}`;
          const rate = this.store.get<{ count: number; expires: number }>(`rate:${chatId}`) || { count: 0, expires: this.now() + 60000 };
          if (rate.expires <= this.now()) { rate.count = 0; rate.expires = this.now() + 60000; }
          rate.count++; this.store.put(`rate:${chatId}`, rate);
          if (rate.count <= 30) this.handle(key, chatId, update);
          else if (rate.count === 31) this.say(key, chatId, '操作过于频繁，请一分钟后再试。');
        }
        this.store.put(`seen:${update.update_id}`, { expires: this.now() + 7 * 86400000 });
      }
      this.store.put('offset', Math.max(this.offset, update.update_id + 1));
    });
  }
  get offset() { return this.store.get<number>('offset') || 0; }
  private handle(key: string, chatId: number, update: TelegramUpdate) {
    const session = this.store.get<Session>(`user:${chatId}`) || {};
    session.notifySince ??= this.now();
    let op: string; let argument = ''; let action: Action | undefined;
    if (update.callback_query) {
      this.queue(`!answer:${key}`, 'answerCallbackQuery', { callback_query_id: update.callback_query.id });
      const data = update.callback_query.data || '';
      action = data.startsWith('a:') ? this.store.get<Action>(`action:${data.slice(2)}`) : undefined;
      if (!action || action.chatId !== chatId || action.expires < this.now()) return this.say(key, chatId, '按钮已过期，请 /list 重新打开。');
      op = action.op;
      if (action.threadId) session.selected = action.threadId;
    } else {
      const text = update.message?.text?.trim();
      if (!text) return this.say(key, chatId, '目前仅支持文字消息，请 /list 选择聊天。');
      if (text.startsWith('/')) {
        const match = text.match(/^\/([a-z]+)(?:@[\w]+)?(?:\s+([\s\S]*))?$/i);
        op = match?.[1].toLowerCase() || 'help'; argument = match?.[2] || '';
      } else { op = 'reply'; argument = text; }
    }
    if (op === 'list') this.job(key, chatId, { action: 'list' });
    else if (op === 'page') this.listPage(key, chatId, session, action?.page);
    else if (op === 'notify') {
      if (argument && !['on', 'off'].includes(argument.toLowerCase())) this.say(key, chatId, '用法：/notify on 或 /notify off');
      else {
        if (argument) {
          session.notify = argument.toLowerCase() === 'on';
          if (session.notify) session.notifySince = this.now();
          else for (const [outKey] of this.store.list(`out:completion:${chatId}:`)) this.store.delete(outKey);
        }
        this.say(key, chatId, session.notify === false ? '已关闭任务完成通知。' : '已开启任务完成通知；无需订阅单个任务。');
      }
    } else if (op === 'status') {
      this.store.put(`status:${key}`, { chatId, key });
    } else if (op === 'cancel') { delete session.selected; this.say(key, chatId, '已取消选择。使用 /list 选择聊天。'); }
    else if (op === 'unwatch') {
      delete session.watch; delete session.watchVersion; delete session.progressMessageId; delete session.fingerprint;
      this.store.delete(`out:progress:${chatId}`); this.say(key, chatId, '已取消进度订阅。');
    } else if (['select', 'history', 'message', 'watch', 'reply'].includes(op)) {
      if (!session.selected) return this.say(key, chatId, '请先 /list 并点击选择聊天。');
      if (op === 'select') {
        const title = session.threads?.find(t => t.id === session.selected)?.title || session.selected;
        this.say(key, chatId, `已选择：${title}\n\n直接发送文字即可加入此任务的消息队列。`, this.controls(chatId, session.selected));
      } else if (op === 'history') this.job(key, chatId, { action: 'history', threadId: session.selected, before: action?.before, since: action?.since, until: action?.until },
        { viewMessageId: update.callback_query?.message?.message_id, newer: action?.newer });
      else if (op === 'message') {
        if (!action?.itemId) return this.say(key, chatId, '请点击历史列表中的消息按钮查看全文。');
        this.job(key, chatId, { action: 'message', threadId: session.selected, itemId: action.itemId, page: action.page || 0, since: action.since, until: action.until },
          { viewMessageId: update.callback_query?.message?.message_id, returnTo: action.returnTo });
      }
      else if (op === 'reply') {
        if (!argument) return this.say(key, chatId, '用法：/reply 消息内容，或直接发送文字。');
        if (argument.length > 16000) return this.say(key, chatId, '单次回复请控制在 16000 字符以内。');
        if (!update.message?.date || this.now() - update.message.date * 1000 > 90000) return this.say(key, chatId, '这条回复已超过 90 秒，未交给 Codex 执行。请确认当前聊天后重新发送。');
        this.job(key, chatId, { action: 'reply', threadId: session.selected, text: argument });
      } else {
        session.watch = session.selected; session.watchVersion = randomUUID(); delete session.progressMessageId; delete session.fingerprint;
        this.store.delete(`out:progress:${chatId}`); this.say(key, chatId, '已订阅该聊天的实时进度；/unwatch 可取消。');
      }
    } else this.say(key, chatId, HELP);
    this.store.put(`user:${chatId}`, session);
  }
  private deliver(job: Job, result: CommandResult) {
    const { chatId, id } = job;
    const session = this.store.get<Session>(`user:${chatId}`) || {};
    if (result.kind === 'list') {
      session.threads = result.threads.map(({ preview, ...thread }) => thread);
      this.store.put(`user:${chatId}`, session); this.listPage(id, chatId, session);
    } else if (result.kind === 'history') {
      const title = session.threads?.find(t => t.id === result.threadId)?.title || result.threadId;
      const until = result.until ?? this.now();
      const before = job.command.action === 'history' ? job.command.before : undefined;
      const current = this.button(chatId, '返回记录列表', { op: 'history', threadId: result.threadId, before, since: result.since, until, newer: job.newer });
      const content = result.messages.map((m, i) => `${i + 1}. ${new Date(m.timestamp).toISOString().slice(5, 16).replace('T', ' ')} · ${m.role === 'user' ? '你' : 'Codex'}\n${previewText(m.text) || '[空消息]'}`).join('\n\n');
      const keyboard: Keyboard = { inline_keyboard: [] };
      const nav: Keyboard['inline_keyboard'][number] = [];
      if (job.newer) nav.push({ text: '较新记录 →', callback_data: job.newer });
      if (result.nextBefore !== undefined) nav.push(this.button(chatId, '← 更早记录', { op: 'history', threadId: result.threadId, before: result.nextBefore, since: result.since, until, newer: current.callback_data }));
      if (nav.length) keyboard.inline_keyboard.push(nav);
      const buttons = result.messages.map((m, i) => this.button(chatId, `${i + 1}. ${m.role === 'user' ? '你' : 'Codex'} · 查看全文`,
        { op: 'message', threadId: result.threadId, itemId: m.id, page: 0, since: result.since, until, returnTo: current.callback_data }));
      for (let i = 0; i < buttons.length; i += 2) keyboard.inline_keyboard.push(buttons.slice(i, i + 2));
      keyboard.inline_keyboard.push([this.button(chatId, '刷新到最新', { op: 'history', threadId: result.threadId }), this.button(chatId, '回复此任务', { op: 'select', threadId: result.threadId })]);
      this.historyView(job, `${previewText(title, 120)} · 最近 48 小时\n时间：UTC · 每页最多 12 条预览\n点击编号查看全文\n\n${content || '最近 48 小时内暂无聊天记录。'}`, keyboard);
    } else if (result.kind === 'message') {
      const title = session.threads?.find(t => t.id === result.threadId)?.title || result.threadId;
      const keyboard: Keyboard = { inline_keyboard: [] };
      const nav: Keyboard['inline_keyboard'][number] = [];
      const action = { op: 'message', threadId: result.threadId, itemId: result.itemId, since: result.since, until: result.until, returnTo: job.returnTo };
      if (result.page > 0) nav.push(this.button(chatId, '← 上一段', { ...action, page: result.page - 1 }));
      if (result.page + 1 < result.pages) nav.push(this.button(chatId, '下一段 →', { ...action, page: result.page + 1 }));
      if (nav.length) keyboard.inline_keyboard.push(nav);
      keyboard.inline_keyboard.push([job.returnTo ? { text: '↩ 返回记录列表', callback_data: job.returnTo }
        : this.button(chatId, '↩ 返回记录列表', { op: 'history', threadId: result.threadId })]);
      this.historyView(job, `${previewText(title, 120)} · ${result.role === 'user' ? '你' : 'Codex'}\n${new Date(result.timestamp).toISOString()}\n第 ${result.page + 1}/${result.pages} 段\n\n${result.text}`, keyboard);
    } else this.say(id, chatId, result.kind === 'error' ? `操作未确认成功：${result.message}` : result.message);
  }
  /** A crashed in-flight request is never replayed; its outcome is explicitly uncertain. */
  recover() {
    this.store.transaction(() => {
      for (const [key, job] of this.store.list<Job>('job:')) if (job.state === 'running') {
        if (this.isAllowed(job.chatId)) this.deliver(job, { kind: 'error', message: '上次请求执行中进程退出，结果未确认。为避免重复回复，不会自动重发；请先查看原聊天。' });
        this.store.delete(key);
      }
    });
  }
  async runJobs() {
    if (this.jobsBusy) return; this.jobsBusy = true;
    try {
      const entry = this.store.list<Job>('job:').find(([, j]) => j.state === 'pending');
      if (!entry) return;
      const [key, job] = entry;
      if (!this.isAllowed(job.chatId)) { this.store.delete(key); return; }
      job.state = 'running'; this.store.put(key, job);
      let result: CommandResult;
      try {
        if (job.expires <= this.now()) throw new Error('请求已过期，请重新操作。');
        result = await this.codex.execute(job.command);
      } catch (error) { result = { kind: 'error', message: String((error as Error).message).slice(0, 3500) }; }
      this.store.transaction(() => { this.deliver(job, result); this.store.delete(key); });
    } finally { this.jobsBusy = false; }
  }
  async pollProgress() {
    if (this.progressBusy) return; this.progressBusy = true;
    try {
      const statuses = this.store.list<{ chatId: number; key: string }>('status:');
      if (!statuses.length && !this.store.list<Session>('user:').some(([, s]) => s.watch || s.notify !== false)) return;
      let threads: Thread[] = []; let error = '';
      try { threads = await this.codex.list(); } catch {
        error = '🔴 独立 App Server 暂不可用，请运行 doctor 检查 CLI；已有任务的完成记录仍会继续检查。';
        try { threads = this.codex.localThreads?.() || []; } catch { /* Keep polling if the history store is temporarily busy. */ }
      }
      this.pollCompletions();
      for (const [key, status] of statuses) {
        this.store.transaction(() => {
          if (this.isAllowed(status.chatId)) this.say(status.key, status.chatId, error || '🟢 本地 Bot、独立 App Server 和历史记录可用。运行状态来自日志；排队消息不保证桌面立即执行。');
          this.store.delete(key);
        });
      }
      for (const [key, session] of this.store.list<Session>('user:')) {
        const chatId = Number(key.slice(5));
        if (!session.watch || !this.isAllowed(chatId)) continue;
        const thread = threads.find(t => t.id === session.watch);
        let progress: { fingerprint: string; text: string };
        try { progress = thread ? this.codex.progress(thread) : { fingerprint: error || 'missing', text: error || '聊天已不在最近列表中，请 /list 重新选择。' }; }
        catch { continue; } // Retry a temporarily locked history database on the next poll.
        if (session.fingerprint === progress.fingerprint || this.store.get<Outbox>(`out:progress:${chatId}`)?.watch?.fingerprint === progress.fingerprint) continue;
        this.queue(`progress:${chatId}`, session.progressMessageId ? 'editMessageText' : 'sendMessage', {
          chat_id: chatId, text: thread ? `${labels[thread.status]} · ${thread.title.slice(0, 120)}\n\n${progress.text}` : progress.text,
          ...(session.progressMessageId ? { message_id: session.progressMessageId } : {}),
        }, { chatId, threadId: session.watch, version: session.watchVersion!, fingerprint: progress.fingerprint });
      }
    } finally { this.progressBusy = false; }
  }
  private pollCompletions() {
    if (!this.codex.completions) return;
    let events: Array<Completion & { title: string }>;
    try { events = this.codex.completions(this.store.get<number>('monitorSince') ?? this.now()); }
    catch (error) { console.error('读取任务完成记录失败', (error as Error).message); return; }
    this.store.transaction(() => {
      for (const [key, session] of this.store.list<Session>('user:')) {
        const chatId = Number(key.slice(5));
        if (!this.isAllowed(chatId) || session.notify === false) continue;
        for (const event of events) {
          if (event.completedAt < (session.notifySince ?? this.store.get<number>('monitorSince')!)) continue;
          const id = `completion:${chatId}:${event.threadId}:${event.turnId}`;
          if (this.store.get(id)) continue;
          this.say(id, chatId, `✅ 任务回合已完成 · ${event.title.slice(0, 120)}\n${new Date(event.completedAt).toISOString()}\n\n${event.text || '该回合已完成，暂无最终文字输出。'}`, this.controls(chatId, event.threadId));
          for (const [outKey, item] of this.store.list<Outbox>(`out:${id}:`)) { item.expires = this.now() + 48 * 3600000; this.store.put(outKey, item); }
          this.store.put(id, { expires: this.now() + 7 * 86400000 });
        }
      }
    });
  }
  async flush(signal?: AbortSignal) {
    if (this.outboxBusy || (this.store.get<number>('sendAfter') || 0) > this.now()) return;
    this.outboxBusy = true;
    try {
      for (const [key, item] of this.store.list<Outbox>('out:')) {
        if (item.expires <= this.now() || (item.body.chat_id && !this.isAllowed(item.body.chat_id))) { this.store.delete(key); continue; }
        const throttleKey = `throttle:${item.body.chat_id}`;
        if (item.body.chat_id && (this.store.get<number>(throttleKey) || 0) > this.now()) continue;
        try {
          const result = await this.api(item.method, item.body, signal);
          this.store.transaction(() => {
            const current = this.store.get<Outbox>(key);
            if (item.watch) {
              const session = this.store.get<Session>(`user:${item.watch.chatId}`);
              if (session?.watchVersion === item.watch.version) {
                session.progressMessageId = result.message_id; session.fingerprint = item.watch.fingerprint;
                this.store.put(`user:${item.watch.chatId}`, session);
                if (current && current.revision !== item.revision) {
                  current.method = 'editMessageText'; current.body.message_id = result.message_id; this.store.put(key, current);
                }
              }
            }
            if (current?.revision === item.revision) this.store.delete(key);
            if (item.body.chat_id) this.store.put(throttleKey, this.now() + 1100);
          });
        } catch (error) {
          if (signal?.aborted) return;
          if (error instanceof TelegramError && [401, 404, 409].includes(error.code)) throw error;
          if (error instanceof TelegramError && error.permanent) {
            if (error.code === 400 && item.historyView && this.store.get<Outbox>(key)?.revision === item.revision) {
              const { message_id, ...body } = item.body;
              this.store.put(key, { ...item, method: 'sendMessage', body, historyView: false });
              return; // Deleted/uneditable history card: recover with a single new message.
            }
            const session = item.body.chat_id ? this.store.get<Session>(`user:${item.body.chat_id}`) : undefined;
            if (session && item.watch && session.watchVersion === item.watch.version) {
              if (error.code === 403) { delete session.watch; delete session.watchVersion; }
              delete session.progressMessageId; delete session.fingerprint;
              this.store.put(`user:${item.body.chat_id}`, session);
            }
            if (this.store.get<Outbox>(key)?.revision === item.revision) this.store.delete(key);
            console.error('Telegram 拒绝一条发送请求', { method: item.method, code: error.code });
          } else this.store.put('sendAfter', this.now() + (error instanceof TelegramError ? error.retryAfter : 5) * 1000);
        }
        return; // At most one outbound request per tick; keep polling responsive.
      }
    } finally { this.outboxBusy = false; }
  }
  cleanup() {
    this.store.transaction(() => {
      for (const prefix of ['seen:', 'action:', 'rate:', 'completion:']) for (const [key, value] of this.store.list<{ expires: number }>(prefix)) {
        if (value.expires < this.now()) this.store.delete(key);
      }
    });
  }
}

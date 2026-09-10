import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/bot/store.ts';
import { Bot, type CodexBackend, type Job } from '../src/bot/controller.ts';
import { TelegramError, type TelegramApi } from '../src/bot/telegram.ts';
import { configureTelegram, pollOnce, run } from '../src/bot/runtime.ts';
import type { Command, Thread } from '../src/shared/protocol.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-local-'));
  let store = new Store(dir);
  let now = 1789019000000;
  let updateId = 1;
  let status: Thread['status'] = 'running';
  let progressText = '正在测试';
  const calls: Command[] = [];
  const delivered: { method: string; body: any }[] = [];
  const thread = (): Thread => ({ id: 'task-a', title: '测试聊天', status, updatedAt: now });
  const backend: CodexBackend = {
    async list() { return [thread()]; },
    async execute(command) {
      calls.push(command);
      if (command.action === 'list') return { kind: 'list', threads: await this.list() };
      if (command.action === 'history') return { kind: 'history', threadId: command.threadId, since: now - 172800000,
        messages: [{ id: 'm1', role: 'user', timestamp: now - 100, text: '用户提问' }, { id: 'm2', role: 'assistant', timestamp: now, text: 'Codex 回答' }], nextBefore: command.before ? undefined : 10 };
      return { kind: 'reply', threadId: command.threadId, message: '消息已送达' };
    },
    progress(t) { return { thread: t, text: progressText, fingerprint: `${status}:${progressText}` }; },
  };
  let fail: Error | undefined;
  const api: TelegramApi = async (method, body) => {
    if (fail) throw fail;
    delivered.push({ method, body }); return { message_id: delivered.length + 100 };
  };
  let bot = new Bot(store, backend, api, '7,8', () => now);
  const message = (text: string, user = 7, age = 0) => ({ update_id: updateId++, message: { message_id: updateId, date: Math.floor((now - age) / 1000), text, from: { id: user }, chat: { id: user, type: 'private' } } });
  const callback = (data: string, user = 7) => ({ update_id: updateId++, callback_query: { id: `c${updateId}`, from: { id: user }, data, message: { message_id: 100, chat: { id: user, type: 'private' } } } });
  const drain = async () => { for (let i = 0; i < 100 && store.list('out:').length; i++) { await bot.flush(); now += 1200; } };
  const select = async () => {
    bot.ingest(message('/list')); await bot.runJobs(); await drain();
    const list = delivered.find(d => d.body.reply_markup?.inline_keyboard[0][0].text.includes('测试聊天'))!;
    const action = list.body.reply_markup.inline_keyboard[0][0].callback_data;
    bot.ingest(callback(action)); await drain(); return action;
  };
  return { get bot() { return bot; }, get store() { return store; }, api, backend, delivered, calls, dir, message, callback, drain, select,
    advance(ms: number) { now += ms; }, fail(error?: Error) { fail = error; }, complete() { status = 'completed'; progressText = '全部完成'; },
    restart() { store.close(); store = new Store(dir); bot = new Bot(store, backend, api, '7,8', () => now); bot.recover(); },
    close() { store.close(); rmSync(dir, { recursive: true }); },
  };
}

test('local bot handles lists, scoped buttons, history pagination, replies and progress', async () => {
  const f = fixture();
  try {
    f.bot.ingest(f.message('/list', 9)); assert.equal(f.store.list('job:').length, 0);
    const button = await f.select();
    f.bot.ingest(f.callback(button, 8)); await f.drain();
    assert.ok(f.delivered.some(d => d.body.chat_id === 8 && d.body.text?.includes('按钮已过期')));
    const selected = f.delivered.find(d => d.body.text?.startsWith('已选择'))!;
    f.bot.ingest(f.callback(selected.body.reply_markup.inline_keyboard[0][0].callback_data));
    await f.bot.runJobs(); await f.drain();
    const history = f.delivered.find(d => d.body.text?.includes('Codex 回答'))!;
    assert.ok(history.body.text.includes('用户提问'));
    f.bot.ingest(f.callback(history.body.reply_markup.inline_keyboard[0][0].callback_data));
    await f.bot.runJobs(); await f.drain();
    assert.ok(f.calls.some(c => c.action === 'history' && c.before === 10));
    const reply = f.message('继续'); f.bot.ingest(reply); f.bot.ingest(reply);
    await f.bot.runJobs(); await f.bot.runJobs(); await f.drain();
    assert.deepEqual(f.calls.filter(c => c.action === 'reply'), [{ action: 'reply', threadId: 'task-a', text: '继续' }]);
    f.bot.ingest(f.message('/watch')); await f.drain(); await f.bot.pollProgress(); await f.drain();
    assert.ok(f.delivered.some(d => d.method === 'sendMessage' && d.body.text?.includes('正在测试')));
    f.complete(); await f.bot.pollProgress(); await f.drain();
    assert.ok(f.delivered.some(d => d.method === 'editMessageText' && d.body.text?.includes('全部完成')));
    const count = f.delivered.length; await f.bot.pollProgress(); await f.drain(); assert.equal(f.delivered.length, count);
    f.bot.ingest(f.message('/unwatch')); f.bot.ingest(f.message('/cancel')); await f.drain();
    f.bot.ingest(f.message('不应发送')); await f.bot.runJobs();
    assert.equal(f.calls.filter(c => c.action === 'reply').length, 1);
  } finally { f.close(); }
});

test('offset, session and deduplication persist across restart; stale replies are refused', async () => {
  const f = fixture();
  try {
    await f.select(); const reply = f.message('一次'); f.bot.ingest(reply);
    await f.bot.runJobs(); const offset = f.bot.offset;
    f.restart(); assert.equal(f.bot.offset, offset);
    f.bot.ingest(reply); await f.bot.runJobs();
    f.bot.ingest(f.message('积压消息', 7, 91000)); await f.bot.runJobs(); await f.drain();
    assert.equal(f.calls.filter(c => c.action === 'reply').length, 1);
    assert.ok(f.delivered.some(d => d.body.text?.includes('超过 90 秒')));
    f.bot.ingest(f.message('新消息')); await f.bot.runJobs();
    assert.equal(f.calls.filter(c => c.action === 'reply').length, 2);
  } finally { f.close(); }
});

test('crash recovery never replays an in-flight mutation; expired pending jobs do not run', async () => {
  const f = fixture();
  try {
    await f.select(); f.bot.ingest(f.message('in-flight'));
    const [key, job] = f.store.list<Job>('job:')[0]; job.state = 'running'; f.store.put(key, job);
    f.restart(); await f.bot.runJobs(); await f.drain();
    assert.equal(f.calls.filter(c => c.action === 'reply').length, 0);
    assert.ok(f.delivered.some(d => d.body.text?.includes('结果未确认')));
    f.bot.ingest(f.message('expired')); f.advance(91000); await f.bot.runJobs();
    assert.equal(f.calls.filter(c => c.action === 'reply').length, 0);
  } finally { f.close(); }
});

test('Telegram 429 preserves queued output and respects retry_after', async () => {
  const f = fixture();
  try {
    f.bot.ingest(f.message('/help'));
    f.fail(new TelegramError('limited', 20, false, 429)); await f.bot.flush();
    assert.equal(f.store.list('out:').length, 1); f.fail();
    await f.bot.flush(); assert.equal(f.delivered.length, 0);
    f.advance(20001); await f.bot.flush(); assert.equal(f.delivered.length, 1);
  } finally { f.close(); }
});

test('SQLite state has atomic rollback and excludes a second process using the same directory', () => {
  const f = fixture();
  try {
    assert.throws(() => new Store(f.dir), /已有 Bot/);
    assert.throws(() => f.store.transaction(() => { f.store.put('x', true); throw new Error('rollback'); }));
    assert.equal(f.store.get('x'), undefined);
    f.restart(); f.store.put('x', 42); assert.equal(f.store.get('x'), 42);
  } finally { f.close(); }
});

test('long polling persists offsets before acknowledgement and setup retains pending updates', async () => {
  const f = fixture();
  try {
    const calls: { method: string; body: any }[] = [];
    const update = f.message('/help');
    const api: TelegramApi = async (method, body) => { calls.push({ method, body }); return method === 'getUpdates' ? [update] : true; };
    await configureTelegram(api); await pollOnce(f.bot, api); f.restart(); await pollOnce(f.bot, api);
    assert.deepEqual(calls[0], { method: 'deleteWebhook', body: { drop_pending_updates: false } });
    const polls = calls.filter(c => c.method === 'getUpdates');
    assert.equal(polls[0].body.timeout, 30); assert.equal(polls[1].body.offset, update.update_id + 1);
    assert.equal(f.store.list('out:').length, 1);
  } finally { f.close(); }
});

test('runtime cancels long polling promptly on shutdown', async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    let began = false;
    const api: TelegramApi = async (_method, _body, signal) => new Promise((_resolve, reject) => {
      began = true;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      setTimeout(() => controller.abort(), 20);
    });
    await run(f.bot, api, controller, 5000); assert.equal(began, true);
  } finally { controller.abort(); f.close(); }
});

test('offline desktop reports an error without retrying a reply', async () => {
  const f = fixture();
  try {
    await f.select();
    let attempts = 0;
    f.backend.execute = async () => { attempts++; throw new Error('desktop offline'); };
    f.bot.ingest(f.message('继续')); await f.bot.runJobs(); await f.bot.runJobs(); await f.drain();
    assert.equal(attempts, 1); assert.ok(f.delivered.some(d => d.body.text?.includes('desktop offline')));
  } finally { f.close(); }
});

test('completion push needs no watch, survives restart, deduplicates turns, and honors notification preferences', async () => {
  const f = fixture();
  let events: any[] = [];
  f.backend.completions = since => events.filter(e => e.completedAt >= since);
  const stamp = () => f.message('/unused').message.date * 1000;
  try {
    f.bot.ingest(f.message('/start')); await f.drain();
    const baseline = stamp();
    events = [{ threadId: 'task-a', turnId: 'past', completedAt: baseline - 86400000, title: '测试聊天', text: 'past' }];
    await f.bot.pollProgress(); await f.drain();
    assert.ok(!f.delivered.some(d => d.body.text?.startsWith('✅ 任务回合')));
    f.advance(5000);
    events.push({ threadId: 'task-a', turnId: 'turn-1', completedAt: stamp(), title: '测试聊天', text: '完成输出' });
    // App Server can be offline while local completion records remain readable.
    f.backend.list = async () => { throw new Error('offline'); };
    await f.bot.pollProgress(); f.restart(); await f.bot.pollProgress(); await f.drain();
    assert.equal(f.delivered.filter(d => d.body.text?.startsWith('✅ 任务回合')).length, 1);
    assert.equal(f.delivered.find(d => d.body.text?.startsWith('✅ 任务回合'))?.body.chat_id, 7);
    f.bot.ingest(f.message('/notify off')); await f.drain(); f.advance(5000);
    events.push({ threadId: 'task-a', turnId: 'turn-2', completedAt: stamp(), title: '测试聊天', text: 'muted' });
    await f.bot.pollProgress(); await f.drain();
    assert.equal(f.delivered.filter(d => d.body.text?.startsWith('✅ 任务回合')).length, 1);
    f.advance(5000); f.bot.ingest(f.message('/notify on')); await f.drain();
    await f.bot.pollProgress(); await f.drain();
    assert.equal(f.delivered.filter(d => d.body.text?.startsWith('✅ 任务回合')).length, 1);
    f.advance(5000); events.push({ threadId: 'task-a', turnId: 'turn-3', completedAt: stamp(), title: '测试聊天', text: 'after restart' });
    f.restart(); await f.bot.pollProgress(); await f.drain();
    assert.equal(f.delivered.filter(d => d.body.text?.startsWith('✅ 任务回合')).length, 2);
  } finally { f.close(); }
});

test('history is one compact editable card with scoped detail pages and return navigation', async () => {
  const f = fixture();
  try {
    await f.select();
    const original = f.backend.execute.bind(f.backend);
    f.backend.execute = async command => {
      if (command.action === 'history') {
        f.calls.push(command);
        return { kind: 'history', threadId: command.threadId, since: 1789019000000 - 172800000, until: 1789019000000,
          messages: Array.from({ length: 12 }, (_, i) => ({ id: `item-${i}`, role: 'assistant' as const,
            timestamp: 1789019000000 - i * 1000, text: '很长的消息😀'.repeat(1000) })),
          nextBefore: command.before ? undefined : 10 };
      }
      if (command.action === 'message') {
        f.calls.push(command);
        return { kind: 'message', threadId: command.threadId, itemId: command.itemId, role: 'assistant',
          timestamp: 1789019000000, text: command.page ? '第二段全文' : '第一段全文', page: command.page, pages: 2,
          since: command.since!, until: command.until! };
      }
      return original(command);
    };
    const deliveredBefore = f.delivered.length;
    f.bot.ingest(f.message('/history')); await f.bot.runJobs(); await f.drain();
    const cards = f.delivered.slice(deliveredBefore).filter(d => d.method === 'sendMessage');
    assert.equal(cards.length, 1);
    assert.ok(cards[0].body.text.length < 3500);
    const rows = cards[0].body.reply_markup.inline_keyboard;
    const detailButton = rows.flat().find((b: any) => b.text.startsWith('1. '));
    const attempts = f.calls.length;
    f.bot.ingest(f.callback(detailButton.callback_data, 8)); await f.bot.runJobs(); await f.drain();
    assert.equal(f.calls.length, attempts);
    f.bot.ingest(f.callback(detailButton.callback_data)); await f.bot.runJobs(); await f.drain();
    const detail = f.delivered.at(-1)!;
    assert.equal(detail.method, 'editMessageText'); assert.equal(detail.body.message_id, 100);
    assert.ok(detail.body.text.includes('第一段全文'));
    f.bot.ingest(f.callback(detail.body.reply_markup.inline_keyboard[0][0].callback_data));
    await f.bot.runJobs(); await f.drain();
    const second = f.delivered.at(-1)!;
    assert.equal(second.method, 'editMessageText'); assert.ok(second.body.text.includes('第二段全文'));
    f.bot.ingest(f.callback(second.body.reply_markup.inline_keyboard.at(-1)[0].callback_data));
    await f.bot.runJobs(); await f.drain();
    assert.ok(f.delivered.at(-1)!.body.text.includes('12 条预览'));
    assert.equal((f.calls.at(-1) as any).until, 1789019000000);
    // The older page has a newer-page button preserving the original cursor.
    f.bot.ingest(f.callback(rows[0][0].callback_data)); await f.bot.runJobs(); await f.drain();
    const older = f.delivered.at(-1)!;
    assert.ok(older.body.reply_markup.inline_keyboard[0][0].text.includes('较新'));
    f.bot.ingest(f.callback(older.body.reply_markup.inline_keyboard[0][0].callback_data));
    await f.bot.runJobs(); await f.drain();
    assert.equal((f.calls.at(-1) as any).before, undefined);
  } finally { f.close(); }
});

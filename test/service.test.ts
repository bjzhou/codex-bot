import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexService } from '../src/codex/service.ts';
import type { AppServer } from '../src/codex/app-server.ts';
import { HistoryStore } from '../src/codex/history.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('uses local logs for running state and queues on the original task without resuming', async () => {
  const calls: { method: string; args: any }[] = [];
  const server: AppServer = { async call(method, args) {
    calls.push({ method, args });
    if (method === 'thread/list') return { data: [{ id: 'local-a', name: 'A', status: { type: 'notLoaded' }, updatedAt: 100 }] };
    return { queuedSubmission: { id: 'queue-1' } };
  } };
  const history = { resolveThreadId: (id: string) => id, logStatus: () => 'running', completions: () => [
    { threadId: 'local-a', turnId: 'turn-1', completedAt: 1000, text: 'done' },
    { threadId: 'subagent', turnId: 'turn-2', completedAt: 1000, text: 'private' },
  ] } as unknown as HistoryStore;
  const service = new CodexService(server, history);
  const list = await service.list();
  assert.equal(list[0].status, 'running');
  const result = await service.execute({ action: 'reply', threadId: 'local-a', text: '继续' });
  assert.equal(result.kind, 'reply');
  assert.match((result as any).message, /队列/);
  assert.deepEqual(calls.at(-1)?.args.input, [{ type: 'text', text: '继续' }]);
  assert.equal(calls.at(-1)?.method, 'thread/queue/add');
  assert.equal(calls.at(-1)?.args.threadId, 'local-a');
  assert.equal(service.completions(0).length, 1);
  await assert.rejects(service.execute({ action: 'reply', threadId: 'other', text: 'no' }), /本机/);
  assert.equal(calls.filter(c => c.method === 'thread/queue/add').length, 1);
  assert.ok(!calls.some(c => ['thread/resume', 'turn/start', 'turn/steer'].includes(c.method)));
});

test('queue errors are propagated without retry', async () => {
  let mutations = 0;
  const server: AppServer = { async call(method) {
    if (method === 'thread/list') return { data: [{ id: 'a', status: { type: 'idle' } }] };
    mutations++; throw new Error('timeout');
  } };
  const service = new CodexService(server, { resolveThreadId: (id: string) => id, logStatus: () => 'completed' } as unknown as HistoryStore);
  await assert.rejects(service.execute({ action: 'reply', threadId: 'a', text: 'hello' }), /timeout/);
  assert.equal(mutations, 1);
});

test('rotated rollout logs notify the desktop task and keep history, progress and replies on the correct IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-rotated-'));
  const db = new DatabaseSync(join(dir, 'thread_history_1.sqlite'));
  const id = '11111111-1111-1111-1111-111111111111';
  const logId = '22222222-2222-2222-2222-222222222222';
  const nextId = '33333333-3333-3333-3333-333333333333';
  const now = Date.now();
  const path = (log: string) => join(dir, `rollout-2026-09-10T10-00-00-${id}_${log}.jsonl`);
  db.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT, created_at_ms INTEGER, rollout_ordinal INTEGER, item_type TEXT);
    CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, rollout_ordinal INTEGER, started_at INTEGER, completed_at INTEGER, final_agent_item_id TEXT);`);
  const turn = db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?)');
  turn.run(logId, 'finished', 'completed', 1, now / 1000 - 10, now / 1000 - 5, 'final');
  turn.run(logId, 'active', 'inProgress', 2, now / 1000 - 1, null, null);
  turn.run(nextId, 'later', 'completed', 3, now / 1000 - 1, now / 1000, null);
  turn.run('child', 'child-turn', 'completed', 1, now / 1000 - 1, now / 1000, null);
  const item = db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?)');
  item.run(logId, 'finished', 'final', JSON.stringify({ type: 'agentMessage', text: '完成结果' }), now - 5000, 1, 'agentMessage');
  item.run(logId, 'active', 'progress', JSON.stringify({ type: 'agentMessage', text: '最新进度' }), now - 500, 2, 'agentMessage');
  const calls: { method: string; args: any }[] = [];
  let currentPath = path(logId);
  const server: AppServer = { async call(method, args) {
    calls.push({ method, args });
    if (method === 'thread/list') return { data: [
      { id, name: '桌面任务', sessionId: id, path: currentPath, updatedAt: now / 1000 },
      { id: 'child', parentThreadId: id, source: { subAgent: {} } },
    ] };
    return { queuedSubmission: { id: 'queued' } };
  } };
  const history = new HistoryStore(dir);
  const service = new CodexService(server, history);
  try {
    assert.equal(history.resolveThreadId(id, path(logId)), logId);
    assert.equal(history.resolveThreadId('unrelated', path(logId)), 'unrelated');
    assert.equal(history.resolveThreadId(id, path('44444444-4444-4444-4444-444444444444')), id);
    assert.equal(history.resolveThreadId(id, `rollout-${id}.jsonl`), id);
    const threads = await service.list();
    assert.equal(threads.length, 1);
    assert.equal(threads[0].status, 'running');
    assert.equal(service.progress(threads[0]).text, '最新进度');
    assert.equal(service.localThreads()[0].status, 'running');
    assert.deepEqual(service.completions(now - 10000), [{ threadId: id, turnId: 'finished', completedAt: now - 5000, text: '完成结果', title: '桌面任务' }]);
    const page = await service.execute({ action: 'history', threadId: id });
    assert.equal(page.kind, 'history');
    if (page.kind === 'history') { assert.equal(page.threadId, id); assert.equal(page.messages.at(-1)?.text, '最新进度'); }
    const detail = await service.execute({ action: 'message', threadId: id, itemId: 'final', page: 0 });
    assert.equal(detail.kind, 'message');
    if (detail.kind === 'message') { assert.equal(detail.threadId, id); assert.equal(detail.text, '完成结果'); }
    await service.execute({ action: 'reply', threadId: id, text: '继续' });
    assert.equal(calls.at(-1)?.args.threadId, id);
    currentPath = path(nextId);
    assert.equal((await service.list())[0].status, 'completed');
    assert.deepEqual(service.completions(now - 10000).map(e => [e.threadId, e.turnId]), [[id, 'finished'], [id, 'later']]);
  } finally { history.close(); db.close(); rmSync(dir, { recursive: true }); }
});

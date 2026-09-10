import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexService } from '../src/codex/service.ts';
import type { AppServer } from '../src/codex/app-server.ts';
import type { HistoryStore } from '../src/codex/history.ts';

test('uses local logs for running state and queues on the original task without resuming', async () => {
  const calls: { method: string; args: any }[] = [];
  const server: AppServer = { async call(method, args) {
    calls.push({ method, args });
    if (method === 'thread/list') return { data: [{ id: 'local-a', name: 'A', status: { type: 'notLoaded' }, updatedAt: 100 }] };
    return { queuedSubmission: { id: 'queue-1' } };
  } };
  const history = { logStatus: () => 'running', completions: () => [
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
  const service = new CodexService(server, { logStatus: () => 'completed' } as unknown as HistoryStore);
  await assert.rejects(service.execute({ action: 'reply', threadId: 'a', text: 'hello' }), /timeout/);
  assert.equal(mutations, 1);
});

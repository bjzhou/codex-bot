import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HistoryStore, normalizeStatus, TWO_DAYS } from '../src/codex/history.ts';

test('48-hour history uses item timestamps, paginates without gaps, and preserves roles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-history-'));
  const path = join(dir, 'thread_history_1.sqlite');
  const db = new DatabaseSync(path);
  const now = 1789019000000;
  db.exec(`CREATE TABLE thread_items (thread_id TEXT, item_id TEXT, item_json TEXT, created_at_ms INTEGER, rollout_ordinal INTEGER, item_type TEXT);
    CREATE TABLE thread_turns (thread_id TEXT, status TEXT, rollout_ordinal INTEGER, turn_id TEXT, started_at INTEGER, completed_at INTEGER, final_agent_item_id TEXT);`);
  const insert = db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?)');
  for (let i = 1; i <= 27; i++) {
    const user = i % 2 === 1;
    const item = user ? { type: 'userMessage', content: [{ type: 'text', text: `message ${i}` }] } : { type: 'agentMessage', text: `message ${i}` };
    insert.run('a', `i${i}`, JSON.stringify(item), now - TWO_DAYS + i, i, item.type);
  }
  insert.run('a', 'old', JSON.stringify({ type: 'agentMessage', text: 'too old' }), now - TWO_DAYS - 1, 0, 'agentMessage');
  insert.run('a', 'future', JSON.stringify({ type: 'agentMessage', text: 'future' }), now + 1, 100, 'agentMessage');
  insert.run('other', 'private', '{}', now, 500, 'userMessage');
  db.close();
  const history = new HistoryStore(dir);
  try {
    const a = history.page('a', undefined, now - TWO_DAYS, now);
    const b = history.page('a', a.nextBefore, a.since, now);
    const c = history.page('a', b.nextBefore, b.since, now);
    assert.equal(a.messages.length, 12); assert.equal(b.messages.length, 12); assert.equal(c.messages.length, 3);
    assert.equal(c.nextBefore, undefined);
    const all = [...c.messages, ...b.messages, ...a.messages];
    assert.deepEqual(all.map(m => m.id), Array.from({ length: 27 }, (_, i) => `i${i + 1}`));
    assert.equal(all[0].role, 'user'); assert.equal(all[1].role, 'assistant');
    assert.equal(history.page('none', undefined, undefined, now).messages.length, 0);
  } finally { history.close(); rmSync(dir, { recursive: true }); }
});

test('live running status wins; unloaded is not automatically completed', () => {
  assert.equal(normalizeStatus('active', 'completed'), 'running');
  assert.equal(normalizeStatus({ type: 'active' }, 'completed'), 'running');
  assert.equal(normalizeStatus('notLoaded', 'completed'), 'completed');
  assert.equal(normalizeStatus('notLoaded', 'inProgress'), 'unknown');
  assert.equal(normalizeStatus('notLoaded'), 'unknown');
  assert.equal(normalizeStatus('idle', 'failed'), 'failed');
  assert.equal(normalizeStatus('waitingForApproval', 'inProgress'), 'waiting');
});


test('explicit per-turn completion records detect fast turns; stale activity never implies completion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-log-'));
  const db = new DatabaseSync(join(dir, 'thread_history_1.sqlite'));
  const now = 1789019000000;
  db.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT, created_at_ms INTEGER, rollout_ordinal INTEGER, item_type TEXT);
    CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, rollout_ordinal INTEGER, started_at INTEGER, completed_at INTEGER, final_agent_item_id TEXT);`);
  const turn = db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?)');
  turn.run('a', 'old', 'completed', 1, now / 1000 - 100, now / 1000 - 50, null);
  turn.run('a', 'fast', 'completed', 2, now / 1000 - 2, now / 1000 - 1, 'final');
  turn.run('a', 'next', 'inProgress', 3, now / 1000, null, null);
  turn.run('stale', 'crashed', 'inProgress', 1, now / 1000 - 7200, null, null);
  turn.run('failed', 'failure', 'failed', 1, now / 1000 - 1, now / 1000, null);
  db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?)').run('a', 'fast', 'final', JSON.stringify({ type: 'agentMessage', text: 'finished' }), now - 1000, 2, 'agentMessage');
  const history = new HistoryStore(dir);
  try {
    assert.equal(history.logStatus('a', now), 'running');
    assert.equal(history.logStatus('stale', now), 'unknown');
    assert.equal(history.logStatus('failed', now), 'failed');
    assert.equal(history.progress('a').text, '等待新的进度消息…');
    assert.deepEqual(history.completions(now - 5000, now), [{ threadId: 'a', turnId: 'fast', completedAt: now - 1000, text: 'finished' }]);
    // Completion may be recorded later while a subsequent turn is already active.
    turn.run('a', 'late', 'completed', 4, now / 1000 - 3, now / 1000 - 2, null);
    assert.equal(history.completions(now - 5000, now).length, 2);
  } finally { history.close(); db.close(); rmSync(dir, { recursive: true }); }
});

test('history previews stay short while detail pages preserve long text and enforce scope/time bounds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-history-detail-'));
  const path = join(dir, 'thread_history_1.sqlite');
  const db = new DatabaseSync(path);
  const now = 1789019000000;
  db.exec(`CREATE TABLE thread_items (thread_id TEXT, item_id TEXT, item_json TEXT, created_at_ms INTEGER, rollout_ordinal INTEGER, item_type TEXT);
    CREATE TABLE thread_turns (thread_id TEXT, status TEXT, rollout_ordinal INTEGER, turn_id TEXT, started_at INTEGER, completed_at INTEGER, final_agent_item_id TEXT);`);
  const text = '开头\n' + 'a'.repeat(2794) + '😀' + '\n很多详细内容😀\n'.repeat(3000) + '结尾';
  const insert = db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?)');
  insert.run('a', 'long-message', JSON.stringify({ type: 'agentMessage', text }), now - 1000, 1, 'agentMessage');
  insert.run('other', 'private-message', JSON.stringify({ type: 'agentMessage', text: 'private' }), now - 1000, 2, 'agentMessage');
  insert.run('a', 'expired', JSON.stringify({ type: 'agentMessage', text: 'old' }), now - TWO_DAYS - 1, 3, 'agentMessage');
  insert.run('a', 'new-arrival', JSON.stringify({ type: 'agentMessage', text: 'new' }), now + 1000, 4, 'agentMessage');
  const history = new HistoryStore(dir);
  try {
    const list = history.page('a', undefined, now - TWO_DAYS, now);
    assert.equal(list.messages.length, 1);
    assert.ok(list.messages[0].text.length <= 161);
    assert.equal(list.messages[0].truncated, true);
    const first = history.message('a', 'long-message', 0, list.since, now, list.until);
    let restored = '';
    for (let page = 0; page < first.pages; page++) {
      const detail = history.message('a', 'long-message', page, list.since, now, list.until);
      assert.ok(detail.text.length <= 2800);
      assert.ok(!/[\uD800-\uDBFF]$/.test(detail.text));
      assert.ok(!/^[\uDC00-\uDFFF]/.test(detail.text));
      restored += detail.text;
    }
    assert.equal(restored, text); assert.ok(restored.length > 16000);
    assert.throws(() => history.message('a', 'private-message', 0, list.since, now), /不存在/);
    assert.throws(() => history.message('a', 'expired', 0, 0, now), /48 小时/);
    assert.throws(() => history.message('a', 'long-message', -1, list.since, now), /页码/);
    assert.throws(() => history.message('a', 'long-message', first.pages, list.since, now), /页码/);
    // Returning to the original time window does not pull in newly arrived messages.
    assert.equal(history.page('a', undefined, list.since, now + 2000, list.until).messages.length, 1);
  } finally { history.close(); db.close(); rmSync(dir, { recursive: true }); }
});

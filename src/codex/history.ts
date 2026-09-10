import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CommandResult, Status } from '../shared/protocol.ts';
import { splitText, previewText } from '../shared/text.ts';

export const TWO_DAYS = 48 * 60 * 60 * 1000;
export type Completion = { threadId: string; turnId: string; completedAt: number; text: string };
function itemText(item: any): string {
  return item.type === 'agentMessage' ? String(item.text ?? '') : (item.content ?? []).map((p: any) =>
    p.type === 'text' ? p.text ?? '' : `[${p.type ?? '附件'}]`).join('\n');
}
export function normalizeStatus(runtime: unknown, turn?: string): Status {
  const type = typeof runtime === 'object' && runtime !== null ? (runtime as any).type : runtime;
  if (type === 'active' || type === 'running' || type === 'inProgress') return 'running';
  if (type === 'waiting' || type === 'requiresAction' || type === 'waitingForApproval' || type === 'waitingForUserInput') return 'waiting';
  if (type === 'systemError' || type === 'error' || type === 'failed') return 'failed';
  if (turn === 'completed') return 'completed';
  if (turn === 'failed') return 'failed';
  if (turn === 'interrupted') return 'interrupted';
  if (type === 'idle') return 'idle';
  // A stale persisted inProgress turn is not evidence of a live desktop run.
  return 'unknown';
}

export class HistoryStore {
  private db: DatabaseSync;
  readonly path: string;
  constructor(home: string, explicit?: string) {
    this.path = explicit || [join(home, 'thread_history_1.sqlite'), join(home, 'sqlite', 'thread_history_1.sqlite')].find(existsSync) || '';
    if (!this.path) throw new Error('找不到 Codex 历史数据库；请设置 CODEX_HISTORY_DB（需要支持 thread_items 的桌面版本）。');
    this.db = new DatabaseSync(this.path, { readOnly: true });
    this.db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;');
    this.db.prepare('SELECT created_at_ms, item_json, rollout_ordinal FROM thread_items LIMIT 0').all();
    this.db.prepare('SELECT turn_id, started_at, completed_at, final_agent_item_id FROM thread_turns LIMIT 0').all();
  }
  close() { this.db.close(); }
  /** Rotated rollout files can be projected under a different ID than the desktop task. */
  resolveThreadId(id: string, rolloutPath?: string): string {
    if (!rolloutPath) return id;
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    const match = basename(rolloutPath).match(new RegExp(`^rollout-.+-(${uuid})_(${uuid})\\.jsonl$`, 'i'));
    if (!match || match[1] !== id) return id;
    // Accept only the task's own current rollout and an ID actually present in the projection.
    return this.db.prepare('SELECT 1 FROM thread_turns WHERE thread_id = ? LIMIT 1').get(match[2]) ? match[2] : id;
  }
  latestStatus(id: string): string | undefined {
    const row = this.db.prepare('SELECT status FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1').get(id);
    return row?.status as string | undefined;
  }
  page(id: string, before?: number, since = Date.now() - TWO_DAYS, now = Date.now(), until = now): Extract<CommandResult, { kind: 'history' }> {
    since = Math.max(since, now - TWO_DAYS);
    until = Math.min(until, now);
    const rows = this.db.prepare(`SELECT item_id, item_json, created_at_ms, rollout_ordinal FROM thread_items
      WHERE thread_id = ? AND created_at_ms >= ? AND created_at_ms <= ? AND rollout_ordinal < ?
      AND item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal DESC LIMIT 13`)
      .all(id, since, until, before ?? Number.MAX_SAFE_INTEGER);
    const page = rows.slice(0, 12);
    const messages = page.map(row => {
      const item = JSON.parse(row.item_json as string);
      const text = itemText(item);
      return { id: String(row.item_id), timestamp: Number(row.created_at_ms),
        role: item.type === 'userMessage' ? 'user' as const : 'assistant' as const,
        text: previewText(text), truncated: text.replace(/\s+/g, ' ').trim().length > 160 };
    }).reverse();
    return { kind: 'history', threadId: id, messages, since, until,
      ...(rows.length > 12 ? { nextBefore: Number(page.at(-1)!.rollout_ordinal) } : {}) };
  }
  message(id: string, itemId: string, page = 0, since = Date.now() - TWO_DAYS, now = Date.now(), until = now): Extract<CommandResult, { kind: 'message' }> {
    since = Math.max(since, now - TWO_DAYS); until = Math.min(until, now);
    const row = this.db.prepare(`SELECT item_json, created_at_ms FROM thread_items
      WHERE thread_id = ? AND item_id = ? AND created_at_ms >= ? AND created_at_ms <= ?
      AND item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal DESC LIMIT 1`).get(id, itemId, since, until);
    if (!row) throw new Error('该消息已不在最近 48 小时内或不存在，请重新打开历史记录。');
    const item = JSON.parse(String(row.item_json));
    const parts = splitText(itemText(item) || '[空消息]', 2800);
    if (!Number.isInteger(page) || page < 0 || page >= parts.length) throw new Error('消息页码已失效，请重新打开该消息。');
    return { kind: 'message', threadId: id, itemId, role: item.type === 'userMessage' ? 'user' : 'assistant',
      timestamp: Number(row.created_at_ms), text: parts[page], page, pages: parts.length, since, until };
  }
  logStatus(id: string, now = Date.now()): Status {
    const row = this.db.prepare('SELECT status, started_at FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1').get(id);
    if (!row) return 'unknown';
    if (row.status !== 'inProgress') return normalizeStatus(undefined, String(row.status));
    const item = this.db.prepare('SELECT MAX(created_at_ms) AS time FROM thread_items WHERE thread_id = ?').get(id);
    const activity = Math.max(Number(row.started_at || 0) * 1000, Number(item?.time || 0));
    return activity >= now - 30 * 60 * 1000 ? 'running' : 'unknown';
  }
  completions(since: number, now = Date.now()): Completion[] {
    return this.db.prepare(`SELECT t.thread_id, t.turn_id, t.completed_at, i.item_json
      FROM thread_turns t LEFT JOIN thread_items i ON i.thread_id = t.thread_id
      AND i.turn_id = t.turn_id AND i.item_id = t.final_agent_item_id
      WHERE t.status = 'completed' AND t.completed_at * 1000 >= ? AND t.completed_at * 1000 <= ?
      ORDER BY t.completed_at, t.thread_id, t.turn_id`).all(Math.max(since, now - TWO_DAYS), now).map(row => ({
        threadId: String(row.thread_id), turnId: String(row.turn_id), completedAt: Number(row.completed_at) * 1000,
        text: row.item_json ? String(JSON.parse(String(row.item_json)).text || '').slice(-2500) : '',
      }));
  }
  progress(id: string): { text: string; itemId: string } {
    const row = this.db.prepare(`SELECT item_id, item_json FROM thread_items WHERE thread_id = ?
      AND turn_id = (SELECT turn_id FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1)
      AND item_type = 'agentMessage' ORDER BY rollout_ordinal DESC LIMIT 1`).get(id, id);
    if (!row) return { text: '等待新的进度消息…', itemId: '' };
    const item = JSON.parse(row.item_json as string);
    return { text: String(item.text ?? '').slice(-3000), itemId: String(row.item_id) };
  }
}

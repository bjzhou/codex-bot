import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, splitText, createTelegramApi, TelegramError } from '../src/bot/telegram.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { commandSchema, resultSchema } from '../src/shared/protocol.ts';

test('only explicitly allowlisted users in private chats can control Codex', () => {
  const message = { update_id: 1, message: { message_id: 1, text: '/list', from: { id: 7 }, chat: { id: 7, type: 'private' } } };
  assert.equal(authorized(message, '7,8'), 7);
  assert.equal(authorized(message, ''), undefined);
  assert.equal(authorized(message, '77'), undefined);
  assert.equal(authorized({ ...message, message: { ...message.message, chat: { id: 7, type: 'group' } } }, '7'), undefined);
  assert.equal(authorized({ update_id: 1, callback_query: { id: 'c', from: { id: 8 }, message: message.message } }, '7,8'), undefined);
});
test('long messages preserve all characters and do not split surrogate pairs', () => {
  const text = 'x'.repeat(3499) + '😀\n你好'.repeat(2000);
  const chunks = splitText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(c => c.length <= 3500));
  assert.ok(chunks.every(c => !/[\uD800-\uDBFF]$/.test(c)));
});
test('protocol rejects arbitrary methods, traversal ids and oversized responses', () => {
  assert.equal(commandSchema.safeParse({ action: 'exec', text: 'sh' }).success, false);
  assert.equal(commandSchema.safeParse({ action: 'reply', threadId: '../x', text: 'hello' }).success, false);
  assert.equal(resultSchema.safeParse({ kind: 'reply', threadId: 'a', message: 'x'.repeat(5000) }).success, false);
});

test('HTTP client sends polling parameters and decodes updates using a local Telegram mock', async () => {
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: [{ update_id: 42 }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const api = createTelegramApi('test-token', async (input, init) => {
      assert.equal(String(input), 'https://api.telegram.org/bottest-token/getUpdates');
      return fetch(`http://127.0.0.1:${port}`, init);
    });
    assert.deepEqual(await api('getUpdates', { offset: 42, timeout: 30 }), [{ update_id: 42 }]);
    assert.deepEqual(received, [{ offset: 42, timeout: 30 }]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('HTTP client redacts token-bearing network errors and exposes safe rate-limit metadata', async () => {
  const secret = 'secret-token';
  const broken = createTelegramApi(secret, async () => { throw new Error(`request to https://api.telegram.org/bot${secret} failed`); });
  await assert.rejects(broken('getMe', {}), error => error instanceof TelegramError && !error.message.includes(secret));
  const limited = createTelegramApi(secret, async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 12 } }));
  await assert.rejects(limited('sendMessage', {}), error => error instanceof TelegramError && error.retryAfter === 12 && !error.permanent);
  const conflict = createTelegramApi(secret, async () => Response.json({ ok: false, error_code: 409 }));
  await assert.rejects(conflict('getUpdates', {}), error => error instanceof TelegramError && error.permanent && error.code === 409);
});

test('HTTP client forwards cancellation without treating shutdown as a retryable error', async () => {
  const controller = new AbortController();
  const api = createTelegramApi('token', async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }));
  const pending = api('getUpdates', { timeout: 30 }, controller.signal);
  controller.abort(new Error('stop'));
  await assert.rejects(pending, /stop/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient } from '../src/codex/app-server.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-stdio-'));
  const file = join(dir, 'server.cjs');
  writeFileSync(file, `
    const readline = require('node:readline');
    let initialized = false, mutations = 0;
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialized') { initialized = true; return; }
      if (m.method === 'exit') process.exit(2);
      if (m.method === 'thread/queue/add') { mutations++; return; }
      if (m.id === undefined) return;
      const result = m.method === 'initialize' ? { userAgent: 'test' } : { initialized, mutations, method: m.method };
      const text = JSON.stringify({ id: m.id, result }) + '\\n';
      // OS pipes may split a JSON line into multiple chunks.
      process.stdout.write(text.slice(0, 5));
      setTimeout(() => process.stdout.write(text.slice(5)), 5);
    });
  `);
  const server = new AppServerClient(process.execPath, dir, 500, [file]);
  return { server, async close() { await server.close(); rmSync(dir, { recursive: true }); } };
}

test('stdio handshake precedes requests and handles fragmented responses', async () => {
  const f = fixture();
  try {
    const result = await f.server.call('thread/list', {});
    assert.equal(result.initialized, true);
    assert.equal(result.method, 'thread/list');
  } finally { await f.close(); }
});

test('timed out queue writes are never replayed', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.server.call('thread/queue/add', {}), /超时/);
    const result = await f.server.call('count', {});
    assert.equal(result.mutations, 1);
  } finally { await f.close(); }
});

test('exited server rejects outstanding requests and reconnects only for subsequent requests', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.server.call('exit', {}), /退出/);
    const result = await f.server.call('thread/list', {});
    assert.equal(result.initialized, true);
  } finally { await f.close(); }
});

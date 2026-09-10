import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';

export interface AppServer { call(method: string, params: Record<string, unknown>): Promise<any> }
export function codexBinary(): string {
  return process.env.CODEX_CLI_PATH?.trim() || ['/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex'].find(existsSync) || 'codex';
}

/** Separate stdio server; no desktop private IPC, daemon installation or public port. */
export class AppServerClient implements AppServer {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private connecting?: Promise<void>;
  private serial = 0;
  private closing = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly binary: string, private home: string, private timeout = 20000, private args = ['app-server', '--listen', 'stdio://']) {}
  async connect() {
    if (this.closing) throw new Error('App Server 已关闭');
    if (!this.connecting) this.connecting = this.start().catch(error => { this.connecting = undefined; throw error; });
    await this.connecting;
  }
  private async start() {
    const child = spawn(this.binary, this.args, { env: { ...process.env, CODEX_HOME: this.home }, stdio: 'pipe' });
    this.child = child;
    child.stderr.resume(); // Drain diagnostics without logging credentials or conversation contents.
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined; this.connecting = undefined;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      this.pending.clear();
    };
    child.on('error', error => fail(new Error(`无法启动 Codex CLI：${error.message}`)));
    child.on('exit', code => fail(new Error(`Codex App Server 已退出（${code ?? 'signal'}）；回复结果可能未知，请勿自动重发。`)));
    child.stdin.on('error', () => fail(new Error('App Server 输入连接已断开；回复结果可能未知。')));
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) {
        if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Interactive execution is not supported by this client' } }) + '\n');
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(message.id);
      message.error ? entry.reject(new Error(String(message.error.message || 'App Server 请求失败'))) : entry.resolve(message.result);
    });
    try {
      await this.request('initialize', { clientInfo: { name: 'codex_telegram_bot', version: '0.2.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    } catch (error) { child.kill('SIGTERM'); throw error; }
  }
  private request(method: string, params: Record<string, unknown>): Promise<any> {
    const child = this.child;
    if (!child || child.stdin.destroyed) return Promise.reject(new Error('App Server 未连接'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server ${method} 超时；写入结果可能未知，请查看原任务后再决定是否重发。`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async call(method: string, params: Record<string, unknown>) {
    await this.connect();
    return this.request(method, params); // No automatic replay after submission.
  }
  async close() {
    this.closing = true;
    const child = this.child;
    this.child = undefined; this.lines?.close();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('App Server 已关闭')); }
    this.pending.clear();
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
}

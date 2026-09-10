import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppServerClient, codexBinary } from '../codex/app-server.ts';
import { HistoryStore } from '../codex/history.ts';
import { CodexService } from '../codex/service.ts';
import { Store } from './store.ts';
import { Bot } from './controller.ts';
import { createTelegramApi, TelegramError } from './telegram.ts';
import { configureTelegram, run } from './runtime.ts';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
let store: Store | undefined; let history: HistoryStore | undefined; let server: AppServerClient | undefined;
try {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const api = createTelegramApi(token);
  const allowed = process.env.ALLOWED_TELEGRAM_USER_IDS?.trim() || '';
  if (!/^\d+(\s*,\s*\d+)*$/.test(allowed)) throw new Error('请在 .env 填写 ALLOWED_TELEGRAM_USER_IDS（数字 ID，以逗号分隔）。');
  const identity = createHash('sha256').update(token.split(':')[0]).digest('hex').slice(0, 16);
  store = new Store(process.env.BOT_STATE_DIR || join('.bot', identity));
  history = new HistoryStore(process.env.CODEX_HOME || join(homedir(), '.codex'), process.env.CODEX_HISTORY_DB || undefined);
  server = new AppServerClient(codexBinary(), process.env.CODEX_HOME || join(homedir(), '.codex'));
  await server.connect();
  const service = new CodexService(server, history);
  await service.list();
  const bot = new Bot(store, service, api, allowed);
  const pollMs = Math.max(3000, Number(process.env.POLL_INTERVAL_MS) || 5000);
  bot.recover();
  let ready = false;
  while (!controller.signal.aborted && !ready) {
    try {
      const me = await api('getMe', {}, controller.signal);
      if (store.get<number>('botId') && store.get<number>('botId') !== me.id) throw new Error('状态目录属于其他 Telegram Bot，请更换 BOT_STATE_DIR。');
      store.put('botId', me.id);
      await configureTelegram(api, controller.signal);
      console.log(`@${me.username} 已启用本地长轮询；正在等待 Telegram 消息。`);
      ready = true;
    } catch (error) {
      if (controller.signal.aborted) break;
      if (!(error instanceof TelegramError) || error.permanent) throw error;
      console.error(error.message);
      await sleep(Math.max(5000, error.retryAfter * 1000), undefined, { signal: controller.signal }).catch(() => {});
    }
  }
  if (ready) await run(bot, api, controller, pollMs);
} catch (error) {
  console.error(error instanceof TelegramError && error.code === 409 ? '已有其他进程正在接收此 Bot 的消息，请停止重复实例。' : (error as Error).message);
  process.exitCode = 1;
} finally { controller.abort(); await server?.close(); history?.close(); store?.close(); }

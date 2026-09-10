import { setTimeout as sleep } from 'node:timers/promises';
import { Bot } from './controller.ts';
import { TelegramError, type TelegramApi } from './telegram.ts';

export const commands = [
  { command: 'list', description: '查看最近聊天及运行状态' },
  { command: 'history', description: '最近 48 小时聊天记录' },
  { command: 'reply', description: '回复选中的聊天' },
  { command: 'watch', description: '订阅实时进度' },
  { command: 'unwatch', description: '取消进度订阅' },
  { command: 'notify', description: '任务完成通知：on 开启，off 关闭' },
  { command: 'status', description: '查看本地 Codex 状态' },
  { command: 'cancel', description: '取消聊天选择' },
  { command: 'help', description: '使用说明' },
];
export async function configureTelegram(api: TelegramApi, signal?: AbortSignal) {
  await api('deleteWebhook', { drop_pending_updates: false }, signal);
  await api('setMyCommands', { commands }, signal);
}
export async function pollOnce(bot: Bot, api: TelegramApi, signal?: AbortSignal) {
  const updates = await api('getUpdates', { offset: bot.offset, limit: 100, timeout: 30, allowed_updates: ['message', 'callback_query'] }, signal);
  if (!Array.isArray(updates)) throw new TelegramError('Telegram 返回了无效的更新列表');
  updates.sort((a, b) => (a?.update_id || 0) - (b?.update_id || 0));
  for (const update of updates) bot.ingest(update);
}
export async function run(bot: Bot, api: TelegramApi, controller: AbortController, pollMs: number) {
  const { signal } = controller;
  const delay = (ms: number) => sleep(ms, undefined, { signal }).catch(() => {});
  const loop = async (task: () => Promise<void> | void, interval: number) => {
    let backoff = 1000;
    while (!signal.aborted) {
      try { await task(); backoff = 1000; }
      catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof TelegramError) || error.permanent) throw error;
        console.error(error.message);
        await delay(Math.max(error.retryAfter * 1000, backoff));
        backoff = Math.min(30000, backoff * 2); continue;
      }
      await delay(interval);
    }
  };
  const tasks = [
    loop(() => pollOnce(bot, api, signal), 100), loop(() => bot.runJobs(), 100),
    loop(() => bot.flush(signal), 100), loop(() => bot.pollProgress(), pollMs), loop(() => bot.cleanup(), 60000),
  ];
  try { await Promise.all(tasks); }
  finally { controller.abort(); await Promise.allSettled(tasks); }
}

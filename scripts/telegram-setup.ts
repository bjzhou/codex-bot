import { createTelegramApi } from '../src/bot/telegram.ts';
import { configureTelegram } from '../src/bot/runtime.ts';

try {
  const api = createTelegramApi(process.env.TELEGRAM_BOT_TOKEN || '');
  const me = await api('getMe', {});
  await configureTelegram(api);
  console.log(`@${me.username} 命令已设置，已切换为长轮询模式。`);
  console.log('启动：sh scripts/run-local.sh start');
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }

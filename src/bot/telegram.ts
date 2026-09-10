import { z } from 'zod';

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; date?: number; text?: string; from?: { id: number }; chat: { id: number; type: string } };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type: string } } };
}
export type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
const messageSchema = z.object({ message_id: z.number().int(), date: z.number().int().optional(), text: z.string().optional(),
  from: z.object({ id: z.number().int() }).optional(), chat: z.object({ id: z.number().int(), type: z.string() }) });
export const updateSchema = z.object({ update_id: z.number().int().nonnegative(), message: messageSchema.optional(),
  callback_query: z.object({ id: z.string(), from: z.object({ id: z.number().int() }), data: z.string().optional(), message: messageSchema.optional() }).optional() });
export type TelegramApi = (method: string, body: Record<string, any>, signal?: AbortSignal) => Promise<any>;
export class TelegramError extends Error {
  constructor(message: string, readonly retryAfter = 5, readonly permanent = false, readonly code = 0) { super(message); }
}
export function createTelegramApi(token: string, fetcher: typeof fetch = fetch): TelegramApi {
  if (!token.trim()) throw new Error('请在 .env 填写 TELEGRAM_BOT_TOKEN');
  return async (method, body, signal) => {
  let data: any;
  try {
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 45000 : 15000);
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    data = await response.json();
  } catch { if (signal?.aborted) throw signal.reason; throw new TelegramError('Telegram 暂时不可用，请检查网络。'); }
  if (!data.ok) {
    if (data.description?.includes('message is not modified')) return { message_id: (body as any).message_id };
    throw new TelegramError(`Telegram API ${data.error_code || 'error'}`, data.parameters?.retry_after || 5,
      [400, 401, 403, 404, 409].includes(data.error_code), data.error_code);
  }
  return data.result;
  };
}
export { splitText } from '../shared/text.ts';
export function authorized(update: TelegramUpdate, allowed: string): number | undefined {
  const actor = update.callback_query?.from || update.message?.from;
  const chat = update.callback_query?.message?.chat || update.message?.chat;
  if (!actor || !chat || chat.type !== 'private' || actor.id !== chat.id) return;
  const users = allowed.split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s));
  return users.includes(String(actor.id)) ? chat.id : undefined;
}

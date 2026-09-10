import { z } from 'zod';

export const threadId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const statusSchema = z.enum(['running', 'completed', 'waiting', 'failed', 'interrupted', 'idle', 'unknown']);
export type Status = z.infer<typeof statusSchema>;
export const threadSchema = z.object({
  id: threadId, title: z.string().max(500), status: statusSchema,
  updatedAt: z.number(), preview: z.string().max(2000).optional(),
});
export type Thread = z.infer<typeof threadSchema>;
export const historyInput = z.object({
  threadId, before: z.number().int().nonnegative().optional(),
  since: z.number().int().nonnegative().optional(),
  until: z.number().int().nonnegative().optional(),
});
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('history'), ...historyInput.shape }),
  z.object({ action: z.literal('message'), ...historyInput.shape, itemId: z.string().min(1).max(200), page: z.number().int().nonnegative().max(100000).default(0) }),
  z.object({ action: z.literal('reply'), threadId, text: z.string().min(1).max(16000) }),
]);
export type Command = z.infer<typeof commandSchema>;
export const historyMessage = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']), text: z.string().max(16000),
  timestamp: z.number(), truncated: z.boolean().optional(),
});
export const resultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), threads: z.array(threadSchema).max(100) }),
  z.object({ kind: z.literal('history'), threadId, messages: z.array(historyMessage).max(12),
    since: z.number(), until: z.number().optional(), nextBefore: z.number().optional() }),
  z.object({ kind: z.literal('message'), threadId, itemId: z.string(), role: z.enum(['user', 'assistant']),
    timestamp: z.number(), text: z.string().max(2800), page: z.number().int(), pages: z.number().int(), since: z.number(), until: z.number() }),
  z.object({ kind: z.literal('reply'), threadId, message: z.string().max(4000) }),
  z.object({ kind: z.literal('error'), message: z.string().max(4000) }),
]);
export type CommandResult = z.infer<typeof resultSchema>;
export const labels: Record<Status, string> = {
  running: '🟢 正在进行', completed: '✅ 已完成', waiting: '🟡 等待操作',
  failed: '🔴 失败', interrupted: '⏹ 已中断', idle: '⚪ 空闲', unknown: '❔ 状态未知',
};

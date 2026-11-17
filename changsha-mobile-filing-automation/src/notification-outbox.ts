import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

type Message = { id: string; content: string; target: string; attempts: number; nextAttempt: number; sentAt?: string };
async function save(file: string, message: Message): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(message), 'utf8');
  await rename(temp, file);
}
const targetKey = (url: string) => createHash('sha256').update(url).digest('hex');

export async function enqueueNotification(stateDir: string, url: string, id: string, content: string): Promise<void> {
  const dir = path.join(stateDir, 'notification-outbox');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${createHash('sha256').update(id).digest('hex')}.json`);
  try { await readFile(file); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await save(file, { id, content, target: targetKey(url), attempts: 0, nextAttempt: 0 });
}

export async function flushNotifications(stateDir: string, url?: string, timeoutMs = 10_000): Promise<void> {
  if (!url) return;
  const dir = path.join(stateDir, 'notification-outbox');
  const names = await readdir(dir).catch(() => [] as string[]);
  let count = 0;
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let message: Message;
    try { message = JSON.parse(await readFile(file, 'utf8')); } catch { console.warn('[企微补发] 记录损坏，保留待排查。'); continue; }
    if (message.sentAt || message.target !== targetKey(url) || message.nextAttempt > Date.now()) continue;
    if (++count > 5) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: message.content } }) });
      const result = await response.json() as { errcode?: number };
      if (!response.ok || result.errcode !== 0) throw new Error('企微未确认接收');
      message.sentAt = new Date().toISOString();
    } catch {
      message.attempts++;
      message.nextAttempt = Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(message.attempts - 1, 7));
      console.warn(`[企微补发] 运行 ${message.id} 发送未确认，已保留，下次启动重试。`);
    } finally { clearTimeout(timer); }
    await save(file, message);
    if (!message.sentAt) break;
  }
}

import type { AppConfig } from './config.js';

export type RemoteLogEvent = {
  event: 'filing.completed' | 'filing.failed' | 'batch.completed' | 'job.completed' | 'job.failed';
  occurredAt?: string;
  fileName?: string;
  batchId?: string;
  jobId?: string;
  status?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  error?: string;
};

export async function sendRemoteLog(config: AppConfig, event: RemoteLogEvent): Promise<boolean> {
  if (!config.remoteLogUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.remoteLogTimeoutMs);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.remoteLogToken) headers.authorization = `Bearer ${config.remoteLogToken}`;
    const response = await fetch(config.remoteLogUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'changsha-mobile-filing-automation',
        occurredAt: event.occurredAt ?? new Date().toISOString(),
        ...event,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`远端日志服务器返回 HTTP ${response.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export async function trySendRemoteLog(config: AppConfig, event: RemoteLogEvent): Promise<boolean> {
  try {
    return await sendRemoteLog(config, event);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[远端日志] 发送失败：${message}`);
    return false;
  }
}

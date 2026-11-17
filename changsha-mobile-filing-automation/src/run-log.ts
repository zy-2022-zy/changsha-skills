import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { enqueueNotification, flushNotifications } from './notification-outbox.js';
import type { AppConfig } from './config.js';

export type RunLogStatus = 'PRECHECKED' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED';

export type RunLogEntry = {
  version: 1;
  runId: string;
  command: 'batch' | 'run' | 'results' | 'generate-sedp' | 'service';
  mode: 'precheck' | 'submit' | 'results' | 'generate-sedp' | 'service';
  startedAt: string;
  finishedAt: string;
  status: RunLogStatus;
  batchId?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  websiteTotal?: number;
  websiteSucceeded?: number;
  websiteFailed?: number;
  fileNames?: string[];
  failedFiles?: string[];
  error?: string;
};

export function newRunId(): string {
  return randomUUID();
}

export function formatLogTime(value: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function statusText(status: RunLogStatus): string {
  return {
    PRECHECKED: '预检完成',
    COMPLETED: '报备完成',
    COMPLETED_WITH_ERRORS: '报备完成（有失败）',
    FAILED: '运行失败',
  }[status];
}

function modeText(mode: RunLogEntry['mode']): string {
  return {
    precheck: '批量预检',
    submit: '批量报备',
    results: '结果查询',
    'generate-sedp': '生成报备结果资料',
    service: '智能体服务',
  }[mode];
}

export function toChineseRunLog(entry: Omit<RunLogEntry, 'version'>): Record<string, unknown> {
  return {
    版本: 1,
    运行编号: entry.runId,
    执行命令: entry.command === 'batch' ? '批量报备' : entry.command,
    执行模式: modeText(entry.mode),
    开始时间: formatLogTime(entry.startedAt),
    结束时间: formatLogTime(entry.finishedAt),
    状态: statusText(entry.status),
    批次号: entry.batchId,
    文件总数: entry.total,
    处理完成文件数: entry.command === 'batch' ? entry.succeeded : undefined,
    处理异常文件数: entry.command === 'batch' ? entry.failed : undefined,
    网站报备总条数: entry.websiteTotal ?? (entry.command !== 'batch' ? entry.total : undefined),
    网站报备成功条数: entry.websiteSucceeded ?? (entry.command !== 'batch' ? entry.succeeded : undefined),
    网站报备失败条数: entry.websiteFailed ?? (entry.command !== 'batch' ? entry.failed : undefined),
    跳过数: entry.skipped,
    文件名: entry.fileNames,
    失败文件: entry.failedFiles,
    错误摘要: entry.error,
  };
}

export function formatWechatMarkdown(entry: Omit<RunLogEntry, 'version'>): string {
  const lines = [
    '### 长沙移动报备运行结果',
    `运行编号：${entry.runId}`,
    `> 状态：<font color="${entry.status === 'FAILED' || entry.status === 'COMPLETED_WITH_ERRORS' ? 'warning' : 'info'}">${statusText(entry.status)}</font>`,
    `执行模式：${modeText(entry.mode)}`,
    `开始时间：${formatLogTime(entry.startedAt)}`,
    `结束时间：${formatLogTime(entry.finishedAt)}`,
    entry.batchId ? `批次号：${entry.batchId}` : undefined,
    entry.total === undefined ? undefined : `${entry.command === 'batch' ? '文件总数' : '网站报备总条数'}：${entry.total}`,
    entry.succeeded === undefined ? undefined : `${entry.command === 'batch' ? '处理完成文件数' : '网站报备成功条数'}：${entry.succeeded}`,
    entry.failed === undefined ? undefined : `${entry.command === 'batch' ? '处理异常文件数' : '网站报备失败条数'}：${entry.failed}`,
    entry.websiteTotal === undefined ? undefined : `网站报备总条数：${entry.websiteTotal}`,
    entry.websiteSucceeded === undefined ? undefined : `网站报备成功条数：${entry.websiteSucceeded}`,
    entry.websiteFailed === undefined ? undefined : `网站报备失败条数：${entry.websiteFailed}`,
    entry.skipped === undefined ? undefined : `跳过数：${entry.skipped}`,
    entry.fileNames?.length ? `文件：${entry.fileNames.join('、')}` : undefined,
    entry.failedFiles?.length ? `失败文件：${entry.failedFiles.join('、')}` : undefined,
    entry.error ? `错误摘要：${entry.error}` : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

async function trySendWechatWorkLog(webhookUrl: string | undefined, entry: Omit<RunLogEntry, 'version'>): Promise<void> {
  if (!webhookUrl) return;
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: formatWechatMarkdown(entry) } }),
    });
    const result = await response.json() as { errcode?: number; errmsg?: string };
    if (!response.ok || result.errcode !== 0) {
      throw new Error(`企业微信机器人返回异常：HTTP ${response.status} ${result.errmsg ?? ''}`.trim());
    }
  } catch (error: unknown) {
    console.warn(`[企业微信日志] 发送失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 追加一条本地运行日志。日志失败不能阻断报备主流程。
 */
export async function appendRunLog(stateDir: string, entry: Omit<RunLogEntry, 'version'>, config?: Pick<AppConfig, 'wechatWorkWebhookUrl'>): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true });
    const filePath = path.join(stateDir, 'run-log.ndjson');
    await appendFile(filePath, `${JSON.stringify(toChineseRunLog(entry))}\n`, 'utf8');
  } catch (error: unknown) {
    console.warn(`[运行日志] 写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (config?.wechatWorkWebhookUrl) {
    try {
      await enqueueNotification(stateDir, config.wechatWorkWebhookUrl, entry.runId, formatWechatMarkdown(entry));
      await flushNotifications(stateDir, config.wechatWorkWebhookUrl);
    } catch { console.warn('[企微补发] 无法保存或更新通知队列，请检查磁盘空间和权限。'); }
  }
}

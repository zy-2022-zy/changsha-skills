import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type BatchItemStatus = 'PENDING' | 'VALIDATION_FAILED' | 'SUBMITTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
export type BatchStateStatus = 'PRECHECKED' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS';

export type BatchItemState = {
  fileName: string;
  sourcePath: string;
  sha256?: string;
  dataRows?: number;
  status: BatchItemStatus;
  batchId?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  downloadPath?: string;
  failureExportPath?: string;
  failureExportBatchId?: string;
  sedpPath?: string;
  lastError?: string;
  updatedAt: string;
};

export type BatchState = {
  mergedResults?: Record<string, string>;
  version: 1;
  batchId: string;
  createdAt: string;
  updatedAt: string;
  status: BatchStateStatus;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  items: BatchItemState[];
};

export function buildBatchId(items: Array<{ fileName: string; sha256?: string; sourcePath?: string }>): string {
  const identity = [...items]
    .map((item) => `${item.sha256 ?? ''}:${item.fileName}:${item.sourcePath ?? ''}`)
    .sort()
    .join('|');
  return `batch-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

function batchPath(stateDir: string, batchId: string): string {
  return path.join(stateDir, 'batches', `${batchId}.json`);
}

export async function readBatchState(stateDir: string, batchId: string): Promise<BatchState | undefined> {
  try {
    return JSON.parse(await readFile(batchPath(stateDir, batchId), 'utf8')) as BatchState;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeBatchState(stateDir: string, state: BatchState): Promise<void> {
  await mkdir(path.join(stateDir, 'batches'), { recursive: true });
  const destination = batchPath(stateDir, state.batchId);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

export function summarizeBatch(state: BatchState): BatchState {
  const completed = state.items.filter((item) => item.status === 'COMPLETED').length;
  const failed = state.items.filter((item) => item.status === 'FAILED' || item.status === 'VALIDATION_FAILED').length;
  const skipped = state.items.filter((item) => item.status === 'SKIPPED').length;
  const unfinished = state.items.some((item) => !['COMPLETED', 'FAILED', 'VALIDATION_FAILED', 'SKIPPED'].includes(item.status));
  return {
    ...state,
    updatedAt: new Date().toISOString(),
    completed,
    failed,
    skipped,
    status: unfinished ? 'RUNNING' : failed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
  };
}

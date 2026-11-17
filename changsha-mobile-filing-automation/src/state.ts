import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type FilingStateStatus = 'SUBMITTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type FilingState = {
  version: 1;
  sha256: string;
  fileName: string;
  sourcePath: string;
  archivedSourcePath?: string;
  archivePending?: boolean;
  submissionUncertain?: boolean;
  status: FilingStateStatus;
  submittedAt: string;
  updatedAt: string;
  batchId?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  downloadPath?: string;
  failureExportPath?: string;
  failureExportBatchId?: string;
  sedpPath?: string;
  lastError?: string;
};

function statePath(stateDir: string, sha256: string, sourcePath?: string): string {
  if (!sourcePath) return path.join(stateDir, `${sha256}.json`);
  const sourceKey = createHash('sha256').update(path.resolve(sourcePath).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(stateDir, `${sha256}-${sourceKey}.json`);
}

async function readState(filePath: string): Promise<FilingState | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as FilingState;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function matchesSourceFile(state: FilingState, sourcePath: string): boolean {
  return state.fileName.toLowerCase() === path.basename(state.sourcePath).toLowerCase()
    && path.resolve(state.sourcePath).toLowerCase() === path.resolve(sourcePath).toLowerCase();
}

export async function readFilingState(stateDir: string, sha256: string, sourcePath?: string): Promise<FilingState | undefined> {
  if (!sourcePath) return readState(statePath(stateDir, sha256));
  const current = await readState(statePath(stateDir, sha256, sourcePath));
  if (current && matchesSourceFile(current, sourcePath)) return current;
  // 兼容旧版本的状态文件，但只能在原始文件路径一致时使用，避免相同内容的不同文件串单。
  const legacy = await readState(statePath(stateDir, sha256));
  return legacy && matchesSourceFile(legacy, sourcePath) ? legacy : undefined;
}

export async function writeFilingState(stateDir: string, state: FilingState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const destination = statePath(stateDir, state.sha256, state.sourcePath);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

export function stateForSubmission(input: { sha256: string; fileName: string; sourcePath: string }): FilingState {
  const now = new Date().toISOString();
  return {
    version: 1,
    sha256: input.sha256,
    fileName: input.fileName,
    sourcePath: input.sourcePath,
    status: 'SUBMITTED',
    submittedAt: now,
    updatedAt: now,
  };
}

export function stateForResult(state: FilingState, result: {
  batchId?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  downloadPath?: string;
  failureExportPath?: string;
  failureExportBatchId?: string;
  sedpPath?: string;
}): FilingState {
  return {
    ...state,
    status: 'COMPLETED',
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    ...result,
  };
}

export function stateForTask(state: FilingState, batchId: string): FilingState {
  return {
    ...state,
    status: 'PROCESSING',
    batchId,
    updatedAt: new Date().toISOString(),
  };
}

export function stateForError(state: FilingState, error: unknown): FilingState {
  return {
    ...state,
    status: 'FAILED',
    updatedAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.message : String(error),
  };
}

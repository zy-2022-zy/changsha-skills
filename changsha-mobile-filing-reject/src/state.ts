import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DateRange } from './dates.js';
import type { WorkbookSummary } from './workbook.js';

export type ExportState = {
  version: 1; range?: DateRange; origin: string;
  phase: 'submitting' | 'submitted' | 'downloaded' | 'completed';
  batchId?: string; downloadPath?: string; summary?: WorkbookSummary;
  sedpPath?: string; sedpTotal?: number; sedpFailed?: number; sedpError?: string; updatedAt: string;
};
export function stateKey(range: DateRange, origin: string): string {
  return createHash('sha256').update(JSON.stringify([origin, range.start, range.end, '集团驳回', '驳回端口导出'])).digest('hex').slice(0, 24);
}
export async function readState(file: string): Promise<ExportState | undefined> {
  try {
    const state = JSON.parse(await readFile(file, 'utf8')) as ExportState;
    if (state.version !== 1 || !['submitting', 'submitted', 'downloaded', 'completed'].includes(state.phase)) throw new Error('状态文件格式错误。');
    return state;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function saveState(file: string, state: ExportState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  state.updatedAt = new Date().toISOString();
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

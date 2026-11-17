import { copyFile, readFile, readdir, unlink, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeFilingState, type FilingState } from './state.js';

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
async function matches(file: string, sha: string): Promise<boolean> {
  return createHash('sha256').update(await readFile(file)).digest('hex') === sha;
}

/** Archive intent is persisted before copying. Retries verify bytes before deleting the source. */
export async function completeArchive(stateDir: string, state: FilingState): Promise<FilingState> {
  const target = state.archivedSourcePath;
  if (!target || !state.sedpPath || !await exists(state.sedpPath)) throw new Error('归档恢复缺少已生成的结果文档。');
  const sourceExists = await exists(state.sourcePath);
  if (sourceExists && !await matches(state.sourcePath, state.sha256)) throw new Error('原文件内容已变更，停止归档恢复。');
  await mkdir(path.dirname(target), { recursive: true });
  if (!await exists(target)) {
    if (!sourceExists) throw new Error('原文件和归档文件均不存在。');
    await copyFile(state.sourcePath, target, constants.COPYFILE_EXCL);
  }
  if (!await matches(target, state.sha256)) throw new Error('归档文件校验失败，原文件已保留，请检查归档文件。');
  if (sourceExists && path.resolve(target) !== path.resolve(state.sourcePath)) await unlink(state.sourcePath);
  const completed: FilingState = { ...state, status: 'COMPLETED', archivePending: false, lastError: undefined, updatedAt: new Date().toISOString() };
  await writeFilingState(stateDir, completed);
  return completed;
}

export async function recoverArchives(stateDir: string): Promise<void> {
  const names = await readdir(stateDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let state: FilingState;
    try { state = JSON.parse(await readFile(path.join(stateDir, name), 'utf8')); } catch { continue; }
    if (!state.archivePending) continue;
    await completeArchive(stateDir, state);
    console.log(`已恢复归档完成状态：${state.fileName}`);
  }
}

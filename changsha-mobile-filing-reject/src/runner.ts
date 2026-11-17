import path from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Config } from './config.js';
import type { DateRange } from './dates.js';
import { dateFolder } from './dates.js';
import { readState, saveState, stateKey, type ExportState } from './state.js';
import { inspectWorkbook } from './workbook.js';
import { generateSedpWorkbook } from './sedp.js';
import { RejectPortal } from './portal.js';
import { acquireRunLock } from './run-lock.js';

export interface Portal {
  login(): Promise<void>;
  prepare(range: DateRange): Promise<void>;
  createExport(): Promise<string>;
  waitAndDownload(batchId: string): Promise<string>;
  close(): Promise<void>;
}
type RunOptions = { range?: DateRange; batchId?: string; resultsOnly?: boolean; headerRow?: number; noSedp?: boolean };

export async function run(config: Config, options: RunOptions, launch?: () => Promise<Portal>): Promise<ExportState> {
  const unlock = await acquireRunLock(config.authDir);
  let portal: Portal | undefined;
  try {
    const origin = new URL(config.baseUrl).origin;
    let file = options.range ? path.join(config.stateDir, `${stateKey(options.range, origin)}.json`) : '';
    if (!file && options.batchId) {
      const names = await readdir(config.stateDir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
      for (const name of names.filter(n => n.endsWith('.json'))) {
        const candidate = path.join(config.stateDir, name);
        const saved = await readState(candidate);
        if (saved?.batchId === options.batchId && saved.origin === origin) {
          if (file) throw new Error('批次号对应多个状态文件，请指定日期范围。');
          file = candidate;
        }
      }
      file ||= path.join(config.stateDir, `batch-${options.batchId}.json`);
    }
    if (!file) throw new Error('请指定导出日期或续查批次号。');
    let state = await readState(file);
    if (state && state.origin !== origin) throw new Error('状态文件门户地址不匹配。');
    if (options.batchId) {
      if (state?.batchId && state.batchId !== options.batchId) throw new Error('指定批次号与已保存状态不一致。');
      state = { ...(state ?? { version: 1, origin, range: options.range, updatedAt: '' }), phase: 'submitted', batchId: options.batchId,
        ...(state?.batchId === options.batchId ? { phase: state.phase } : {}) };
      await saveState(file, state);
    }
    if (state?.downloadPath) {
      try {
        const summary = await inspectWorkbook(state.downloadPath, options.headerRow);
        state = { ...state, phase: 'completed', summary, ...(await buildSedp(state.downloadPath, options.headerRow, options.noSedp)) };
        await saveState(file, state);
        return state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // 已下载文件被移走时，只重新下载原批次。
      }
    }
    if (state?.phase === 'submitting' && !state.batchId) throw new Error('上次导出提交结果不确定。请在门户核实“驳回端口导出”任务批次号，再用 results --batch-id <批次号> 并指定原日期续查；不会自动重建任务。');
    if (options.resultsOnly && !state?.batchId) throw new Error('尚无导出批次，results 不会创建新任务。');
    portal = await (launch ? launch() : RejectPortal.launch({ ...config, downloadDir: path.join(config.downloadDir, dateFolder(state?.range ?? options.range)) }));
    await portal.login();
    if (!state?.batchId) {
      if (!options.range) throw new Error('新导出必须有日期范围。');
      await portal.prepare(options.range);
      state = { version: 1, origin, range: options.range, phase: 'submitting', updatedAt: '' };
      // 在可能产生门户任务的第一次点击前持久化，响应丢失时不自动重提。
      await saveState(file, state);
      const batchId = await portal.createExport();
      state = { ...state, batchId, phase: 'submitted' };
      await saveState(file, state);
    }
    const downloadPath = await portal.waitAndDownload(state!.batchId!);
    state = { ...state!, phase: 'downloaded', downloadPath };
    await saveState(file, state);
    const summary = await inspectWorkbook(downloadPath, options.headerRow);
    state = { ...state, phase: 'completed', summary, ...(await buildSedp(downloadPath, options.headerRow, options.noSedp)) };
    await saveState(file, state);
    return state;
  } finally {
    try { await portal?.close(); } finally { await unlock(); }
  }
}

/** 集团驳回记录再次上传必然失败，直接转成 SEDP 上传格式；签名列留空。 */
async function buildSedp(downloadPath: string, headerRow?: number, skip = false):
Promise<Pick<ExportState, 'sedpPath' | 'sedpTotal' | 'sedpFailed' | 'sedpError'>> {
  if (skip) return {};
  try {
    const outputPath = path.join(path.dirname(downloadPath),
      `${path.basename(downloadPath, path.extname(downloadPath))}-SEDP需要上传的文档.xlsx`);
    const result = await generateSedpWorkbook(downloadPath, outputPath, headerRow);
    return { sedpPath: result.outputPath, sedpTotal: result.total, sedpFailed: result.failed, sedpError: undefined };
  } catch (error) {
    // SEDP 转换失败不影响已下载的驳回结果；记录原因，后续用 sedp 命令单独重试。
    return { sedpPath: undefined, sedpTotal: undefined, sedpFailed: undefined, sedpError: error instanceof Error ? error.message : String(error) };
  }
}

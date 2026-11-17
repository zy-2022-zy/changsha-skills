import path from 'node:path';
import { completeArchive } from './recovery.js';
import { loadConfig } from './config.js';
import { MobilePortal, type ImportResult } from './portal.js';
import { generateSedpWorkbook } from './sedp.js';
import { stateForResult, stateForTask, writeFilingState, type FilingState } from './state.js';
import { ensureFilingDirectories, moveArtifact } from './directories.js';
import { trySendRemoteLog } from './remote-log.js';

export type FilingFile = { absolutePath: string; fileName: string; sha256: string };

/** 门户仍在异步处理；保留任务状态，后续启动可按同一批次继续查询。 */
export class ResultPendingError extends Error {
  constructor(readonly state: FilingState, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ResultPendingError';
  }
}

export async function waitForManualLogin(portal: MobilePortal): Promise<void> {
  await portal.openLogin();
  if (await portal.isAuthenticated()) {
    await portal.saveAuthenticationState();
    console.log('已恢复上次登录状态，无需重新登录。');
    return;
  }
  console.log('浏览器已打开。请自行输入账号、完成计算题及短信验证码；脚本会自动检测登录成功。');
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if (await portal.isAuthenticated()) {
      await portal.saveAuthenticationState();
      console.log('登录成功，已将登录状态安全保存在本机，后续启动将自动恢复。');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('10 分钟内未检测到登录后的端口上报管理菜单。请确认已经成功登录后重试。');
}

export async function finishResult(
  config: ReturnType<typeof loadConfig>,
  file: FilingFile,
  portal: MobilePortal,
  state: FilingState,
  options: { sedpOutputPath?: string; result?: ImportResult } = {},
): Promise<FilingState> {
  await ensureFilingDirectories(config);
  let workingState = state;
  let result = options.result;
  if (!result) {
    try {
      result = await portal.waitForImportResult(file.fileName, async (batchId) => {
        workingState = stateForTask(workingState, batchId);
        await writeFilingState(config.stateDir, workingState);
      }, workingState.batchId);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('等待导入结果超时')) {
        await writeFilingState(config.stateDir, workingState);
        throw new ResultPendingError(workingState, error);
      }
      throw error;
    }
  }
  const artifacts = await portal.downloadArtifacts({ ...result, failureExportBatchId: workingState.failureExportBatchId }, async (exportId) => {
    workingState.failureExportBatchId = exportId;
    state.failureExportBatchId = exportId;
    await writeFilingState(config.stateDir, workingState);
  });
  if (!artifacts) throw new ResultPendingError(workingState, new Error('导出任务处理中，继续轮询。'));
  const downloadPath = await moveArtifact(artifacts.downloadPath, config.completedDir);
  // 失败明细只作为生成报备结果资料的中间输入，不再归档到独立的“错误信息”目录。
  // 原始下载文件保留在内部 downloads 目录，便于失败重试和技术排查。
  const failureExportPath = artifacts.failureExportPath;
  const failureExportBatchId = artifacts.failureExportBatchId;
  const generated = await generateSedpWorkbook({
    sourcePath: file.absolutePath,
    errorsPath: failureExportPath,
    expectedTotal: result.total,
    expectedFailed: result.failed,
    outputPath: options.sedpOutputPath ?? path.join(config.reportResultDir, `${path.basename(file.fileName, path.extname(file.fileName))}-报备结果.xlsx`),
  });
  let completed = stateForResult(workingState, {
    batchId: result.batchId,
    total: result.total,
    succeeded: result.succeeded,
    failed: result.failed,
    downloadPath,
    failureExportPath,
    failureExportBatchId,
    sedpPath: generated.outputPath,
  });
  completed.archivedSourcePath = path.join(config.completedDir, `${path.basename(file.fileName, path.extname(file.fileName))}-${completed.batchId ?? file.sha256.slice(0, 12)}.xlsx`);
  completed.archivePending = true;
  completed.status = 'PROCESSING';
  Object.assign(state, completed);
  await writeFilingState(config.stateDir, completed);
  completed = await completeArchive(config.stateDir, completed);
  await trySendRemoteLog(config, {
    event: 'filing.completed',
    fileName: file.fileName,
    batchId: completed.batchId,
    status: completed.status,
    total: completed.total,
    succeeded: completed.succeeded,
    failed: completed.failed,
  });
  console.log(JSON.stringify({ ...artifacts, sedp: generated, state: completed }, null, 2));
  return completed;
}

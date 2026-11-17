import path from 'node:path';
import { access, readdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { MobilePortal } from './portal.js';
import { finishResult, ResultPendingError, type FilingFile } from './runner.js';
import { readFilingState, stateForError, stateForSubmission, stateForTask, writeFilingState, type FilingState } from './state.js';
import { buildBatchId, readBatchState, summarizeBatch, writeBatchState, type BatchItemState, type BatchState } from './batch-state.js';
import { validateUploadFile, type UploadFileValidation } from './validation.js';
import { trySendRemoteLog } from './remote-log.js';
import { moveArtifact } from './directories.js';
import { splitWorkbookIfNeeded, type SplitWorkbookOptions } from './splitter.js';
import { appendRunLog, newRunId } from './run-log.js';
import { mergeSedpWorkbooks } from './sedp.js';
import { describeValidationFailure } from './validation-report.js';

export type PreparedBatchItem = {
  sourcePath: string;
  fileName: string;
  file?: UploadFileValidation;
  error?: string;
  parentSourcePath?: string;
  splitPart?: { index: number; total: number; sizeBytes: number };
};

function isGeneratedOutput(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return normalized.includes('sedp需要上传的文档') || normalized.includes('报备结果');
}

export async function collectBatchFiles(input: { dir?: string; files?: string[] }): Promise<string[]> {
  const paths = [...(input.files ?? [])];
  if (input.dir) {
    const directory = path.resolve(input.dir);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.xlsx') && !isGeneratedOutput(entry.name)) {
        paths.push(path.join(directory, entry.name));
      }
    }
  }
  return [...new Set(paths.map((file) => path.resolve(file)))].sort((a, b) => a.localeCompare(b));
}

export async function prepareBatchFiles(paths: string[], splitOptions: SplitWorkbookOptions = {}, errorDirectory?: string): Promise<PreparedBatchItem[]> {
  const prepared: PreparedBatchItem[] = [];
  for (const sourcePath of paths) {
    try {
      const split = await splitWorkbookIfNeeded(sourcePath, splitOptions);
      if (split.split) console.log(`${path.basename(sourcePath)} 已自动拆分为 ${split.parts.length} 个合规的 .xlsx 子文件。`);
      for (const part of split.parts) {
        try {
          prepared.push({
            sourcePath: part.path,
            fileName: part.fileName,
            file: await validateUploadFile(part.path),
            parentSourcePath: split.split ? split.sourcePath : undefined,
            splitPart: split.split ? { index: part.index, total: part.total, sizeBytes: part.sizeBytes } : undefined,
          });
        } catch (error: unknown) {
          prepared.push({
            sourcePath: part.path,
            fileName: part.fileName,
            error: await describeValidationFailure(part.path, error, errorDirectory),
            parentSourcePath: split.split ? split.sourcePath : undefined,
            splitPart: split.split ? { index: part.index, total: part.total, sizeBytes: part.sizeBytes } : undefined,
          });
        }
      }
    } catch (error: unknown) {
      prepared.push({ sourcePath, fileName: path.basename(sourcePath), error: await describeValidationFailure(sourcePath, error, errorDirectory) });
    }
  }
  return prepared;
}

export async function archiveCompletedParents(config: ReturnType<typeof loadConfig>, items: PreparedBatchItem[], state: BatchState): Promise<void> {
  const parents = new Map<string, number[]>();
  for (let index = 0; index < items.length; index += 1) {
    const parent = items[index].parentSourcePath;
    if (!parent) continue;
    const indexes = parents.get(parent) ?? [];
    indexes.push(index);
    parents.set(parent, indexes);
  }
  for (const [parent, indexes] of parents) {
    if (!indexes.every((index) => state.items[index]?.status === 'COMPLETED' || state.items[index]?.status === 'SKIPPED')) continue;
    const ordered = indexes.sort((a, b) => items[a].splitPart!.index - items[b].splitPart!.index);
    if (ordered.length !== items[ordered[0]].splitPart!.total) throw new Error('拆分任务不完整，停止合并和归档。');
    const merged = await mergeSedpWorkbooks(ordered.map((index) => ({
      path: state.items[index].sedpPath!,
      total: state.items[index].total!,
      failed: state.items[index].failed!,
    })), path.join(config.reportResultDir, `${path.parse(parent).name}-报备结果.xlsx`));
    state.mergedResults = { ...state.mergedResults, [parent]: merged.outputPath };
    await writeBatchState(config.stateDir, state);
    try {
      await access(parent);
      await moveArtifact(parent, config.completedDir, path.basename(parent));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function newBatchState(items: PreparedBatchItem[], batchId: string): BatchState {
  const now = new Date().toISOString();
  return {
    version: 1,
    batchId,
    createdAt: now,
    updatedAt: now,
    status: 'RUNNING',
    total: items.length,
    completed: 0,
    failed: 0,
    skipped: 0,
    items: items.map((item): BatchItemState => ({
      fileName: item.fileName,
      sourcePath: item.sourcePath,
      sha256: item.file?.sha256,
      dataRows: item.file?.dataRows,
      status: item.error ? 'VALIDATION_FAILED' : 'PENDING',
      lastError: item.error,
      updatedAt: now,
    })),
  };
}

export async function runBatch(input: {
  config: ReturnType<typeof loadConfig>;
  portal?: MobilePortal;
  items: PreparedBatchItem[];
  submit: boolean;
  force: boolean;
}): Promise<BatchState> {
  const { config, portal, items, submit, force } = input;
  const startedAt = new Date().toISOString();
  const runId = newRunId();
  let batchId: string | undefined;
  let finalState: BatchState | undefined;
  let runError: string | undefined;
  try {
    batchId = buildBatchId(items.map((item) => ({ fileName: item.fileName, sha256: item.file?.sha256, sourcePath: item.sourcePath })));
    const previous = force ? undefined : await readBatchState(config.stateDir, batchId);
    let state = previous ?? newBatchState(items, batchId);
    state = {
      ...state,
      total: items.length,
      items: items.map((item) => state.items.find((old) => !item.error && old.status !== 'VALIDATION_FAILED' && old.fileName === item.fileName && old.sha256 === item.file?.sha256) ?? {
        fileName: item.fileName,
        sourcePath: item.sourcePath,
        sha256: item.file?.sha256,
        dataRows: item.file?.dataRows,
        status: item.error ? 'VALIDATION_FAILED' : 'PENDING',
        lastError: item.error,
        updatedAt: new Date().toISOString(),
      }),
    };
    await writeBatchState(config.stateDir, summarizeBatch(state));

    if (!submit) {
      const prechecked = summarizeBatch(state);
      prechecked.status = prechecked.failed > 0 ? 'COMPLETED_WITH_ERRORS' : 'PRECHECKED';
      await writeBatchState(config.stateDir, prechecked);
      finalState = prechecked;
      return prechecked;
    }
    if (!portal) throw new Error('批量提交需要浏览器会话。');

    // 阶段一：连续提交所有文件。门户可并行处理多个批次，不能因第一个文件的结果等待阻塞后续上传。
    const awaitingResults: Array<{ index: number; filingFile: FilingFile; filingState: FilingState }> = [];
    for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const itemState = state.items[index];
    if (item.error || !item.file) {
      console.error(`[${index + 1}/${items.length}] ${item.fileName} 校验失败：${item.error}`);
      continue;
    }
    const filingFile: FilingFile = item.file;
    let filingState = await readFilingState(config.stateDir, filingFile.sha256, filingFile.absolutePath);
    // 报备以“文件”为单位：不同文件即使数据内容相同，也必须分别上传并取得各自的门户批次号。
    // 仅当当前原始文件本身已经完成且仍在同一路径时，才视为可跳过的重复执行。
    const sameSourceFile = filingState && path.resolve(filingState.sourcePath) === path.resolve(filingFile.absolutePath);
    if (filingState?.status === 'COMPLETED' && sameSourceFile && !force) {
      itemState.status = 'SKIPPED';
      // 内容完全相同的文件无需再次提交，但不应永久留在“待报备”目录。
      // 按当前文件名归档，保留来源文件与既有结果之间的关联。
      const archivedDuplicatePath = await moveArtifact(filingFile.absolutePath, config.completedDir, filingFile.fileName);
      if (archivedDuplicatePath) itemState.sourcePath = archivedDuplicatePath;
      itemState.batchId = filingState.batchId;
      itemState.total = filingState.total;
      itemState.succeeded = filingState.succeeded;
      itemState.failed = filingState.failed;
      itemState.downloadPath = filingState.downloadPath;
      itemState.failureExportPath = filingState.failureExportPath;
      itemState.failureExportBatchId = filingState.failureExportBatchId;
      itemState.sedpPath = filingState.sedpPath;
      itemState.updatedAt = new Date().toISOString();
      state = summarizeBatch(state);
      await writeBatchState(config.stateDir, state);
      console.log(`[${index + 1}/${items.length}] ${item.fileName} 已完成，跳过重复提交`);
      continue;
    }
    try {
      // 若浏览器在上传前异常关闭，失败状态不会有门户批次号；下次一键运行应自动重新上传，
      // 不能把它误当成已提交任务而一直等待一个不存在的结果。
      if (filingState?.submissionUncertain && !filingState.batchId && !force) throw new Error('上次上传结果未确认，请先在门户核对批次号，避免重复上传。');
      const needsUpload = !filingState
        || force
        || (filingState.status === 'FAILED' && !filingState.batchId)
        || (filingState.status === 'COMPLETED' && !sameSourceFile);
      if (needsUpload) {
        filingState = stateForSubmission({ sha256: filingFile.sha256, fileName: filingFile.fileName, sourcePath: filingFile.absolutePath });
        filingState.submissionUncertain = true;
        await writeFilingState(config.stateDir, filingState);
        const submission = await portal.uploadExcel(filingFile.absolutePath);
        filingState.submissionUncertain = !submission.batchId;
        if (submission.batchId) filingState = stateForTask(filingState, submission.batchId);
        await writeFilingState(config.stateDir, filingState);
        itemState.status = 'SUBMITTED';
        itemState.updatedAt = new Date().toISOString();
        await writeBatchState(config.stateDir, summarizeBatch(state));
      } else {
        if (!filingState) throw new Error('恢复报备任务时未找到任务状态。');
        itemState.status = filingState.status === 'PROCESSING' ? 'PROCESSING' : 'SUBMITTED';
      }
      if (!filingState) throw new Error('上传后未生成报备任务状态。');
      itemState.status = filingState.batchId ? 'PROCESSING' : 'SUBMITTED';
      itemState.updatedAt = new Date().toISOString();
      itemState.lastError = undefined;
      awaitingResults.push({ index, filingFile, filingState });
    } catch (error: unknown) {
      const failedState = stateForError(filingState ?? stateForSubmission({ sha256: filingFile.sha256, fileName: filingFile.fileName, sourcePath: filingFile.absolutePath }), error);
      await writeFilingState(config.stateDir, failedState);
      itemState.status = 'FAILED';
      itemState.lastError = failedState.lastError;
      itemState.updatedAt = new Date().toISOString();
      console.error(`[${index + 1}/${items.length}] ${item.fileName} 处理失败：${failedState.lastError}`);
      await trySendRemoteLog(config, {
        event: 'filing.failed',
        fileName: item.fileName,
        batchId: failedState.batchId,
        status: failedState.status,
        error: failedState.lastError,
      });
    }
    state = summarizeBatch(state);
    await writeBatchState(config.stateDir, state);
    console.log(`提交进度：${index + 1}/${items.length}`);
    }

    // 阶段二：集中查询已提交批次。至此所有文件都已经交给门户，查询等待不会拖慢上传吞吐。
    console.log(`已提交 ${awaitingResults.length} 个文件，开始轮询所有门户批次…`);
    const remaining = [...awaitingResults];
    const queryDeadline = Date.now() + config.pollTimeoutMs;
    while (remaining.length > 0 && Date.now() < queryDeadline) {
      for (let position = remaining.length - 1; position >= 0; position -= 1) {
        const pending = remaining[position];
        const { index, filingFile } = pending;
        const itemState = state.items[index];
        let filingState = await readFilingState(config.stateDir, filingFile.sha256, filingFile.absolutePath) ?? pending.filingState;
        try {
          const result = await portal.queryImportResult(filingFile.fileName, async (portalBatchId) => {
            filingState = stateForTask(filingState, portalBatchId);
            pending.filingState = filingState;
            await writeFilingState(config.stateDir, filingState);
          }, filingState.batchId);
          if (!result) continue;
          const resultDirectory = items[index].parentSourcePath
            ? path.join(config.stateDir, 'split-results', state.batchId)
            : config.reportResultDir;
          const sedpOutputPath = path.join(resultDirectory, `${path.parse(filingFile.fileName).name}-报备结果.xlsx`);
          const completed = await finishResult(config, filingFile, portal, filingState, { sedpOutputPath, result });
        itemState.status = 'COMPLETED';
        itemState.sourcePath = completed.sourcePath;
        itemState.batchId = completed.batchId;
        itemState.total = completed.total;
        itemState.succeeded = completed.succeeded;
        itemState.failed = completed.failed;
        itemState.downloadPath = completed.downloadPath;
        itemState.failureExportPath = completed.failureExportPath;
        itemState.failureExportBatchId = completed.failureExportBatchId;
        itemState.sedpPath = completed.sedpPath;
        itemState.updatedAt = new Date().toISOString();
          itemState.lastError = undefined;
          remaining.splice(position, 1);
          console.log(`结果完成：${filingFile.fileName}；剩余 ${remaining.length} 个文件。`);
        } catch (error: unknown) {
          if (error instanceof ResultPendingError) {
            pending.filingState = error.state;
            itemState.failureExportBatchId = error.state.failureExportBatchId;
            itemState.status = 'PROCESSING';
            await writeBatchState(config.stateDir, summarizeBatch(state));
            continue;
          }
          const failedState = stateForError(filingState, error);
          await writeFilingState(config.stateDir, failedState);
          itemState.status = 'FAILED';
          itemState.lastError = failedState.lastError;
          itemState.updatedAt = new Date().toISOString();
          console.error(`[${index + 1}/${items.length}] ${filingFile.fileName} 结果处理失败：${failedState.lastError}`);
          remaining.splice(position, 1);
        }
        state = summarizeBatch(state);
        await writeBatchState(config.stateDir, state);
      }
      if (remaining.length > 0) await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
    for (const pending of remaining) {
      const itemState = state.items[pending.index];
      itemState.status = 'PROCESSING';
      itemState.batchId = pending.filingState.batchId;
      itemState.lastError = '门户仍在处理中，后续启动会按原批次号自动续查。';
      itemState.updatedAt = new Date().toISOString();
      await writeFilingState(config.stateDir, pending.filingState);
    }
    state = summarizeBatch(state);
    await archiveCompletedParents(config, items, state);
    await writeBatchState(config.stateDir, state);
    await trySendRemoteLog(config, {
      event: 'batch.completed',
      batchId: state.batchId,
      status: state.status,
      total: state.total,
      succeeded: state.completed,
      failed: state.failed,
      skipped: state.skipped,
    });
    finalState = state;
    return state;
  } catch (error: unknown) {
    runError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const state = finalState;
    const websiteItems = state?.items.filter((item) => item.status === 'COMPLETED') ?? [];
    const countsKnown = websiteItems.length > 0 && websiteItems.every((item) => Number.isInteger(item.total) && Number.isInteger(item.failed));
    const websiteTotal = countsKnown ? websiteItems.reduce((sum, item) => sum + item.total!, 0) : undefined;
    const websiteFailed = countsKnown ? websiteItems.reduce((sum, item) => sum + item.failed!, 0) : undefined;
    const logStatus = runError
      ? 'FAILED'
      : state?.status === 'PRECHECKED'
        ? 'PRECHECKED'
        : state?.status === 'COMPLETED_WITH_ERRORS'
          ? 'COMPLETED_WITH_ERRORS'
          : state?.status === 'COMPLETED'
            ? (websiteFailed ?? 0) > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED'
            : 'FAILED';
    // 本地日志始终保留；企业微信只在全部文件已经产生最终产物后通知。
    // 校验失败、页面定位异常、下载失败等中间异常不能被包装成“执行结果”。
    const shouldNotifyWechat = Boolean(
      submit
      && state
      && state.items.some((item) => item.status === 'COMPLETED')
      && state.items.every((item) => item.status === 'COMPLETED' || item.status === 'SKIPPED'),
    );
    await appendRunLog(config.stateDir, {
      runId,
      command: 'batch',
      mode: submit ? 'submit' : 'precheck',
      startedAt,
      finishedAt: new Date().toISOString(),
      status: logStatus,
      batchId,
      total: state?.total ?? items.length,
      succeeded: state?.completed,
      failed: state?.failed ?? items.filter((item) => Boolean(item.error)).length,
      skipped: state?.skipped,
      websiteTotal,
      websiteFailed,
      websiteSucceeded: countsKnown ? websiteTotal! - websiteFailed! : undefined,
      fileNames: items.map((item) => item.fileName),
      failedFiles: state?.items.filter((item) => item.status === 'FAILED' || item.status === 'VALIDATION_FAILED').map((item) => item.fileName) ?? items.filter((item) => item.error).map((item) => item.fileName),
      error: runError,
    }, shouldNotifyWechat ? config : undefined);
  }
}

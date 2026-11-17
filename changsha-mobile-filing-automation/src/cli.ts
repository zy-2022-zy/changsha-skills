import path from 'node:path';
import { acquireRunLock } from './run-lock.js';
import { recoverArchives } from './recovery.js';
import { flushNotifications } from './notification-outbox.js';
import { loadConfig } from './config.js';
import { loadOptionalEnvFile } from './env.js';
import { MobilePortal } from './portal.js';
import { generateSedpWorkbook } from './sedp.js';
import { readFilingState, stateForError, stateForSubmission, stateForTask, writeFilingState } from './state.js';
import { validateUploadFile } from './validation.js';
import { finishResult, ResultPendingError, waitForManualLogin } from './runner.js';
import { collectBatchFiles, prepareBatchFiles, runBatch } from './batch.js';
import { startFilingServer } from './server.js';
import { ensureFilingDirectories } from './directories.js';
import { trySendRemoteLog } from './remote-log.js';
import { appendRunLog, newRunId } from './run-log.js';

type ParsedArgs = {
  command: 'run' | 'results' | 'batch' | 'serve' | 'generate-sedp';
  file?: string;
  files?: string[];
  dir?: string;
  source?: string;
  errors?: string;
  output?: string;
  submit: boolean;
  force: boolean;
};

function usage(): never {
  console.error('用法：pnpm start -- run --file <Excel路径> [--submit]');
  console.error('      pnpm start -- run --file <Excel路径> --submit [--force]');
  console.error('      pnpm start -- results --file <Excel路径>');
  console.error('      pnpm start -- batch [--dir <目录>] [--submit] [--force]');
  console.error('      pnpm start -- batch --file <文件1> --file <文件2> [--submit]');
  console.error('      pnpm start -- serve');
  console.error('      pnpm start -- generate-sedp --source <原始Excel> [--errors <失败结果Excel>] [--output <输出Excel>]');
  process.exit(2);
}

function optionValues(args: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function parseArgs(args: string[]): ParsedArgs {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const [command = 'run', ...rest] = normalizedArgs;
  if (command !== 'run' && command !== 'results' && command !== 'batch' && command !== 'serve' && command !== 'generate-sedp') usage();
  const files = optionValues(rest, '--file');
  const source = optionValues(rest, '--source')[0];
  const errors = optionValues(rest, '--errors')[0];
  const output = optionValues(rest, '--output')[0];
  const dir = optionValues(rest, '--dir')[0];
  if (command === 'generate-sedp') {
    if (!source) usage();
    return { command, source, errors, output, submit: false, force: false };
  }
  if (command === 'batch') {
    return { command, files, dir, submit: rest.includes('--submit'), force: rest.includes('--force') };
  }
  if (command === 'serve') return { command, submit: false, force: false };
  if (files.length !== 1) usage();
  return { command, file: files[0], submit: rest.includes('--submit'), force: rest.includes('--force') };
}

function printExternalChecks(checks: Iterable<string>): void {
  const unique = [...new Set(checks)];
  if (unique.length === 0) return;
  console.warn(`以下规则需在门户或主数据中继续核验，本地预检无法完成验真：${unique.join('；')}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await loadOptionalEnvFile();
  if (args.command === 'generate-sedp') {
    const outputPath = args.output ?? path.resolve(process.cwd(), `${path.basename(args.source!, path.extname(args.source!))}-报备结果.xlsx`);
    const result = await generateSedpWorkbook({ sourcePath: args.source!, errorsPath: args.errors, outputPath });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const config = loadConfig();
  const startedAt = new Date().toISOString();
  await ensureFilingDirectories(config);
  const releaseLock = await acquireRunLock(path.join(config.filingRootDir, '运行状态'));
  try {
  await recoverArchives(config.stateDir);
  await flushNotifications(config.stateDir, config.wechatWorkWebhookUrl).catch(() => console.warn('企微补发暂不可用，记录仍保留。'));
  if (args.command === 'serve') {
    const server = await startFilingServer(config);
    const shutdown = () => server.close();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await new Promise<void>((resolve) => server.on('close', resolve));
    return;
  }
  if (args.command === 'batch') {
    const directory = args.dir ?? ((args.files?.length ?? 0) === 0 ? config.pendingDir : undefined);
    const paths = await collectBatchFiles({ dir: directory, files: args.files });
    if (paths.length === 0) throw new Error('批次中没有找到可处理的 .xlsx 文件。');
    const items = await prepareBatchFiles(paths, {}, path.join(config.filingRootDir, '错误信息文档'));
    const invalid = items.filter((item) => item.error);
    console.log(`批次预检完成：共 ${items.length} 个文件，${items.length - invalid.length} 个可提交，${invalid.length} 个校验失败。`);
    printExternalChecks(items.flatMap((item) => item.file?.externalChecks ?? []));
    if (!args.submit || invalid.length === items.length) {
      for (const item of invalid) console.error(`${item.fileName}：${item.error}`);
      await runBatch({ config, items, submit: false, force: args.force });
      return;
    }
    const portal = await MobilePortal.launch(config);
    try {
      await waitForManualLogin(portal);
      const state = await runBatch({ config, portal, items, submit: true, force: args.force });
      console.log(JSON.stringify(state, null, 2));
    } finally {
      await portal.close();
    }
    return;
  }

  const file = await validateUploadFile(args.file!, path.join(config.filingRootDir, '错误信息文档'));
  printExternalChecks(file.externalChecks);
  const portal = await MobilePortal.launch(config);
  try {
    await waitForManualLogin(portal);
    const priorState = await readFilingState(config.stateDir, file.sha256, file.absolutePath);
    if (args.command === 'results') {
      const state = priorState ?? stateForSubmission({ sha256: file.sha256, fileName: file.fileName, sourcePath: file.absolutePath });
      try {
        const completed = await finishResult(config, file, portal, state);
        await appendRunLog(config.stateDir, {
          runId: newRunId(), command: 'results', mode: 'results', startedAt, finishedAt: new Date().toISOString(),
          status: (completed.failed ?? 0) > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
          batchId: completed.batchId, total: completed.total, succeeded: completed.succeeded, failed: completed.failed,
          fileNames: [file.fileName],
        }, config);
      } catch (error: unknown) {
        if (error instanceof ResultPendingError) {
          console.warn('门户仍在处理中，已保留任务状态；下次运行将自动续查，不会重复上传。');
          return;
        }
        const failedState = stateForError(state, error);
        await writeFilingState(config.stateDir, failedState);
        await trySendRemoteLog(config, {
          event: 'filing.failed',
          fileName: file.fileName,
          batchId: failedState.batchId,
          status: failedState.status,
          error: failedState.lastError,
        });
        throw error;
      }
      return;
    }
    if (!args.submit) {
      console.log(`已校验文件：${file.absolutePath}`);
      console.log('为避免误提交，默认只完成登录检查。确认要上传时，请重新运行并添加 --submit。');
      return;
    }
    if (priorState?.status === 'COMPLETED' && !args.force) {
      console.log(JSON.stringify({ message: '该文件已有已完成任务，未重复提交。若确需重报，请添加 --force。', state: priorState }, null, 2));
      return;
    }
    let state = priorState;
    if (state?.submissionUncertain && !state.batchId && !args.force) throw new Error('上次上传结果未确认，请先核对门户批次号。');
    if (!state || args.force) {
      state = stateForSubmission({ sha256: file.sha256, fileName: file.fileName, sourcePath: file.absolutePath });
      state.submissionUncertain = true;
      await writeFilingState(config.stateDir, state);
      const submission = await portal.uploadExcel(file.absolutePath);
      state.submissionUncertain = !submission.batchId;
      if (submission.batchId) state = stateForTask(state, submission.batchId);
      await writeFilingState(config.stateDir, state);
      console.log('已确认提交批量导入，已记录本地任务状态，正在等待处理完成…');
    } else {
      console.log(`检测到未完成任务（${state.status}），跳过重复上传，继续查询结果…`);
    }
    try {
      const completed = await finishResult(config, file, portal, state);
      await appendRunLog(config.stateDir, {
        runId: newRunId(), command: 'run', mode: 'submit', startedAt, finishedAt: new Date().toISOString(),
        status: (completed.failed ?? 0) > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
        batchId: completed.batchId, total: completed.total, succeeded: completed.succeeded, failed: completed.failed,
        fileNames: [file.fileName],
      }, config);
    } catch (error: unknown) {
      if (error instanceof ResultPendingError) {
        console.warn('门户仍在处理中，已保留任务状态；下次运行将自动续查，不会重复上传。');
        return;
      }
      const failedState = stateForError(state, error);
      await writeFilingState(config.stateDir, failedState);
      await trySendRemoteLog(config, {
        event: 'filing.failed',
        fileName: file.fileName,
        batchId: failedState.batchId,
        status: failedState.status,
        error: failedState.lastError,
      });
      throw error;
    }
  } finally {
    await portal.close();
  }
  } finally { await releaseLock(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

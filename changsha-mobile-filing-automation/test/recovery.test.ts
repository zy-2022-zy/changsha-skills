import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireRunLock } from '../src/run-lock.js';
import { readFilingState, writeFilingState, stateForSubmission } from '../src/state.js';
import { MobilePortal } from '../src/portal.js';

test('duplicate process launch is refused and normal release permits restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'filing-lock-'));
  const release = await acquireRunLock(root);
  await assert.rejects(acquireRunLock(root), /已有报备程序/);
  await release();
  await (await acquireRunLock(root))();
});

test('export checkpoint and archived path retain the original task lookup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'filing-recovery-'));
  const state = stateForSubmission({ sha256: 'abc', fileName: 'a.xlsx', sourcePath: path.join(root, 'a.xlsx') });
  state.failureExportBatchId = '222';
  await writeFilingState(root, state);
  assert.equal((await readFilingState(root, 'abc', state.sourcePath))?.failureExportBatchId, '222');
  state.archivedSourcePath = path.join(root, 'archive', 'a.xlsx');
  state.status = 'COMPLETED';
  await writeFilingState(root, state);
  assert.equal((await readFilingState(root, 'abc', state.sourcePath))?.status, 'COMPLETED');
});

test('unknown or inconsistent portal counts cannot generate a success result', async () => {
  const portal = Object.create(MobilePortal.prototype) as MobilePortal;
  await assert.rejects(portal.downloadArtifacts({ taskName: 'a', status: '处理完成', total: 1 }), /数量缺失/);
  await assert.rejects(portal.downloadArtifacts({ taskName: 'a', status: '处理完成', total: 1, failed: 1, succeeded: 1 }), /不一致/);
  assert.equal((await portal.downloadArtifacts({ taskName: 'a', status: '处理完成', total: 1, failed: 0 }))?.failed, 0);
});

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFilingState, stateForResult, stateForSubmission, writeFilingState } from '../src/state.js';

test('filing state survives a process restart and preserves completion artifacts', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'filing-state-'));
  const submitted = stateForSubmission({ sha256: 'a'.repeat(64), fileName: 'ports.xlsx', sourcePath: 'ports.xlsx' });
  await writeFilingState(stateDir, submitted);
  const persisted = await readFilingState(stateDir, submitted.sha256, submitted.sourcePath);
  assert.equal(persisted?.status, 'SUBMITTED');

  const completed = stateForResult(submitted, {
    batchId: '2091768331061223426',
    total: 3,
    succeeded: 2,
    failed: 1,
    sedpPath: path.join(stateDir, 'ports-SEDP.xlsx'),
  });
  await writeFilingState(stateDir, completed);
  const finalState = await readFilingState(stateDir, submitted.sha256, completed.sourcePath);
  assert.equal(finalState?.status, 'COMPLETED');
  assert.equal(finalState?.batchId, '2091768331061223426');
  assert.equal(finalState?.failed, 1);
});

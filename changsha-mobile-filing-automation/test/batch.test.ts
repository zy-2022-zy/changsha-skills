import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBatchId, readBatchState, summarizeBatch, writeBatchState, type BatchState } from '../src/batch-state.js';
import { collectBatchFiles, archiveCompletedParents } from '../src/batch.js';
import XLSX from 'xlsx';

test('parent output waits for every part, then merges before archiving original', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'filing-parent-'));
  const parent = path.join(directory, '资料-2026.xlsx');
  await writeFile(parent, 'original');
  const config = { stateDir: path.join(directory, 'state'), completedDir: path.join(directory, 'archive'), reportResultDir: path.join(directory, 'results') } as Parameters<typeof archiveCompletedParents>[0];
  const items = [1, 2].map((index) => ({ sourcePath: `${parent}-${index}`, fileName: `资料-2026-${index}.xlsx`, parentSourcePath: parent, splitPart: { index, total: 2, sizeBytes: 1 } }));
  const state: BatchState = { version: 1, batchId: 'batch-parent', createdAt: '', updatedAt: '', status: 'RUNNING', total: 2, completed: 1, failed: 0, skipped: 0, items: items.map((item, index) => ({ fileName: item.fileName, sourcePath: item.sourcePath, status: index ? 'PROCESSING' : 'COMPLETED', total: 1, failed: 0, updatedAt: '', sedpPath: path.join(directory, `result-${index}.xlsx`) })) };
  for (const item of state.items) {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['子端口', '签名', '报备结果', '备注'], ['1001', null, '成功', null]]), 'Sheet1');
    XLSX.writeFile(book, item.sedpPath!);
  }
  await archiveCompletedParents(config, items, state);
  await access(parent);
  const output = path.join(config.reportResultDir, '资料-2026-报备结果.xlsx');
  await assert.rejects(access(output));
  state.items[1].status = 'SKIPPED';
  await archiveCompletedParents(config, items, state);
  await access(output);
  await assert.rejects(access(parent));
  await access(path.join(config.completedDir, path.basename(parent)));
  assert.equal(state.mergedResults?.[parent], output);
});

test('batch id is deterministic and generated SEDP files are excluded', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'filing-batch-'));
  await writeFile(path.join(directory, 'b.xlsx'), 'placeholder');
  await writeFile(path.join(directory, 'a.xlsx'), 'placeholder');
  await writeFile(path.join(directory, 'a-SEDP需要上传的文档.xlsx'), 'placeholder');
  await writeFile(path.join(directory, 'a-报备结果.xlsx'), 'placeholder');
  const files = await collectBatchFiles({ dir: directory });
  assert.deepEqual(files.map((file) => path.basename(file)), ['a.xlsx', 'b.xlsx']);
  assert.equal(buildBatchId([{ fileName: 'b.xlsx', sha256: '2' }, { fileName: 'a.xlsx', sha256: '1' }]), buildBatchId([{ fileName: 'a.xlsx', sha256: '1' }, { fileName: 'b.xlsx', sha256: '2' }]));
});

test('batch state persists and reports validation failures', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'filing-batch-state-'));
  const state: BatchState = {
    version: 1,
    batchId: 'batch-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'RUNNING',
    total: 2,
    completed: 0,
    failed: 0,
    skipped: 0,
    items: [
      { fileName: 'ok.xlsx', sourcePath: 'ok.xlsx', status: 'COMPLETED', updatedAt: new Date().toISOString() },
      { fileName: 'bad.xlsx', sourcePath: 'bad.xlsx', status: 'VALIDATION_FAILED', lastError: 'bad template', updatedAt: new Date().toISOString() },
    ],
  };
  const summarized = summarizeBatch(state);
  await writeBatchState(stateDir, summarized);
  const loaded = await readBatchState(stateDir, 'batch-test');
  assert.equal(loaded?.status, 'COMPLETED_WITH_ERRORS');
  assert.equal(loaded?.completed, 1);
  assert.equal(loaded?.failed, 1);
});

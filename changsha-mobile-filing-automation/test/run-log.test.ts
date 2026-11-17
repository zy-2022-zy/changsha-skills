import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendRunLog, formatLogTime, newRunId, formatWechatMarkdown } from '../src/run-log.js';

test('formatLogTime converts ISO UTC time to Beijing local time', () => {
  assert.equal(formatLogTime('2026-09-15T03:18:29.777Z'), '2026-09-15 11:18:29');
});

test('notification distinguishes finished files from rejected website records', () => {
  const message = formatWechatMarkdown({ runId: 'test', command: 'batch', mode: 'submit', startedAt: '2026-09-17T00:00:00Z', finishedAt: '2026-09-17T00:01:00Z', status: 'COMPLETED_WITH_ERRORS', total: 3, succeeded: 3, failed: 0, websiteTotal: 3, websiteSucceeded: 0, websiteFailed: 3 });
  assert.match(message, /处理完成文件数：3/);
  assert.match(message, /网站报备成功条数：0/);
  assert.match(message, /网站报备失败条数：3/);
});

test('appendRunLog records one structured result per run', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'filing-run-log-'));
  const runId = newRunId();
  await appendRunLog(stateDir, {
    runId,
    command: 'batch',
    mode: 'precheck',
    startedAt: '2026-09-15T02:00:00.000Z',
    finishedAt: '2026-09-15T02:00:01.000Z',
    status: 'PRECHECKED',
    total: 1,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    fileNames: ['示例.xlsx'],
    failedFiles: [],
  });
  const lines = (await readFile(path.join(stateDir, 'run-log.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(record['版本'], 1);
  assert.equal(record['运行编号'], runId);
  assert.equal(record['执行模式'], '批量预检');
  assert.equal(record['状态'], '预检完成');
  assert.equal(record['开始时间'], '2026-09-15 10:00:00');
  assert.equal(record['结束时间'], '2026-09-15 10:00:01');
  assert.deepEqual(record['文件名'], ['示例.xlsx']);
});

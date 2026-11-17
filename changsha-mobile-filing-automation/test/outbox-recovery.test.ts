import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { enqueueNotification, flushNotifications } from '../src/notification-outbox.js';
import { completeArchive, recoverArchives } from '../src/recovery.js';
import { stateForSubmission, writeFilingState, readFilingState } from '../src/state.js';

test('notification failure survives restart; success is not resent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outbox-'));
  const original = globalThis.fetch;
  const url = 'https://example.test/bot';
  try {
    globalThis.fetch = async () => { throw new Error('offline'); };
    await enqueueNotification(root, url, 'run-1', 'test');
    await flushNotifications(root, url);
    const dir = path.join(root, 'notification-outbox');
    const file = path.join(dir, (await readdir(dir))[0]);
    const pending = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(pending.attempts, 1);
    assert.equal(pending.sentAt, undefined);
    pending.nextAttempt = 0;
    await writeFile(file, JSON.stringify(pending));
    let sends = 0;
    globalThis.fetch = async () => { sends++; return new Response('{"errcode":0}', { status: 200 }); };
    await flushNotifications(root, url);
    await flushNotifications(root, url);
    assert.equal(sends, 1);
  } finally { globalThis.fetch = original; }
});

test('archive resumes after source removal and refuses changed source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archive-recover-'));
  const source = path.join(root, 'source.xlsx');
  const target = path.join(root, 'archive.xlsx');
  const output = path.join(root, 'result.xlsx');
  await writeFile(source, 'original');
  await writeFile(target, 'original');
  await writeFile(output, 'result');
  const state = stateForSubmission({ sourcePath: source, fileName: 'source.xlsx', sha256: createHash('sha256').update('original').digest('hex') });
  Object.assign(state, { archivePending: true, archivedSourcePath: target, sedpPath: output });
  await writeFilingState(root, state);
  await writeFile(source, 'changed');
  await assert.rejects(completeArchive(root, state), /内容已变更/);
  await unlink(source);
  await recoverArchives(root);
  assert.equal((await readFilingState(root, state.sha256, source))?.status, 'COMPLETED');
  assert.equal(await readFile(target, 'utf8'), 'original');
});

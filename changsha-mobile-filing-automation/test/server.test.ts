import assert from 'node:assert/strict';
import test from 'node:test';
import { createFilingServer } from '../src/server.js';

test('HTTP service exposes health and job submission/query endpoints', async () => {
  const jobs = new Map<string, { jobId: string; status: string }>();
  const service = {
    isPortalReady: () => false,
    listJobs: () => [...jobs.values()],
    getJob: (jobId: string) => jobs.get(jobId),
    submit: async () => {
      const job = { jobId: 'test-job', status: 'QUEUED' };
      jobs.set(job.jobId, job);
      return job;
    },
    retry: async () => ({ jobId: 'retry-job', status: 'QUEUED' }),
  } as never;
  const server = createFilingServer(service);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const response = await fetch(`${baseUrl}/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['a.xlsx'] }) });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).jobId, 'test-job');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

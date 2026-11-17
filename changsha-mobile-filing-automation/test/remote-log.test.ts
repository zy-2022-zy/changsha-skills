import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { sendRemoteLog } from '../src/remote-log.js';

test('remote execution logs are posted to the configured server', async () => {
  let body = '';
  let authorization = '';
  const server = createServer((request, response) => {
    authorization = request.headers.authorization ?? '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const config = loadConfig({
    REMOTE_LOG_URL: `http://127.0.0.1:${address.port}/events`,
    REMOTE_LOG_TOKEN: 'test-token',
    REMOTE_LOG_TIMEOUT_MS: '1000',
  });
  assert.equal(await sendRemoteLog(config, { event: 'filing.completed', fileName: 'a.xlsx', succeeded: 1 }), true);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(authorization, 'Bearer test-token');
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal(parsed.source, 'changsha-mobile-filing-automation');
  assert.equal(parsed.event, 'filing.completed');
  assert.equal(parsed.fileName, 'a.xlsx');
});

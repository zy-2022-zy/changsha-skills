import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

test('WorkBuddy MCP Server 完成初始化并公开三个分阶段登录工具', async t => {
  const root = process.cwd();
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, 'src/mcp.ts'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => {
    if (!child.killed) child.kill();
  });
  if (!child.stdout || !child.stdin) throw new Error('MCP 测试进程的标准输入输出管道未创建。');

  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on('line', line => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch { assert.fail(`MCP 标准输出包含非 JSON 内容：${line}`); }
    const id = message.id;
    if (typeof id === 'number') pending.get(id)?.(message);
  });

  const request = (id: number, method: string, params?: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP 请求超时：${method}`));
    }, 5_000);
    pending.set(id, value => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(value);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\\n');
  });

  const initialized = await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'unit-test', version: '1.0.0' },
  });
  assert.ok(initialized.result);

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');

  const listed = await request(2, 'tools/list');
  const result = listed.result as { tools?: Array<{ name: string }> };
  assert.deepEqual(result.tools?.map(tool => tool.name), [
    'login_start',
    'login_verify_captcha',
    'login_submit_sms',
  ]);
});

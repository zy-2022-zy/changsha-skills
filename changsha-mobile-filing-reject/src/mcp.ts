import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadOptionalEnvFile } from './env.js';
import { loadConfig } from './config.js';
import { RejectPortal } from './portal.js';

/**
 * WorkBuddy 使用的 MCP stdio 服务。
 * 标准输出只用于 MCP JSON-RPC 通信；诊断信息写入标准错误。
 */
const PROTOCOL_VERSION = '2025-06-18';

const tools = [
  {
    name: 'login_start',
    description: '启动长沙移动门户分阶段登录：自动填写已配置手机号、勾选隐私协议并获取图形验证码。若需要人工验证，会返回提示和验证码图片；请把图片展示给员工并等待其回复。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'login_verify_captcha',
    description: '提交员工在聊天中提供的图形验证码或其他人工验证答案，并请求短信验证码。调用前必须先向员工展示 login_start 返回的验证码图片并取得答案。',
    inputSchema: {
      type: 'object',
      properties: { answer: { type: 'string', minLength: 1, description: '员工亲自识别并提供的图形验证码/人工验证答案' } },
      required: ['answer'],
      additionalProperties: false,
    },
  },
  {
    name: 'login_submit_sms',
    description: '提交员工从手机收到并亲自提供的短信验证码，完成门户登录。调用前必须先询问员工短信验证码。',
    inputSchema: {
      type: 'object',
      properties: { sms_code: { type: 'string', minLength: 4, maxLength: 8, description: '员工收到的短信验证码' } },
      required: ['sms_code'],
      additionalProperties: false,
    },
  },
] as const;

type JsonRpcId = string | number | null;
type JsonRecord = Record<string, unknown>;

function send(message: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(value: unknown): JsonRecord {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function requiredString(args: JsonRecord, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少有效参数：${key}`);
  return value.trim();
}

let operationRunning = false;

/** 每次工具调用只连接并断开 Playwright 客户端，不关闭云浏览器或浏览器标签页。 */
async function withPortal<T>(action: (portal: RejectPortal, config: ReturnType<typeof loadConfig>) => Promise<T>): Promise<T> {
  if (operationRunning) throw new Error('当前云浏览器正在处理另一个登录步骤，请稍后重试。');
  operationRunning = true;
  let portal: RejectPortal | undefined;
  try {
    const config = loadConfig();
    portal = await RejectPortal.launch(config);
    return await action(portal, config);
  } finally {
    await portal?.close().catch(() => undefined);
    operationRunning = false;
  }
}

async function callTool(name: string, rawArgs: unknown): Promise<JsonRecord> {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as JsonRecord : {};

  if (name === 'login_start') {
    return withPortal(async (portal, config) => {
      const result = await portal.beginLogin();
      const content: JsonRecord[] = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
      if (result.status === 'captcha_required' && result.captchaImagePath) {
        const stateRoot = path.resolve(config.stateDir);
        const imagePath = path.resolve(result.captchaImagePath);
        if (!imagePath.startsWith(stateRoot + path.sep)) {
          throw new Error('验证码图片路径不在技能状态目录内，已拒绝读取。');
        }
        const image = await readFile(imagePath);
        content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/png' });
      }
      return { content };
    });
  }

  if (name === 'login_verify_captcha') {
    const answer = requiredString(args, 'answer');
    return withPortal(async portal => textResult(await portal.requestSmsCode(answer)));
  }

  if (name === 'login_submit_sms') {
    const smsCode = requiredString(args, 'sms_code');
    if (!/^\d{4,8}$/.test(smsCode)) throw new Error('短信验证码格式不正确，请检查位数后重试。');
    return withPortal(async portal => {
      await portal.submitSmsCode(smsCode);
      return textResult({ status: 'authenticated', message: '登录成功，可以继续执行后续业务任务。' });
    });
  }

  throw new Error(`未知工具：${name}`);
}

async function handleRequest(message: unknown): Promise<void> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const request = message as JsonRecord;
  const id = (typeof request.id === 'string' || typeof request.id === 'number') ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';

  // MCP 通知没有 id，不应返回响应。
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) return;

  if (request.jsonrpc !== '2.0' || !method) {
    rpcError(id, -32600, '无效的 JSON-RPC 请求。');
    return;
  }

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'changsha-mobile-filing-reject', version: '1.0.0' },
        },
      });
      return;
    }

    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools } });
      return;
    }

    if (method === 'tools/call') {
      const params = request.params && typeof request.params === 'object'
        ? request.params as JsonRecord : {};
      const name = typeof params.name === 'string' ? params.name : '';
      const result = await callTool(name, params.arguments);
      send({ jsonrpc: '2.0', id, result });
      return;
    }

    rpcError(id, -32601, `不支持的方法：${method}`);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === 'tools/call') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: messageText }], isError: true } });
    } else {
      rpcError(id, -32603, messageText);
    }
  }
}

async function main(): Promise<void> {
  await loadOptionalEnvFile();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      rpcError(null, -32700, '无法解析 JSON-RPC 消息。');
      return;
    }
    void handleRequest(message).catch(error => {
      process.stderr.write(`MCP 请求处理失败：${error instanceof Error ? error.message : String(error)}\n`);
    });
  });
  input.on('close', () => process.exit(0));
}

main().catch(error => {
  process.stderr.write(`MCP Server 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

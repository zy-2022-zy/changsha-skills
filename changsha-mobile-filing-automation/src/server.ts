import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadConfig, type AppConfig } from './config.js';
import { FilingService, type SubmitJobRequest } from './service.js';

const MAX_BODY_BYTES = 120 * 1024 * 1024;

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大。');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象。');
  return value as Record<string, unknown>;
}

function isSubmitRequest(value: Record<string, unknown>): value is SubmitJobRequest {
  const filesOk = !('files' in value) || (Array.isArray(value.files) && value.files.every((item) => typeof item === 'string'));
  const uploadsOk = !('uploads' in value) || (Array.isArray(value.uploads) && value.uploads.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const upload = item as Record<string, unknown>;
    return typeof upload.fileName === 'string' && typeof upload.contentBase64 === 'string';
  }));
  const flagsOk = (!('submit' in value) || typeof value.submit === 'boolean') && (!('force' in value) || typeof value.force === 'boolean');
  return filesOk && uploadsOk && (!('directory' in value) || typeof value.directory === 'string') && flagsOk;
}

function authorized(request: IncomingMessage, config: AppConfig): boolean {
  if (!config.serviceToken) return true;
  const header = request.headers.authorization ?? '';
  return header === `Bearer ${config.serviceToken}`;
}

export function createFilingServer(service: FilingService, config: AppConfig = loadConfig()): Server {
  return createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
    if (request.method === 'OPTIONS') {
      send(response, 204, {});
      return;
    }
    if (!authorized(request, config)) {
      send(response, 401, { error: '未授权，请提供正确的 Bearer token。' });
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        send(response, 200, {
          ok: true,
          service: 'changsha-mobile-filing-automation',
          message: '长沙移动报备自动化服务正在运行。',
          portalReady: service.isPortalReady(),
          endpoints: {
            health: 'GET /health',
            submit: 'POST /v1/jobs',
            list: 'GET /v1/jobs',
            detail: 'GET /v1/jobs/:jobId',
            retry: 'POST /v1/jobs/:jobId/retry',
          },
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, { ok: true, portalReady: service.isPortalReady(), jobs: service.listJobs().length });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/jobs') {
        send(response, 200, { jobs: service.listJobs() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/jobs') {
        const body = await readJson(request);
        if (!isSubmitRequest(body)) throw new Error('请求格式无效。');
        const job = await service.submit(body);
        send(response, 202, job);
        return;
      }
      if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'jobs' && request.method === 'GET') {
        const job = service.getJob(parts[2]);
        if (!job) {
          send(response, 404, { error: '任务不存在。' });
          return;
        }
        send(response, 200, job);
        return;
      }
      if (parts.length === 4 && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'retry' && request.method === 'POST') {
        const body = await readJson(request);
        const job = await service.retry(parts[2], body.force === true);
        send(response, 202, job);
        return;
      }
      send(response, 404, { error: '接口不存在。' });
    } catch (error: unknown) {
      send(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function startFilingServer(config: AppConfig = loadConfig()): Promise<Server> {
  const service = new FilingService(config);
  await service.initialize();
  const server = createFilingServer(service, config);
  server.on('close', () => void service.close());
  await new Promise<void>((resolve) => server.listen(config.servicePort, config.serviceHost, resolve));
  console.log(`智能体服务已启动：http://${config.serviceHost}:${config.servicePort}`);
  console.log('POST /v1/jobs 提交任务，GET /v1/jobs/:jobId 查询任务，GET /health 检查服务。');
  return server;
}

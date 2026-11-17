import { randomUUID } from 'node:crypto';
import { recoverArchives } from './recovery.js';
import { flushNotifications } from './notification-outbox.js';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type AppConfig } from './config.js';
import { MobilePortal } from './portal.js';
import { collectBatchFiles, prepareBatchFiles, runBatch, type PreparedBatchItem } from './batch.js';
import { waitForManualLogin } from './runner.js';
import type { BatchState } from './batch-state.js';
import { MAX_SOURCE_WORKBOOK_BYTES } from './splitter.js';
import { ensureFilingDirectories } from './directories.js';
import { trySendRemoteLog } from './remote-log.js';

export type ServiceJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED';

export type ServiceUpload = { fileName: string; contentBase64: string };

export type SubmitJobRequest = {
  files?: string[];
  directory?: string;
  uploads?: ServiceUpload[];
  submit?: boolean;
  force?: boolean;
};

export type ServiceJob = {
  jobId: string;
  status: ServiceJobStatus;
  request: Omit<SubmitJobRequest, 'uploads'> & { uploadNames?: string[] };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  total?: number;
  completed?: number;
  failed?: number;
  skipped?: number;
  batchId?: string;
  batchState?: BatchState;
  error?: string;
};

const MAX_FILES_PER_JOB = 200;

function jobDirectory(stateDir: string): string {
  return path.join(stateDir, 'service-jobs');
}

function jobPath(stateDir: string, jobId: string): string {
  return path.join(jobDirectory(stateDir), `${jobId}.json`);
}

function safeUploadName(fileName: string): string {
  const normalized = path.basename(fileName);
  if (normalized !== fileName || !normalized.toLowerCase().endsWith('.xlsx')) {
    throw new Error(`上传文件名不安全或不是 .xlsx：${fileName}`);
  }
  return normalized;
}

async function writeJob(config: AppConfig, job: ServiceJob): Promise<void> {
  await mkdir(jobDirectory(config.stateDir), { recursive: true });
  const destination = jobPath(config.stateDir, job.jobId);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

export class FilingService {
  private readonly jobs = new Map<string, ServiceJob>();
  private readonly queue: string[] = [];
  private active = false;
  private portal?: MobilePortal;

  constructor(private readonly config: AppConfig = loadConfig()) {}

  async initialize(): Promise<void> {
    await ensureFilingDirectories(this.config);
    await mkdir(jobDirectory(this.config.stateDir), { recursive: true });
    const entries = await readdir(jobDirectory(this.config.stateDir), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const job = JSON.parse(await readFile(path.join(jobDirectory(this.config.stateDir), entry.name), 'utf8')) as ServiceJob;
        if (job.status === 'RUNNING' || job.status === 'QUEUED') {
          job.status = 'FAILED';
          job.error = '服务进程在任务完成前退出，请重新提交或调用 retry。';
          job.completedAt = new Date().toISOString();
          await writeJob(this.config, job);
        }
        this.jobs.set(job.jobId, job);
      } catch {
        // Ignore an incomplete/corrupt historical job file; it must not prevent service startup.
      }
    }
  }

  async close(): Promise<void> {
    await this.portal?.close();
    this.portal = undefined;
  }

  isPortalReady(): boolean {
    return Boolean(this.portal);
  }

  listJobs(): ServiceJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getJob(jobId: string): ServiceJob | undefined {
    return this.jobs.get(jobId);
  }

  async submit(request: SubmitJobRequest): Promise<ServiceJob> {
    const files = request.files ?? [];
    const uploads = request.uploads ?? [];
    const directory = request.directory ?? (files.length === 0 && uploads.length === 0 ? this.config.pendingDir : undefined);
    if (files.length + uploads.length > MAX_FILES_PER_JOB) throw new Error(`单个任务最多支持 ${MAX_FILES_PER_JOB} 个文件。`);
    const jobId = randomUUID();
    const storedUploads = await this.materializeUploads(jobId, uploads);
    const job: ServiceJob = {
      jobId,
      status: 'QUEUED',
      request: { files: [...files, ...storedUploads], directory, submit: request.submit === true, force: request.force === true, uploadNames: uploads.map((item) => item.fileName) },
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, job);
    await writeJob(this.config, job);
    this.queue.push(jobId);
    void this.pump();
    return job;
  }

  async retry(jobId: string, force = false): Promise<ServiceJob> {
    const old = this.jobs.get(jobId);
    if (!old) throw new Error(`任务不存在：${jobId}`);
    if (old.status === 'QUEUED' || old.status === 'RUNNING') throw new Error('任务正在执行，不能重复排队。');
    return this.submit({ ...old.request, force: force || old.request.force });
  }

  private async ensurePortal(): Promise<MobilePortal> {
    if (!this.portal) {
      this.portal = await MobilePortal.launch(this.config);
      await waitForManualLogin(this.portal);
    }
    return this.portal;
  }

  private async materializeUploads(jobId: string, uploads: ServiceUpload[]): Promise<string[]> {
    if (uploads.length === 0) return [];
    const directory = path.join(this.config.stateDir, 'service-input', jobId);
    await mkdir(directory, { recursive: true });
    const paths: string[] = [];
    for (const upload of uploads) {
      const fileName = safeUploadName(upload.fileName);
      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(upload.contentBase64)) throw new Error(`文件 ${fileName} 的 Base64 内容无效。`);
      const content = Buffer.from(upload.contentBase64, 'base64');
      if (content.length === 0 || content.length > MAX_SOURCE_WORKBOOK_BYTES) {
        throw new Error(`源文件 ${fileName} 超过 ${MAX_SOURCE_WORKBOOK_BYTES} 字节安全限制。`);
      }
      const filePath = path.join(directory, fileName);
      await writeFile(filePath, content);
      paths.push(filePath);
    }
    return paths;
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift()!;
        const job = this.jobs.get(jobId);
        if (job) await this.execute(job);
      }
    } finally {
      this.active = false;
    }
  }

  private async execute(job: ServiceJob): Promise<void> {
    job.status = 'RUNNING';
    job.startedAt = new Date().toISOString();
    await writeJob(this.config, job);
    try {
      await recoverArchives(this.config.stateDir);
      await flushNotifications(this.config.stateDir, this.config.wechatWorkWebhookUrl);
      const paths = await collectBatchFiles({ dir: job.request.directory, files: job.request.files });
      if (paths.length === 0) throw new Error('任务中没有找到可处理的 .xlsx 文件。');
      const items: PreparedBatchItem[] = await prepareBatchFiles(paths, {}, path.join(this.config.filingRootDir, '错误信息文档'));
      job.total = items.length;
      await writeJob(this.config, job);
      let batch: BatchState;
      if (job.request.submit && items.some(item => !item.error)) {
        const portal = await this.ensurePortal();
        batch = await runBatch({ config: this.config, portal, items, submit: true, force: job.request.force === true });
      } else {
        batch = await runBatch({ config: this.config, items, submit: false, force: job.request.force === true });
      }
      job.batchId = batch.batchId;
      job.batchState = batch;
      job.completed = batch.completed;
      job.failed = batch.failed;
      job.skipped = batch.skipped;
      job.status = batch.status === 'COMPLETED' || batch.status === 'PRECHECKED' ? 'COMPLETED' : 'COMPLETED_WITH_ERRORS';
      job.completedAt = new Date().toISOString();
      await trySendRemoteLog(this.config, {
        event: 'job.completed',
        jobId: job.jobId,
        batchId: job.batchId,
        status: job.status,
        total: job.total,
        succeeded: job.completed,
        failed: job.failed,
        skipped: job.skipped,
      });
    } catch (error: unknown) {
      job.status = 'FAILED';
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = new Date().toISOString();
      await trySendRemoteLog(this.config, {
        event: 'job.failed',
        jobId: job.jobId,
        status: job.status,
        error: job.error,
      });
    }
    await writeJob(this.config, job);
  }
}

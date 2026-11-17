import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
export async function acquireRunLock(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'filing.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => { if (await readFile(file, 'utf8').catch(() => '') === String(process.pid)) await unlink(file); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(await readFile(file, 'utf8'));
      if (!Number.isInteger(owner) || owner <= 0) throw new Error('运行锁信息不完整，请检查已有程序。');
      try { process.kill(owner, 0); } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(file).catch(() => undefined); continue; }
        throw probe;
      }
      throw new Error(`已有报备程序运行中（进程 ${owner}），请勿重复启动。`);
    }
  }
  throw new Error('无法取得报备运行锁。');
}

import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './config.js';

export async function ensureFilingDirectories(config: AppConfig): Promise<void> {
  await Promise.all([
    mkdir(config.filingRootDir, { recursive: true }),
    mkdir(config.pendingDir, { recursive: true }),
    mkdir(config.completedDir, { recursive: true }),
    mkdir(config.reportResultDir, { recursive: true }),
  ]);
}

async function nextAvailablePath(directory: string, fileName: string): Promise<string> {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let candidate = path.join(directory, fileName);
  for (let index = 1; index < 10_000; index += 1) {
    try {
      await import('node:fs/promises').then(({ access }) => access(candidate));
      candidate = path.join(directory, `${stem}-${index}${extension}`);
    } catch {
      return candidate;
    }
  }
  throw new Error(`目录 ${directory} 中找不到可用的归档文件名：${fileName}`);
}

export async function moveArtifact(sourcePath: string | undefined, targetDir: string, preferredName?: string): Promise<string | undefined> {
  if (!sourcePath) return undefined;
  await mkdir(targetDir, { recursive: true });
  const sourceAbsolute = path.resolve(sourcePath);
  if (path.dirname(sourceAbsolute).toLowerCase() === path.resolve(targetDir).toLowerCase()) return sourceAbsolute;
  const targetAbsolute = await nextAvailablePath(targetDir, preferredName ?? path.basename(sourceAbsolute));
  if (sourceAbsolute === targetAbsolute) return targetAbsolute;
  try {
    await rename(sourceAbsolute, targetAbsolute);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(sourceAbsolute, targetAbsolute);
    await unlink(sourceAbsolute);
  }
  return targetAbsolute;
}

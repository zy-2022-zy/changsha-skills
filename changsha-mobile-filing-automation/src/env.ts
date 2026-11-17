import { readFile } from 'node:fs/promises';

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) result[match[1]] = unquote(match[2]);
  }
  return result;
}

export async function loadOptionalEnvFile(fileName = '.env'): Promise<void> {
  try {
    const values = parseEnv(await readFile(fileName, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      process.env[key] ??= value;
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

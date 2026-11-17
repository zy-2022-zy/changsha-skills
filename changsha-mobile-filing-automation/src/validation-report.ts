import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';

export class ValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Excel 数据校验失败（共 ${issues.length} 个问题）：${issues.slice(0, 10).join('；')}${issues.length > 10 ? '；其余问题见错误信息文档' : ''}`);
  }
}
const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function columnName(index: number): string {
  let value = '';
  for (; index > 0; index = Math.floor((index - 1) / 26)) value = String.fromCharCode(65 + (index - 1) % 26) + value;
  return value;
}
function columnIndex(name: string): number { return [...name].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); }

/** 直接修改副本中的工作表 XML，其余资源、图片及关系保持原样。 */
export async function writeValidationReport(source: string, error: unknown, directory: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(source));
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  const sheets = workbook?.match(/<sheet\b[^>]*>/g) ?? [];
  const sheet = sheets.find(tag => tag.includes('真实发送端口报送模板')) ?? sheets[0];
  const id = sheet?.match(/r:id="([^"]+)"/)?.[1];
  const rel = rels?.match(/<Relationship\b[^>]*>/g)?.find(tag => tag.includes(`Id="${id}"`));
  const target = rel?.match(/Target="([^"]+)"/)?.[1];
  if (!target) throw new Error('无法定位主表，不能生成错误信息副本。');
  const part = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`);
  let xml = await zip.file(part)?.async('string');
  if (!xml) throw new Error('主表 XML 缺失。');
  const maxColumn = Math.max(41, ...[...xml.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)].map(m => columnIndex(m[1])));
  const column = columnName(maxColumn + 1);
  const issues = error instanceof ValidationError ? error.issues : [error instanceof Error ? error.message : String(error)];
  const byRow = new Map<number, string[]>();
  for (const issue of issues) {
    const row = Number(issue.match(/^第 (\d+) 行/)?.[1] ?? 3);
    byRow.set(row, [...(byRow.get(row) ?? []), issue]);
  }
  byRow.set(2, ['错误信息']);
  xml = xml.replace(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/, (_all, content: string) => {
    const rows = new Map<number, string>();
    for (const match of content.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>|<row\b[^>]*\/>/g)) {
      const row = Number(match[0].match(/\br="(\d+)"/)?.[1]);
      if (row) rows.set(row, match[0]);
    }
    for (const [row, messages] of byRow) {
      const cell = `<c r="${column}${row}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(messages.join('；'))}</t></is></c>`;
      const existing = rows.get(row) ?? `<row r="${row}"></row>`;
      rows.set(row, existing.endsWith('/>') ? existing.replace(/\/>$/, `>${cell}</row>`) : existing.replace('</row>', `${cell}</row>`));
    }
    return `<sheetData>${[...rows].sort((a,b)=>a[0]-b[0]).map(entry=>entry[1]).join('')}</sheetData>`;
  });
  const lastRow = Math.max(3, ...[...xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)].map(m=>Number(m[1])));
  xml = xml.replace(/<dimension\b[^>]*\/>/, `<dimension ref="A1:${column}${lastRow}"/>`);
  zip.file(part, xml);
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, `${path.parse(source).name}-错误信息-${Date.now()}-${randomUUID().slice(0,8)}.xlsx`);
  await writeFile(output, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), { flag: 'wx' });
  return output;
}

export async function describeValidationFailure(source: string, error: unknown, directory?: string): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  if (!directory) return message;
  try {
    const output = await writeValidationReport(source, error, directory);
    console.error(`校验失败，错误信息文档：${output}`);
    return `${message}；错误信息文档：${output}`;
  } catch (reportError) {
    return `${message}；错误信息副本生成失败：${reportError instanceof Error ? reportError.message : String(reportError)}`;
  }
}

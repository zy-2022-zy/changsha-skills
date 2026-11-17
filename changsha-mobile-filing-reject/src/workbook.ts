import { readFile } from 'node:fs/promises';
import { rename, writeFile } from 'node:fs/promises';
import XLSX from 'xlsx';

export type WorkbookSummary = { actualRows: number; sheet: string; headerRow: number };
export type BusinessSheet = { sheet: string; headerRow: number; header: string[]; rows: unknown[][] };
// 门户“驳回端口查询”导出的实际表头，以及文档所示“真实端口数据管理”导出的表头。
export const knownHeaders = new Set([
  '端口', '端口类型', '驳回类型', '驳回原因', '驳回描述', '端口提交人', '驳回时间',
  '主端口号', '子端口号', '真实端口', '真实端口号', '企业名称', '企业签名', '状态',
]);

/**
 * 校验字节流是否是完整的 XLSX（ZIP）容器。
 * 门户偶发返回被截断的响应体：开头有 PK 标识，但结尾缺少完整的中央目录记录，
 * 这样的文件能落盘却无法解析。
 */
export function isCompleteXlsx(bytes: Buffer): boolean {
  if (bytes.subarray(0, 2).toString() !== 'PK') return false;
  return zipEndOffset(bytes) >= 0;
}

/**
 * 定位自洽的 ZIP 结束位置。
 * 门户下载的分片偶发在有效 ZIP 之后追加一段多余字节，导致最后一个 EOCD 记录
 * 指向文件尾部的垃圾数据，解析器按最后一个 EOCD 读取就会失败。
 * 这里从前往后找第一个中央目录偏移能对上的 EOCD，返回该 ZIP 的真实结束位置。
 */
export function zipEndOffset(bytes: Buffer): number {
  for (let i = 0; i + 22 <= bytes.length; i++) {
    if (bytes[i] !== 0x50 || bytes[i + 1] !== 0x4b || bytes.readUInt16LE(i + 2) !== 0x0605) continue;
    const entries = bytes.readUInt16LE(i + 10);
    const directorySize = bytes.readUInt32LE(i + 12);
    const directoryOffset = bytes.readUInt32LE(i + 16);
    const commentLength = bytes.readUInt16LE(i + 20);
    if (entries === 0 || directoryOffset + directorySize > bytes.length) continue;
    // 中央目录起始处必须是中央目录文件头签名。
    if (bytes.readUInt32LE(directoryOffset) !== 0x02014b50) continue;
    return i + 22 + commentLength;
  }
  return -1;
}

/**
 * 修复合并了多余尾部字节的 XLSX：按第一个自洽的 ZIP 结束位置截断。
 * 数据本身完好，只是尾部带了垃圾；截断后即可正常解析，行数不丢失。
 */
export function repairXlsx(bytes: Buffer): Buffer {
  const end = zipEndOffset(bytes);
  if (end < 0) return bytes;
  return end === bytes.length ? bytes : bytes.subarray(0, end);
}

/**
 * 读取业务数据表：定位表头行，返回表头文本和其后的非空数据行。
 * 表头不一定在第一行，前 30 行中至少出现两个已知业务字段才算业务表。
 */
export async function readBusinessSheet(file: string, headerRow?: number): Promise<BusinessSheet> {
  const bytes = await readFile(file);
  if (bytes.subarray(0, 2).toString() !== 'PK') throw new Error('下载内容不是 XLSX，可能是登录页或错误响应。');
  // 门户下载的文件尾部可能带多余字节，按 ZIP 结构截断后即可解析。
  const book = XLSX.read(repairXlsx(bytes), { type: 'buffer' });
  const candidates: WorkbookSummary[] = [];
  const sheets: BusinessSheet[] = [];
  for (const name of book.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, defval: '', blankrows: true, range: 0 });
    const index = headerRow === undefined
      ? rows.slice(0, 30).findIndex(row => new Set(row.map(v => String(v).trim()).filter(v => knownHeaders.has(v))).size >= 2)
      : headerRow - 1;
    if (index < 0 || !rows[index]?.some(v => String(v).trim())) continue;
    sheets.push({
      sheet: name,
      headerRow: index + 1,
      header: rows[index].map(v => String(v).trim()),
      // 只统计有内容的行，不沿用原上传模板的第 7 行起始规则，也不按端口去重。
      rows: rows.slice(index + 1).filter(row => row.some(v => String(v).trim() !== '')),
    });
  }
  for (const sheet of sheets) candidates.push({ actualRows: sheet.rows.length, sheet: sheet.sheet, headerRow: sheet.headerRow });
  if (candidates.length !== 1) throw new Error(`无法唯一识别业务数据表（找到 ${candidates.length} 张）。请检查文件；单表未知表头可使用 --header-row 指定表头行。`);
  return sheets[0];
}

export async function inspectWorkbook(file: string, headerRow?: number): Promise<WorkbookSummary> {
  const sheet = await readBusinessSheet(file, headerRow);
  return { actualRows: sheet.rows.length, sheet: sheet.sheet, headerRow: sheet.headerRow };
}

/** 门户按分片导出多个 xlsx，合并成一份并保留表头。 */
export async function mergeWorkbooks(files: string[], target: string): Promise<string> {
  const rows: unknown[][] = [];
  let sheetName: string | undefined;
  let header: string | undefined;
  for (const file of files) {
    // 分片尾部可能带多余字节，按 ZIP 结构截断后合并，避免整批数据作废。
    const book = XLSX.read(repairXlsx(await readFile(file)), { type: 'buffer' });
    const name = book.SheetNames[0];
    if (!name) throw new Error(`分片 ${file} 没有工作表。`);
    sheetName ??= name;
    const sheetRows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, defval: '', blankrows: true, range: 0 });
    for (const row of sheetRows) {
      if (!row.some(v => String(v).trim() !== '')) continue;
      const line = row.map(v => String(v).trim());
      // 每个分片都带自己的表头，合并时只保留第一份。
      if (!header) { header = line.join('\u0001'); rows.push(row); continue; }
      if (line.join('\u0001') === header) continue;
      rows.push(row);
    }
  }
  if (!sheetName || rows.length === 0) throw new Error('分片合并后没有数据。');
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const temporary = `${target}.part`;
  await writeFile(temporary, buffer);
  await rename(temporary, target);
  return target;
}

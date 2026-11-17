import { mkdir, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { knownHeaders } from './workbook.js';

/** SEDP 上传模板的固定表头，签名列按要求留空。 */
export const SEDP_HEADER = ['子端口', '签名', '报备结果', '备注'] as const;
/** 备注列按要求统一写“集团驳回”，不沿用门户的驳回原因原文。 */
export const SEDP_REMARK = '集团驳回';

export type SedpResult = {
  outputPath: string;
  total: number;
  failed: number;
  byPortType: Record<string, number>;
};

const asText = (value: unknown): string => value === null || value === undefined ? '' : String(value).trim();

/** 读取下载文件中的业务表：定位表头行，返回表头文本和其后的非空数据行。 */
function loadBusinessRows(filePath: string, headerRow?: number): { header: string[]; rows: unknown[][] } {
  const bytes = readFileSync(filePath);
  if (bytes.subarray(0, 2).toString() !== 'PK') throw new Error('下载内容不是 XLSX，可能是登录页或错误响应。');
  const book = XLSX.read(bytes, { type: 'buffer' });
  const candidates: Array<{ header: string[]; rows: unknown[][] }> = [];
  for (const name of book.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, defval: '', blankrows: true, range: 0 });
    const index = headerRow === undefined
      ? rows.slice(0, 30).findIndex(row => new Set(row.map(v => asText(v)).filter(v => knownHeaders.has(v))).size >= 2)
      : headerRow - 1;
    if (index < 0 || !rows[index]?.some(v => asText(v) !== '')) continue;
    candidates.push({
      header: rows[index].map(v => asText(v)),
      rows: rows.slice(index + 1).filter(row => row.some(v => asText(v) !== '')),
    });
  }
  if (candidates.length !== 1) throw new Error(`无法唯一识别业务数据表（找到 ${candidates.length} 张）。请检查文件；单表未知表头可使用 --header-row 指定表头行。`);
  return candidates[0];
}

/**
 * 把门户导出的“驳回端口”结果转换成 SEDP 上传格式。
 * 集团驳回记录代表再次上传报备必然失败，因此报备结果固定为“失败”，
 * 备注按要求统一写“集团驳回”；签名列按要求留空。
 * 门户导出的“端口”既有真实端口也有局数据端口，SEDP 的“子端口”列两者都要，
 * 因此逐行原样带出，不按端口类型筛选。
 */
export function buildSedpRows(sourcePath: string, headerRow?: number): {
  header: string[]; rows: unknown[][]; byPortType: Record<string, number>;
} {
  const { header, rows } = loadBusinessRows(sourcePath, headerRow);
  const portIndex = header.indexOf('端口');
  const typeIndex = header.indexOf('驳回类型');
  const portTypeIndex = header.indexOf('端口类型');
  if (portIndex < 0) throw new Error('下载文件缺少“端口”列。');
  if (typeIndex >= 0) {
    const types = new Set(rows.map(row => asText(row[typeIndex])));
    if (types.size > 1) throw new Error(`下载文件包含多种驳回类型（${[...types].join('、')}），只处理集团驳回。`);
    if (types.size === 1 && !types.has('集团驳回')) throw new Error(`下载文件的驳回类型是“${[...types][0]}”，不是集团驳回，停止转换。`);
  }
  const byPortType: Record<string, number> = {};
  const records = rows.map(row => {
    const port = asText(row[portIndex]);
    if (!/^\d+$/.test(port)) throw new Error(`端口号不是纯数字：“${port}”，停止转换。`);
    const portType = portTypeIndex >= 0 ? asText(row[portTypeIndex]) : '';
    byPortType[portType] = (byPortType[portType] ?? 0) + 1;
    // 签名留空；报备结果固定为失败；备注统一写“集团驳回”。
    return [port, '', '失败', SEDP_REMARK];
  });
  return { header: [...SEDP_HEADER], rows: records, byPortType };
}

export async function generateSedpWorkbook(sourcePath: string, outputPath: string, headerRow?: number): Promise<SedpResult> {
  const { header, rows: records, byPortType } = buildSedpRows(sourcePath, headerRow);
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([header, ...records]);
  sheet['!cols'] = [{ wch: 23 }, { wch: 18 }, { wch: 16 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp.xlsx`;
  XLSX.writeFile(book, temporary);
  const written = await replaceFile(temporary, outputPath);
  return {
    outputPath: written,
    total: records.length,
    failed: records.filter(row => row[2] === '失败').length,
    byPortType,
  };
}

/**
 * 用临时文件替换目标文件。
 * 目标文件被 Excel/WPS 打开时，Windows 会拒绝 rename（EPERM/EBUSY），
 * 此时改用带时间戳的备用文件名输出，保证新结果可用，原文件留给使用者自行关闭后替换。
 */
async function replaceFile(temporary: string, outputPath: string): Promise<string> {
  try {
    await rename(temporary, outputPath);
    return path.resolve(outputPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const fallback = `${outputPath.replace(/\.xlsx$/, '')}-${stamp}.xlsx`;
  await rename(temporary, fallback);
  console.error(`目标文件被占用，已改写到 ${fallback}。关闭占用程序后可手动替换原文件。`);
  return path.resolve(fallback);
}

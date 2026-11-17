import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const INPUT_SHEET = '真实发送端口报送模板';
const INPUT_DATA_START_ROW = 7; // 模板前 6 行是说明、表头、字段规则和样例
const SOURCE_PORT_COLUMNS = ['真实发送端口号', '5G真实发送端口号'];
const SOURCE_SIGNATURE_COLUMN = '企业签名';

export type SedpGenerationInput = {
  sourcePath: string;
  errorsPath?: string;
  outputPath: string;
  expectedTotal?: number;
  expectedFailed?: number;
};

export type SedpGenerationResult = {
  outputPath: string;
  total: number;
  succeeded: number;
  failed: number;
};

type SourceRecord = { sourceRow: number; port: string; signature: string };
type FailureRecord = { sourceRow?: number; port: string; reason: string };

function asText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function loadRows(filePath: string, sheetName?: string, allowEmptyWorkbook = false): unknown[][] {
  if (!fs.existsSync(filePath)) throw new Error(`找不到 Excel 文件：${filePath}`);
  const workbook = XLSX.readFile(filePath, { cellDates: true, raw: true });
  const sheet = sheetName ? workbook.Sheets[sheetName] : workbook.Sheets[workbook.SheetNames[0]];
  // 门户在没有失败记录时可能返回一个没有工作表的空 .xlsx；它等价于“无失败明细”。
  if (!sheet && allowEmptyWorkbook && !sheetName && workbook.SheetNames.length === 0) return [];
  if (!sheet) throw new Error(`Excel 中找不到工作表：${sheetName}`);
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true }) as unknown[][];
}

function sourceRecords(sourcePath: string): SourceRecord[] {
  const rows = loadRows(sourcePath, INPUT_SHEET);
  const headers = (rows[1] ?? []).map(asText);
  const portIndex = headers.findIndex((header) => SOURCE_PORT_COLUMNS.includes(header));
  const signatureIndex = headers.indexOf(SOURCE_SIGNATURE_COLUMN);
  if (portIndex < 0) throw new Error(`原始模板缺少列：${SOURCE_PORT_COLUMNS.join(' 或 ')}`);
  if (signatureIndex < 0) throw new Error(`原始模板缺少列：${SOURCE_SIGNATURE_COLUMN}`);
  return rows.slice(INPUT_DATA_START_ROW - 1)
    .map((row, offset) => ({
      sourceRow: INPUT_DATA_START_ROW + offset,
      port: asText(row[portIndex]),
      signature: asText(row[signatureIndex]),
    }))
    .filter((record) => record.port.length > 0);
}

function failureRecords(errorsPath?: string): FailureRecord[] {
  if (!errorsPath) return [];
  const rows = loadRows(errorsPath, undefined, true);
  const headers = (rows[0] ?? []).map(asText);
  const portIndex = headers.indexOf('导入端口');
  const rowIndex = headers.indexOf('导入文件行号');
  const reasonIndex = headers.indexOf('失败原因');
  if (portIndex < 0 || reasonIndex < 0) {
    throw new Error('失败结果文件必须包含“导入端口”和“失败原因”列。');
  }
  return rows.slice(1)
    .map((row) => ({
      sourceRow: rowIndex >= 0 && Number.isInteger(Number(row[rowIndex])) ? Number(row[rowIndex]) : undefined,
      port: asText(row[portIndex]),
      reason: asText(row[reasonIndex]),
    }))
    .filter((record) => record.port.length > 0 || record.sourceRow !== undefined);
}

export function buildSedpRows(sourcePath: string, errorsPath?: string): unknown[][] {
  const source = sourceRecords(sourcePath);
  const failures = failureRecords(errorsPath);
  const bySourceRow = new Map(failures.filter((item) => item.sourceRow !== undefined).map((item) => [item.sourceRow!, item]));
  const byPort = new Map(failures.filter((item) => item.port).map((item) => [item.port, item]));
  const failurePorts = new Set<string>();
  const failedRows: unknown[][] = [];

  for (const failure of failures) {
    const sourceRecord = (failure.sourceRow ? source.find((item) => item.sourceRow === failure.sourceRow) : undefined)
      ?? source.find((item) => item.port === failure.port);
    const port = sourceRecord?.port || failure.port;
    if (!port || failurePorts.has(port)) continue;
    failurePorts.add(port);
    failedRows.push([port, sourceRecord?.signature ?? null, '失败', failure.reason || '系统未返回失败原因', null]);
  }

  const succeededRows = source
    .filter((record) => !bySourceRow.has(record.sourceRow) && !byPort.has(record.port))
    .map((record) => [record.port, record.signature, '成功', null, null]);

  return [
    ['子端口', '签名', '报备结果', '备注', null],
    ...failedRows,
    ...succeededRows,
  ];
}

export async function generateSedpWorkbook(input: SedpGenerationInput): Promise<SedpGenerationResult> {
  const rows = buildSedpRows(input.sourcePath, input.errorsPath);
  const dataRows = rows.slice(1);
  const failed = dataRows.filter((row) => row[2] === '失败').length;
  if (input.expectedTotal !== undefined && dataRows.length !== input.expectedTotal) throw new Error('结果记录总数与门户不一致，停止生成和归档。');
  if (input.expectedFailed !== undefined && failed !== input.expectedFailed) throw new Error('失败明细数量与门户不一致，停止生成和归档。');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 23 }, { wch: 18 }, { wch: 16 }, { wch: 70 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  fs.mkdirSync(path.dirname(path.resolve(input.outputPath)), { recursive: true });
  XLSX.writeFile(workbook, input.outputPath);
  return {
    outputPath: path.resolve(input.outputPath),
    total: dataRows.length,
    succeeded: dataRows.length - failed,
    failed,
  };
}

/** 合并已核验的分片结果，不按端口去重，避免丢失不同分片中的业务记录。 */
export async function mergeSedpWorkbooks(parts: Array<{ path: string; total: number; failed: number }>, outputPath: string): Promise<SedpGenerationResult> {
  if (!parts.length) throw new Error('没有可合并的报备结果。');
  const header = ['子端口', '签名', '报备结果', '备注'];
  const data: unknown[][] = [];
  for (const part of parts) {
    if (!part.path || !Number.isInteger(part.total) || !Number.isInteger(part.failed)) throw new Error('分片结果或数量缺失，停止合并。');
    const rows = loadRows(part.path);
    if (header.some((name, index) => rows[0]?.[index] !== name)) throw new Error('分片结果表头不一致，停止合并。');
    const records = rows.slice(1);
    if (records.length !== part.total || records.filter((row) => row[2] === '失败').length !== part.failed
      || records.some((row) => row[2] !== '成功' && row[2] !== '失败')) throw new Error('分片结果数量或状态不一致，停止合并。');
    data.push(...records);
  }
  const failedRows = data.filter((row) => row[2] === '失败');
  const succeededRows = data.filter((row) => row[2] === '成功');
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[...header, null], ...failedRows, ...succeededRows]);
  sheet['!cols'] = [{ wch: 23 }, { wch: 18 }, { wch: 16 }, { wch: 70 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp.xlsx`;
  XLSX.writeFile(workbook, temporary);
  fs.renameSync(temporary, outputPath);
  return { outputPath: path.resolve(outputPath), total: data.length, failed: failedRows.length, succeeded: succeededRows.length };
}

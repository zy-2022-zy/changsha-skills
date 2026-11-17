import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import XLSX from 'xlsx';
import { buildSedpRows, generateSedpWorkbook, mergeSedpWorkbooks } from '../src/sedp.js';

function writeWorkbook(filePath: string, sheetName: string, rows: unknown[][]): void {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  XLSX.writeFile(workbook, filePath);
}

test('merge keeps one header, all records including repeated ports, and failures first', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sedp-merge-'));
  const header = ['子端口', '签名', '报备结果', '备注'];
  const parts = [1, 2, 3].map((index) => ({ path: path.join(directory, `原始-${index}.xlsx`), total: 1, failed: index === 2 ? 1 : 0 }));
  for (const [index, part] of parts.entries()) writeWorkbook(part.path, 'Sheet1', [header, ['1001', `签名${index + 1}`, part.failed ? '失败' : '成功', part.failed ? '原因' : null]]);
  const output = path.join(directory, '原始-报备结果.xlsx');
  const result = await mergeSedpWorkbooks(parts, output);
  assert.equal(result.total, 3);
  assert.equal(result.failed, 1);
  const book = XLSX.readFile(output);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets.Sheet1, { header: 1 });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.slice(1).map((row) => row[2]), ['失败', '成功', '成功']);
  assert.deepEqual(rows.slice(1).map((row) => row[1]), ['签名2', '签名1', '签名3']);
  await assert.rejects(mergeSedpWorkbooks([{ ...parts[0], total: 2 }], output), /数量/);
  await assert.rejects(mergeSedpWorkbooks([{ ...parts[0], path: path.join(directory, 'missing.xlsx') }], output), /找不到/);
  assert.equal(XLSX.utils.sheet_to_json(XLSX.readFile(output).Sheets.Sheet1).length, 3);
});

test('buildSedpRows puts failures first and keeps successes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sedp-'));
  const sourcePath = path.join(directory, 'source.xlsx');
  const errorsPath = path.join(directory, 'errors.xlsx');
  const outputPath = path.join(directory, 'sedp.xlsx');
  writeWorkbook(sourcePath, '真实发送端口报送模板', [
    ['说明'],
    ['序号', '企业签名', '真实发送端口号'],
    ['字段说明'], ['填写要求'], ['数据校验规则'], ['样例数据'],
    ['1', '签名A', '1001'], ['2', '签名B', '1002'], ['3', '签名C', '1003'],
  ]);
  writeWorkbook(errorsPath, '0', [
    ['导入端口', '导入文件行号', '失败原因'],
    ['1002', 8, '经办人重复'],
  ]);

  const rows = buildSedpRows(sourcePath, errorsPath);
  assert.deepEqual(rows.slice(1), [
    ['1002', '签名B', '失败', '经办人重复', null],
    ['1001', '签名A', '成功', null, null],
    ['1003', '签名C', '成功', null, null],
  ]);
  const result = await generateSedpWorkbook({ sourcePath, errorsPath, outputPath });
  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(fs.existsSync(outputPath), true);
  const savedRows = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(outputPath).Sheets.Sheet1, { header: 1, defval: null });
  assert.deepEqual(savedRows.slice(1).map((row) => row[1]), ['签名B', '签名A', '签名C']);
});

test('buildSedpRows accepts the 5G real-port column', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sedp-5g-'));
  const sourcePath = path.join(directory, 'source-5G.xlsx');
  writeWorkbook(sourcePath, '真实发送端口报送模板', [
    ['说明'], ['序号', '企业签名', '5G真实发送端口号'],
    ['字段说明'], ['填写要求'], ['数据校验规则'], ['样例数据'],
    ['1', '签名A', '1001'],
  ]);
  assert.deepEqual(buildSedpRows(sourcePath).slice(1), [['1001', '签名A', '成功', null, null]]);
});

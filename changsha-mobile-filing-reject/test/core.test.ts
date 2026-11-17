import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { beijingToday, dateRange, dateFolder } from '../src/dates.js';
import { inspectWorkbook, isCompleteXlsx, mergeWorkbooks, repairXlsx, zipEndOffset } from '../src/workbook.js';
import { buildSedpRows, generateSedpWorkbook } from '../src/sedp.js';
import { loadConfig } from '../src/config.js';
import { run, type Portal } from '../src/runner.js';
import { parseBatch, taskStatus } from '../src/portal.js';
import { requestContainsBatch, hasExactBatch } from '../src/task-query.js';

test('日期范围使用北京时间，跳过周末，拒绝无效或矛盾日期', () => {
  assert.equal(beijingToday(new Date('2026-10-22T16:30:00Z')), '2026-10-23');
  assert.equal(dateRange({ today: '2026-10-26' }).start, '2026-10-23');
  assert.equal(dateRange({ today: '2026-10-25' }).start, '2026-10-23');
  assert.equal(dateRange({ today: '2026-10-23' }).end, '2026-10-22');
  assert.equal(dateFolder(dateRange({ date: '2026-10-22' })), '2026-10-22');
  assert.equal(dateFolder(dateRange({ start: '2026-10-21', end: '2026-10-22' })), '2026-10-21_至_2026-10-22');
  assert.throws(() => dateRange({ date: '2026-02-29' }));
  assert.throws(() => dateRange({ date: '2026-10-22', end: '2026-10-23' }));
  assert.throws(() => dateRange({ start: '2026-10-23' }));
  assert.throws(() => dateRange({ start: '2026-10-23', end: '2026-10-22' }));
});

test('批次号保留完整字符串，不匹配相邻任务或未完成状态', () => {
  const id = '2110281444303654914';
  assert.equal(parseBatch(`批次号为：${id}`), id);
  assert.equal(hasExactBatch([`${id}0`], id), false);
  assert.equal(requestContainsBatch('https://example.test/query', `{"taskId":"${id}"}`, id), true);
  assert.equal(requestContainsBatch(`https://example.test/query?taskId=${id}0`, null, id), false);
  assert.equal(taskStatus('未完成'), 'pending');
  assert.equal(taskStatus('处理失败'), 'failed');
  assert.equal(taskStatus('处理完成'), 'complete');
});

async function workbook(file: string, sheets: unknown[][][] = [[['导出说明'], ['主端口号', '企业名称'], ['1068', '甲'], [], ['1068', '乙']]]) {
  const book = XLSX.utils.book_new();
  sheets.forEach((rows, i) => XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), `业务${i}`));
  await writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}

test('统计下载文件实际行数，保留重复端口，支持空结果并拒绝歧义与登录 HTML', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reject-book-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'export.xlsx');
  await workbook(file);
  assert.deepEqual(await inspectWorkbook(file), { actualRows: 2, sheet: '业务0', headerRow: 2 });
  await workbook(file, [[['主端口号', '企业名称']]]);
  assert.equal((await inspectWorkbook(file)).actualRows, 0);
  await workbook(file, [[['自定义列'], ['数据']]]);
  await assert.rejects(inspectWorkbook(file), /唯一识别/);
  assert.equal((await inspectWorkbook(file, 1)).actualRows, 1);
  await workbook(file, [[['主端口号', '企业名称']], [['主端口号', '企业名称']]]);
  await assert.rejects(inspectWorkbook(file), /唯一识别/);
  await writeFile(file, '<html>请登录</html>');
  await assert.rejects(inspectWorkbook(file), /不是 XLSX/);
});

test('合并分片文件时只保留一份表头，行数与门户数据总量一致', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reject-merge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const header = ['端口', '端口类型', '驳回类型', '驳回原因'];
  const parts = [
    path.join(dir, 'part1.xlsx'),
    path.join(dir, 'part2.xlsx'),
    path.join(dir, 'part3.xlsx'),
  ];
  await workbook(parts[0], [[[...header], ['1068', '真实端口', '集团驳回', '原因']]]);
  await workbook(parts[1], [[[...header], ['1069', '真实端口', '集团驳回', '原因']]]);
  await workbook(parts[2], [[[...header], ['1070', '真实端口', '集团驳回', '原因']]]);
  const merged = path.join(dir, 'merged.xlsx');
  await mergeWorkbooks(parts, merged);
  const summary = await inspectWorkbook(merged);
  assert.equal(summary.actualRows, 3);
  assert.equal(summary.headerRow, 1);
});

test('SEDP 转换：签名留空、结果固定失败、备注统一写集团驳回，真实端口与局数据端口都带出', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reject-sedp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '集团驳回.xlsx');
  await workbook(file, [[['端口', '端口类型', '驳回类型', '驳回原因'],
    ['106865322344032', '真实端口', '集团驳回', '同步失败，没有具体报错信息'],
    ['073412388', '局数据端口', '集团驳回', '值在excel已存在']]]);
  const { header, rows, byPortType } = buildSedpRows(file);
  assert.deepEqual(header, ['子端口', '签名', '报备结果', '备注']);
  assert.deepEqual(rows, [
    ['106865322344032', '', '失败', '集团驳回'],
    ['073412388', '', '失败', '集团驳回'],
  ]);
  assert.deepEqual(byPortType, { 真实端口: 1, 局数据端口: 1 });
  const output = path.join(dir, 'out.xlsx');
  const result = await generateSedpWorkbook(file, output);
  assert.equal(result.total, 2);
  assert.equal(result.failed, 2);
  const saved = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(output).Sheets.Sheet1, { header: 1, defval: '' });
  assert.deepEqual(saved[0], ['子端口', '签名', '报备结果', '备注']);
  assert.equal(saved[1][1], '');
  // 备注不沿用门户的驳回原因原文。
  assert.equal(saved[1][3], '集团驳回');
});

test('SEDP 转换拒绝非集团驳回与非数字端口', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reject-sedp-bad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '集团驳回.xlsx');
  await workbook(file, [[['端口', '端口类型', '驳回类型', '驳回原因'], ['1068', '真实端口', '省公司驳回', '原因']]]);
  assert.throws(() => buildSedpRows(file), /不是集团驳回/);
  await workbook(file, [[['端口', '端口类型', '驳回类型', '驳回原因'], ['1068A', '真实端口', '集团驳回', '原因']]]);
  assert.throws(() => buildSedpRows(file), /不是纯数字/);
});

test('门户分片尾部多余字节可按 ZIP 结构修复，行数不丢失', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reject-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'shard.xlsx');
  await workbook(file, [[['端口', '端口类型', '驳回类型', '驳回原因'],
    ['1068', '真实端口', '集团驳回', '原因'], ['1069', '真实端口', '集团驳回', '原因']]]);
  const clean = await readFile(file);
  assert.equal(isCompleteXlsx(clean), true);
  assert.equal(zipEndOffset(clean), clean.length);

  // 模拟门户：有效 ZIP 之后追加多余字节，并伪造一个指向尾部的 EOCD 记录。
  const garbage = Buffer.alloc(1019, 0x41);
  const fakeEocd = Buffer.alloc(17);
  fakeEocd.writeUInt32LE(0x06054b50, 0);
  const corrupt = Buffer.concat([clean, garbage, fakeEocd]);
  assert.equal(isCompleteXlsx(corrupt), true, '按第一个自洽 EOCD 判断应视为可修复');
  assert.equal(zipEndOffset(corrupt), clean.length);
  const repaired = repairXlsx(corrupt);
  assert.equal(repaired.length, clean.length);
  assert.deepEqual(repaired, clean);

  // 修复后的文件能正常统计行数。
  const repairedFile = path.join(dir, 'repaired.xlsx');
  await writeFile(repairedFile, repaired);
  assert.equal((await inspectWorkbook(repairedFile)).actualRows, 2);
});

test('分片合并时自动修复尾部多余字节，合并结果行数完整', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reject-merge-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const header = ['端口', '端口类型', '驳回类型', '驳回原因'];
  const parts = [path.join(dir, 'p1.xlsx'), path.join(dir, 'p2.xlsx')];
  await workbook(parts[0], [[[...header], ['1068', '真实端口', '集团驳回', '原因']]]);
  await workbook(parts[1], [[[...header], ['1069', '真实端口', '集团驳回', '原因']]]);
  // 给第二个分片追加多余字节，合并时必须自动修复。
  const clean = await readFile(parts[1]);
  await writeFile(parts[1], Buffer.concat([clean, Buffer.alloc(1024, 0x42)]));
  const merged = path.join(dir, 'merged.xlsx');
  await mergeWorkbooks(parts, merged);
  assert.equal((await inspectWorkbook(merged)).actualRows, 2);
});

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reject-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = loadConfig({ AUTH_DIR: path.join(dir, 'auth'), STATE_DIR: path.join(dir, 'states'), DOWNLOAD_DIR: dir });
  const range = dateRange({ date: '2026-10-22' });
  const file = path.join(dir, 'export.xlsx');
  await workbook(file, [[['端口', '端口类型', '驳回类型', '驳回原因'],
    ['106865322344032', '真实端口', '集团驳回', '同步失败，没有具体报错信息'],
    ['073412388', '局数据端口', '集团驳回', '值在excel已存在']]]);
  const counts = { create: 0, download: 0, prepare: 0, close: 0 };
  const portal: Portal = {
    async login() {}, async prepare() { counts.prepare++; },
    async createExport() { counts.create++; return '2110281444303654914'; },
    async waitAndDownload() { counts.download++; return file; },
    async close() { counts.close++; },
  };
  return { config, range, file, counts, portal };
}

test('完成后复用本地结果，原文件被移走只下载原批次，不重复创建任务', async t => {
  const f = await fixture(t);
  const first = await run(f.config, { range: f.range }, async () => f.portal);
  assert.equal(first.summary?.actualRows, 2);
  assert.equal(first.phase, 'completed');
  assert.ok(Number.isFinite(Date.parse(first.updatedAt)));
  // 下载完成后自动生成 SEDP 上传文件，签名留空、报备结果固定为失败。
  assert.equal(first.sedpTotal, 2);
  assert.equal(first.sedpFailed, 2);
  assert.ok(first.sedpPath?.endsWith('export-SEDP需要上传的文档.xlsx'));
  const sedpRows = XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(first.sedpPath!).Sheets.Sheet1, { header: 1, defval: '' });
  assert.deepEqual(sedpRows[0], ['子端口', '签名', '报备结果', '备注']);
  assert.deepEqual(sedpRows[1], ['106865322344032', '', '失败', '集团驳回']);
  await run(f.config, { range: f.range }, async () => { throw new Error('不应启动浏览器'); });
  assert.equal(f.counts.create, 1);
  await rm(f.file);
  f.portal.waitAndDownload = async id => {
    assert.equal(id, first.batchId); f.counts.download++; await workbook(f.file); return f.file;
  };
  await run(f.config, { resultsOnly: true, batchId: first.batchId }, async () => f.portal);
  assert.equal(f.counts.create, 1);
  assert.equal(f.counts.download, 2);
});

test('提交响应丢失后阻止自动重提，显式绑定核实的批次后可恢复', async t => {
  const f = await fixture(t);
  f.portal.createExport = async () => { f.counts.create++; throw new Error('响应丢失'); };
  await assert.rejects(run(f.config, { range: f.range }, async () => f.portal), /响应丢失/);
  await assert.rejects(run(f.config, { range: f.range }, async () => f.portal), /提交结果不确定/);
  assert.equal(f.counts.create, 1);
  const recovered = await run(f.config, { range: f.range, resultsOnly: true, batchId: '2110281444303654914' }, async () => f.portal);
  assert.equal(recovered.phase, 'completed');
  assert.equal(f.counts.create, 1);
});

test('轮询中断后只续查批次，results 不会新建任务', async t => {
  const f = await fixture(t);
  await assert.rejects(run(f.config, { range: f.range, resultsOnly: true }, async () => f.portal), /尚无导出批次/);
  f.portal.waitAndDownload = async () => { throw new Error('查询超时'); };
  await assert.rejects(run(f.config, { range: f.range }, async () => f.portal), /查询超时/);
  f.portal.waitAndDownload = async () => f.file;
  await run(f.config, { range: f.range }, async () => f.portal);
  assert.equal(f.counts.create, 1);
  assert.equal(f.counts.prepare, 1);
});

test('下载内容异常保留 downloaded 状态，修正计数参数后无需重导', async t => {
  const f = await fixture(t);
  await workbook(f.file, [[['自定义列'], ['数据']]]);
  await assert.rejects(run(f.config, { range: f.range }, async () => f.portal), /唯一识别/);
  const result = await run(f.config, { range: f.range, headerRow: 1, resultsOnly: true }, async () => { throw new Error('不应启动浏览器'); });
  assert.equal(result.summary?.actualRows, 1);
  assert.equal(f.counts.create, 1);
});

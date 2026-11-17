import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import XLSX from 'xlsx';
import { ValidationError, writeValidationReport } from '../src/validation-report.js';

test('error copy annotates exact rows and preserves every other ZIP resource and original', async () => {
  const source = path.resolve('resources/filing-validation-rules.xlsx');
  const original = await readFile(source);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'validation-report-'));
  const errors = new ValidationError(['第 7 行“企业签名”不能为空', '第 7 行“字段”含 < & >', '第 8 行“端口”不正确']);
  const output = await writeValidationReport(source, errors, directory);
  assert.deepEqual(await readFile(source), original);
  const before = await JSZip.loadAsync(original);
  const after = await JSZip.loadAsync(await readFile(output));
  for (const name of Object.keys(before.files)) {
    if (before.files[name].dir || name === 'xl/worksheets/sheet1.xml') continue;
    assert.deepEqual(await after.file(name)!.async('nodebuffer'), await before.file(name)!.async('nodebuffer'), name);
  }
  const book = XLSX.readFile(output);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets['真实发送端口报送模板'], {header:1});
  const column = rows[1].indexOf('错误信息');
  assert.ok(column >= 41);
  assert.equal(rows[6][column], errors.issues.slice(0,2).join('；'));
  assert.equal(rows[7][column], errors.issues[2]);
  assert.notEqual(await writeValidationReport(source, errors, directory), output);
});

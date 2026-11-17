import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import XLSX from 'xlsx';
import { loadConfig } from '../src/config.js';
import { parseEnv } from '../src/env.js';
import { validateUploadFile } from '../src/validation.js';

const rulesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'filing-validation-rules.xlsx');
const rulesWorkbook = XLSX.readFile(rulesPath, { cellDates: true, raw: true });
const ruleRows = XLSX.utils.sheet_to_json(rulesWorkbook.Sheets['真实发送端口报送模板'], {
  header: 1,
  defval: null,
  raw: true,
}) as unknown[][];
const templateRows = ruleRows.slice(0, 6);
const headers = templateRows[1].map((value) => String(value ?? ''));

function validRow(overrides: Record<string, unknown> = {}): unknown[] {
  const values = new Array(headers.length).fill('');
  const base: Record<string, unknown> = {
    序号: '1',
    信息报送单位: '中国移动通信集团湖南有限公司长沙分公司',
    操作类型: '新增',
    局数据端口: '10684226',
    码号使用范围: '全国',
    接入省: '湖南',
    接入地市: '长沙',
    真实发送端口号: '1068422677171524',
    真实发送端口号的单位名称: '长沙示例科技有限公司',
    真实发送端口号的单位法人姓名: '张三',
    真实发送端口号的单位证件类型: '营业执照',
    '真实发送端口号的单位证件号码（统一社会信用代码）': '91430100MA4L000001',
    企业签名: '示例科技',
    APP名称: '示例应用',
    '责任人（含法人）姓名': '张三',
    '责任人（含法人）手机号码': '13800000000',
    '责任人（含法人）证件类型': '居民身份证',
    '责任人（含法人）证件号码': '430102199001011234',
    经办人姓名: '李四',
    经办人手机号码: '13900000000',
    经办人证件名称: '居民身份证',
    经办人证件号码: '430102199101011235',
    授权开始时间: '2025-01-01',
    授权到期时间: '2026-01-01',
    短信端口服务类型: '通知提醒',
    '客户是否需要自行扩展（企业签名一致）': '否',
    是否免企业签名: '否',
    短信端口具体用途: '会员服务通知提醒',
    运营商接入机房位置与设备位置: '湖南网关',
    短信端口企业商接入机房位置与设备位置: '长沙市示例机房',
    ...overrides,
  };
  for (const [field, value] of Object.entries(base)) values[headers.indexOf(field)] = value;
  return values;
}

async function writeTemplate(rows: unknown[][]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mobile-filing-'));
  const file = path.join(directory, 'ports.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([...templateRows, ...rows]), '真实发送端口报送模板');
  XLSX.writeFile(workbook, file);
  return file;
}

async function writeFiveGTemplate(rows: unknown[][]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mobile-filing-5g-'));
  const file = path.join(directory, 'ports-5G.xlsx');
  const fiveGRows = templateRows.map((row) => [...row]);
  const names: Record<string, string> = {
    局数据端口: '5G局数据端口', 真实发送端口号: '5G真实发送端口号',
    真实发送端口号的单位名称: '5G真实发送端口号的单位名称',
    真实发送端口号的单位法人姓名: '5G真实发送端口号的单位法人姓名',
    真实发送端口号的单位证件类型: '5G真实发送端口号的单位证件类型',
    '真实发送端口号的单位证件号码（统一社会信用代码）': '5G真实发送端口号的单位证件号码（统一社会信用代码）',
  };
  fiveGRows[1] = fiveGRows[1].map((value) => names[String(value ?? '')] ?? value);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([...fiveGRows, ...rows]), '真实发送端口报送模板');
  XLSX.writeFile(workbook, file);
  return file;
}

test('loadConfig uses safe defaults', () => {
  const config = loadConfig({});
  assert.equal(config.baseUrl, 'https://wap.hn.10086.cn/ismsports/');
  assert.equal(config.pollIntervalMs, 15_000);
  assert.equal(config.browserChannel, 'chrome');
  assert.equal(config.profileDir, 'D:\\报备\\运行状态\\Chrome自动化会话');
  assert.equal(config.authStatePath, 'D:\\报备\\运行状态\\auth-state.json');
  assert.match(config.reportResultDir, /报备结果资料/);
});

test('loadConfig rejects HTTP portal URLs', () => {
  assert.throws(() => loadConfig({ MOBILE_PORTAL_BASE_URL: 'http://example.com' }), /HTTPS/);
});

test('loadConfig accepts a valid optional login phone and rejects an invalid one', () => {
  assert.equal(loadConfig({ LOGIN_PHONE: '13800138000' }).loginPhone, '13800138000');
  assert.throws(() => loadConfig({ LOGIN_PHONE: '12345' }), /11 位手机号/);
});

test('parseEnv ignores comments and supports quoted values', () => {
  assert.deepEqual(parseEnv('# comment\nDOWNLOAD_DIR="D:\\reports"\nRESULT_POLL_INTERVAL_MS=20000'), {
    DOWNLOAD_DIR: 'D:\\reports',
    RESULT_POLL_INTERVAL_MS: '20000',
  });
});

test('validateUploadFile accepts a fully compliant standard template', async () => {
  const file = await writeTemplate([validRow()]);
  const validated = await validateUploadFile(file);
  assert.equal(validated.fileName, 'ports.xlsx');
  assert.equal(validated.dataRows, 1);
  assert.equal(validated.externalChecks.length, 2);
});

test('validateUploadFile accepts the 5G header aliases and requires nationwide scope', async () => {
  const file = await writeFiveGTemplate([validRow()]);
  assert.equal((await validateUploadFile(file)).dataRows, 1);
  const invalid = await writeFiveGTemplate([validRow({ 码号使用范围: '省内' })]);
  await assert.rejects(() => validateUploadFile(invalid), /应为“全国”/);
  const wronglyNamed = await writeTemplate([validRow()]);
  const renamed = path.join(path.dirname(wronglyNamed), '普通模板-5G.xlsx');
  const { copyFile } = await import('node:fs/promises');
  await copyFile(wronglyNamed, renamed);
  await assert.rejects(() => validateUploadFile(renamed), /5G局数据端口/);
});

test('validateUploadFile does not enforce enterprise signature language or bracket format', async () => {
  const file = await writeTemplate([validRow({ 企业签名: 'Example-Signature' })]);
  const validated = await validateUploadFile(file);
  assert.equal(validated.dataRows, 1);
});

test('validateUploadFile rejects missing required values and malformed phone numbers', async () => {
  const file = await writeTemplate([validRow({
    '真实发送端口号的单位法人姓名': '',
    '责任人（含法人）手机号码': '12345',
  })]);
  await assert.rejects(() => validateUploadFile(file), /单位法人姓名.*不能为空.*手机号码.*11 位/);
});

test('validateUploadFile enforces province-city, date, and port association rules', async () => {
  const file = await writeTemplate([
    validRow({ 接入地市: '广州', 授权开始时间: '2026-01-01', 授权到期时间: '2025-01-01' }),
    validRow({ 序号: '2', 真实发送端口号的单位名称: '另一家单位', 企业签名: '另一签名' }),
  ]);
  await assert.rejects(() => validateUploadFile(file), /不属于接入省.*不能晚于授权到期时间.*关联到其他单位或企业签名/);
});

test('validateUploadFile allows the same owner and agent names for different enterprises', async () => {
  const file = await writeTemplate([
    validRow(),
    validRow({
      序号: '2',
      真实发送端口号: '1068422677171525',
      真实发送端口号的单位名称: '另一家示例企业有限公司',
      '真实发送端口号的单位证件号码（统一社会信用代码）': '91430100MA4L000002',
      企业签名: '另一企业',
    }),
  ]);
  const validated = await validateUploadFile(file);
  assert.equal(validated.dataRows, 2);
});

test('validateUploadFile requires advertisement category and consent type', async () => {
  const file = await writeTemplate([validRow({ 短信端口服务类型: '广告促销' })]);
  await assert.rejects(() => validateUploadFile(file), /广告营销类短信行业类别.*商业性短信接收意愿类型/);
});

test('validateUploadFile accepts advertisement without consent file', async () => {
  const file = await writeTemplate([validRow({
    短信端口服务类型: '广告促销',
    广告营销类短信行业类别: '零售业推销',
    商业性短信接收意愿类型: '承诺书',
    商业性短信接收意愿文件: '',
  })]);
  assert.equal((await validateUploadFile(file)).dataRows, 1);
});

test('validateUploadFile rejects non-xlsx files', async () => {
  await assert.rejects(() => validateUploadFile('report.csv'), /xlsx/);
});

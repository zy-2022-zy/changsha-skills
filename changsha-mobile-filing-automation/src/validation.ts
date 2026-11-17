import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { ValidationError, describeValidationFailure } from './validation-report.js';
import { filingTypeForFile } from './filing-type.js';

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_DATA_ROWS = 5_000;
export const TEMPLATE_SHEET = '真实发送端口报送模板';
export const LOCATION_SHEET = '省份地市名称';
export const DATA_START_ROW = 7;

const RULES_WORKBOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'resources',
  'filing-validation-rules.xlsx',
);

const TEMPLATE_HEADERS = [
  '序号', '信息报送单位', '操作类型', '局数据端口', '码号使用范围', '接入省', '接入地市',
  '真实发送端口号', '真实发送端口号的单位名称', '真实发送端口号的单位法人姓名',
  '真实发送端口号的单位证件类型', '真实发送端口号的单位证件号码（统一社会信用代码）',
  '单位营业执照/组织机构代码证', '企业签名', 'APP名称', '责任人（含法人）姓名',
  '责任人（含法人）手机号码', '责任人（含法人）证件类型', '责任人（含法人）证件号码',
  '责任人（含法人）证件', '经办人姓名', '经办人手机号码', '经办人证件名称',
  '经办人证件号码', '经办人证件', '授权书', '授权开始时间', '授权到期时间',
  '短信端口服务类型', '广告营销类短信行业类别', '客户是否需要自行扩展（企业签名一致）',
  '是否免企业签名', '短信端口具体用途', '运营商接入机房位置与设备位置',
  '短信端口企业商接入机房位置与设备位置', '现场拍摄留存经办人照片', '内容模板实例',
  '合同协议文本', '客户类型', '商业性短信接收意愿类型', '商业性短信接收意愿文件',
] as const;

const FIVE_G_HEADER_NAMES = new Map<string, string>([
  ['局数据端口', '5G局数据端口'],
  ['真实发送端口号', '5G真实发送端口号'],
  ['真实发送端口号的单位名称', '5G真实发送端口号的单位名称'],
  ['真实发送端口号的单位法人姓名', '5G真实发送端口号的单位法人姓名'],
  ['真实发送端口号的单位证件类型', '5G真实发送端口号的单位证件类型'],
  ['真实发送端口号的单位证件号码（统一社会信用代码）', '5G真实发送端口号的单位证件号码（统一社会信用代码）'],
]);

const REQUIRED_FIELDS = new Set<string>([
  '信息报送单位', '操作类型', '局数据端口', '码号使用范围', '接入省', '接入地市',
  '真实发送端口号', '真实发送端口号的单位名称', '真实发送端口号的单位法人姓名',
  '真实发送端口号的单位证件类型', '真实发送端口号的单位证件号码（统一社会信用代码）',
  '企业签名', 'APP名称', '责任人（含法人）姓名', '责任人（含法人）手机号码',
  '责任人（含法人）证件类型', '责任人（含法人）证件号码', '经办人姓名',
  '经办人手机号码', '经办人证件名称', '经办人证件号码', '授权开始时间',
  '授权到期时间', '短信端口服务类型', '客户是否需要自行扩展（企业签名一致）',
  '是否免企业签名', '短信端口具体用途', '运营商接入机房位置与设备位置',
  '短信端口企业商接入机房位置与设备位置',
]);

const OPERATION_TYPES = new Set(['新增', '删除', '变更']);
const SCOPES = new Set(['全国', '省内']);
const ORGANIZATION_DOCUMENT_TYPES = new Set([
  '营业执照', '组织机构代码证', '事业单位法人证书', '社会团体法人登记证书', '军队代码', '个体户（注册号）',
]);
const PERSON_DOCUMENT_TYPES = new Set([
  '居民身份证', '中国人民解放军军人身份证件', '中国人民武装警察身份证件',
]);
const SERVICE_TYPES = new Set(['账号注册', '账号登录', '广告促销', '通知提醒', '公共服务']);
const MARKETING_CATEGORIES = new Set([
  '金融推销（贷款理财和保险推销）', '零售业推销', '电信业务宣传', '网络游戏推广', '教育培训推销',
  '房产中介推销', '股票证券推销', '医疗卫生推', '医疗卫生推销', '猎头招聘推广', '旅游推广', '其他营销类别',
]);
const YES_OR_NO = new Set(['是', '否']);
const CONSENT_TYPES = new Set(['承诺书', '证明材料']);
const CUSTOMER_TYPES = new Set([
  '重保客户', '白名单客户', '公安黑名单单位用户', '行业黑名单高危单位用户', '行业黑名单低危单位用户',
  '行业灰名单高危单位用户', '行业灰名单中危单位用户', '行业灰名单底危单位用户',
  '行业灰名单低危单位用户', '中国移动自用端口',
]);
const CONTENT_TEMPLATE_CODES = new Set(['01', '02', '03', '04', '05']);
const MAX_ISSUES = 100;
const BUREAU_PORT_RULES = [
  // 第 5 行“数据校验规则”为主；与第 3 行字段说明冲突时采用第 5 行的最大长度。
  { prefix: '106575', min: 7, max: 12 }, { prefix: '106576', min: 7, max: 12 },
  { prefix: '106577', min: 7, max: 12 }, { prefix: '106578', min: 7, max: 12 },
  { prefix: '106579', min: 7, max: 12 }, { prefix: '106570', min: 7, max: 12 },
  { prefix: '106571', min: 7, max: 12 }, { prefix: '106572', min: 7, max: 12 },
  { prefix: '106573', min: 7, max: 12 }, { prefix: '106574', min: 7, max: 12 },
  { prefix: '10650', min: 6, max: 12 }, { prefix: '10696', min: 5, max: 12 },
  { prefix: '10698', min: 5, max: 12 }, { prefix: '1063', min: 4, max: 12 },
  { prefix: '10630', min: 8, max: 8 }, { prefix: '10631', min: 8, max: 8 },
  { prefix: '10632', min: 8, max: 8 }, { prefix: '10633', min: 8, max: 8 },
  { prefix: '10634', min: 8, max: 8 }, { prefix: '10639', min: 8, max: 8 },
  { prefix: '10635', min: 12, max: 12 }, { prefix: '10636', min: 12, max: 12 },
  { prefix: '10637', min: 12, max: 12 }, { prefix: '10638', min: 12, max: 12 },
  { prefix: '10695', min: 12, max: 12 }, { prefix: '10697', min: 12, max: 12 },
  { prefix: '1069', min: 8, max: 8 }, { prefix: '1068', min: 8, max: 8 },
  { prefix: '1062', min: 8, max: 8 }, { prefix: '1060', min: 9, max: 9 },
  { prefix: '962110', min: 6, max: 6 }, { prefix: '962222', min: 6, max: 6 },
  { prefix: '950', min: 5, max: 5 }, { prefix: '951', min: 5, max: 5 },
  { prefix: '952', min: 6, max: 6 }, { prefix: '953', min: 5, max: 5 },
  { prefix: '954', min: 5, max: 5 }, { prefix: '955', min: 5, max: 5 },
  { prefix: '956', min: 6, max: 6 }, { prefix: '957', min: 5, max: 5 },
  { prefix: '958', min: 5, max: 6 }, { prefix: '959', min: 5, max: 6 },
  { prefix: '100', min: 5, max: 5 }, { prefix: '11', min: 5, max: 5 },
  { prefix: '12', min: 5, max: 5 }, { prefix: '95', min: 5, max: 5 },
  { prefix: '96', min: 5, max: 5 }, { prefix: '0', min: 6, max: 10 },
] as const;

type ProvinceCityReference = {
  provinces: Set<string>;
  citiesByProvince: Map<string, Set<string>>;
};

type DataRow = { excelRow: number; values: unknown[] };

export type UploadFileValidation = {
  absolutePath: string;
  fileName: string;
  dataRows: number;
  sha256: string;
  /** 这些规则需通过门户或企业主数据核验，Excel 本地预检无法完成验真。 */
  externalChecks: string[];
};

let locationReference: ProvinceCityReference | undefined;

function cellText(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value === null || value === undefined ? '' : String(value).trim();
}

function charCount(value: string): number {
  return Array.from(value).length;
}

function readRows(filePath: string): unknown[][] {
  const workbook = XLSX.readFile(filePath, { cellDates: true, raw: true });
  const sheet = workbook.Sheets[TEMPLATE_SHEET];
  if (!sheet) throw new Error(`Excel 缺少工作表“${TEMPLATE_SHEET}”。`);
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true }) as unknown[][];
}

function loadLocationReference(): ProvinceCityReference {
  if (locationReference) return locationReference;
  const workbook = XLSX.readFile(RULES_WORKBOOK_PATH, { raw: true });
  const sheet = workbook.Sheets[LOCATION_SHEET];
  if (!sheet) throw new Error(`内置校验规则缺少工作表“${LOCATION_SHEET}”。`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true }) as unknown[][];
  const entries = rows.slice(1)
    .map((row) => ({ name: cellText(row[0]), code: Number(row[1]) }))
    .filter((entry) => entry.name && Number.isInteger(entry.code) && entry.code > 0);
  const provinceByCode = new Map<number, string>();
  for (const entry of entries) {
    if (entry.code % 10_000 === 0) provinceByCode.set(entry.code, entry.name);
  }
  const provinces = new Set(provinceByCode.values());
  const citiesByProvince = new Map<string, Set<string>>();
  for (const entry of entries) {
    const province = provinceByCode.get(Math.floor(entry.code / 10_000) * 10_000);
    if (!province) continue;
    const cities = citiesByProvince.get(province) ?? new Set<string>();
    cities.add(entry.name);
    citiesByProvince.set(province, cities);
  }
  locationReference = { provinces, citiesByProvince };
  return locationReference;
}

function addIssue(issues: string[], message: string): void {
  issues.push(message);
}

function addFieldIssue(issues: string[], excelRow: number, field: string, message: string): void {
  addIssue(issues, `第 ${excelRow} 行“${field}”${message}`);
}

function validateTemplateStructure(rows: unknown[][], is5G: boolean): Map<string, number> {
  const headers = (rows[1] ?? []).map(cellText);
  const mismatches = TEMPLATE_HEADERS
    .map((canonical, index) => ({ expected: is5G ? FIVE_G_HEADER_NAMES.get(canonical) ?? canonical : canonical, actual: headers[index], column: XLSX.utils.encode_col(index) }))
    .filter((item) => item.actual !== item.expected);
  if (mismatches.length > 0) {
    const preview = mismatches.slice(0, 5).map((item) => `${item.column}列应为“${item.expected}”`).join('、');
    throw new Error(`Excel 模板字段或字段顺序与标准模板不一致：${preview}${mismatches.length > 5 ? '等' : ''}`);
  }
  const markers = [
    { row: 3, value: '字段说明' }, { row: 4, value: '填写要求' }, { row: 5, value: '数据校验规则' }, { row: 6, value: '样例数据' },
  ];
  const alteredMarkers = markers.filter((marker) => cellText(rows[marker.row - 1]?.[0]) !== marker.value);
  if (alteredMarkers.length > 0) {
    throw new Error(`Excel 前 6 行模板说明已被修改，请使用标准模板并从第 ${DATA_START_ROW} 行开始填写数据。`);
  }
  return new Map(TEMPLATE_HEADERS.map((header, index) => [header, index]));
}

function isEmpty(value: unknown): boolean {
  return cellText(value) === '';
}

function dateText(value: unknown): string | undefined {
  const text = cellText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return text;
}

function isValidBureauPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false;
  const matches = BUREAU_PORT_RULES.filter((rule) => port.startsWith(rule.prefix));
  if (matches.length === 0) return false;
  const mostSpecificLength = Math.max(...matches.map((rule) => rule.prefix.length));
  return matches
    .filter((rule) => rule.prefix.length === mostSpecificLength)
    .some((rule) => port.length >= rule.min && port.length <= rule.max);
}

function expectedScope(port: string): '全国' | '省内' | undefined {
  if (['106570', '106573', '1063', '96'].some((prefix) => port.startsWith(prefix))) return '省内';
  if (['11', '12', '95', '100', '1068', '1069', '10650', '106571', '106572', '106574', '106575', '106576', '106577', '106578', '106579', '0'].some((prefix) => port.startsWith(prefix))) return '全国';
  return undefined;
}

function validateName(issues: string[], excelRow: number, field: string, value: string): void {
  if (value && !/^[\u3400-\u9FFF·]+$/.test(value)) {
    addFieldIssue(issues, excelRow, field, '应为连续汉字，可包含“·”，且不能包含空格或其他字符');
  }
}

function validatePhone(issues: string[], excelRow: number, field: string, value: string): void {
  if (value && !/^1[3-9]\d{9}$/.test(value)) addFieldIssue(issues, excelRow, field, '必须是以 1 开头的 11 位手机号码');
}

function validatePersonDocumentNumber(issues: string[], excelRow: number, field: string, documentType: string, value: string): void {
  if (!value || documentType !== '居民身份证') return;
  if (!/^(?:\d{15}|\d{17}[\dXx])$/.test(value)) {
    addFieldIssue(issues, excelRow, field, '在证件类型为居民身份证时应为 15 位或 18 位身份证号码');
  }
}

function validateMultiSelect(issues: string[], excelRow: number, field: string, value: string, allowed: Set<string>): void {
  if (!value) return;
  if (value.includes('，')) {
    addFieldIssue(issues, excelRow, field, '选择多个值时必须使用英文逗号分隔');
    return;
  }
  const selections = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (selections.length === 0 || selections.some((item) => !allowed.has(item))) {
    addFieldIssue(issues, excelRow, field, `包含不支持的枚举值：${value}`);
  }
  if (new Set(selections).size !== selections.length) addFieldIssue(issues, excelRow, field, '不能重复选择同一客户类型');
}

function validateContentTemplate(issues: string[], excelRow: number, content: string, serviceType: string, signature: string): void {
  if (!content) return;
  if (CONTENT_TEMPLATE_CODES.has(content)) return;
  if (serviceType === '广告促销') {
    if (!signature || !content.includes(signature)) addFieldIssue(issues, excelRow, '内容模板实例', '自填写广告营销内容必须包含企业签名');
    if (!content.includes('拒收')) addFieldIssue(issues, excelRow, '内容模板实例', '自填写广告营销内容必须包含拒收标识');
  }
}

function validateTemplate(rows: unknown[][], is5G: boolean): { dataRows: number; externalChecks: string[] } {
  const indexes = validateTemplateStructure(rows, is5G);
  const data: DataRow[] = rows.slice(DATA_START_ROW - 1)
    .map((values, offset) => ({ values, excelRow: DATA_START_ROW + offset }))
    .filter((row) => row.values.some((value) => !isEmpty(value)));
  if (data.length === 0) throw new Error(`Excel 从第 ${DATA_START_ROW} 行开始没有可上传的数据。`);
  if (data.length > MAX_DATA_ROWS) throw new Error(`Excel 数据行数为 ${data.length}，超过每个子文件 ${MAX_DATA_ROWS} 条的限制。`);

  const issues: string[] = [];
  const externalChecks = new Set<string>([
    '局数据端口是否已登记、码号使用范围及接入网关一致性需要通过门户或主数据核验',
    '真实发送端口单位及责任人、经办人的真实性需要通过企业和个人验真接口核验',
  ]);
  const associations = new Map<string, { excelRow: number; unit: string; signature: string }>();
  const reference = loadLocationReference();

  for (const { values, excelRow } of data) {
    const value = (field: string) => values[indexes.get(field)!];
    const text = (field: string) => cellText(value(field));
    for (const field of REQUIRED_FIELDS) {
      if (isEmpty(value(field))) addFieldIssue(issues, excelRow, field, '不能为空');
    }

    const operation = text('操作类型');
    const bureauPort = text('局数据端口');
    const scope = text('码号使用范围');
    const province = text('接入省');
    const city = text('接入地市');
    const realPort = text('真实发送端口号');
    const unit = text('真实发送端口号的单位名称');
    const signature = text('企业签名');
    const ownerName = text('责任人（含法人）姓名');
    const ownerPhone = text('责任人（含法人）手机号码');
    const ownerDocumentType = text('责任人（含法人）证件类型');
    const ownerDocumentNumber = text('责任人（含法人）证件号码');
    const agentName = text('经办人姓名');
    const agentPhone = text('经办人手机号码');
    const agentDocumentType = text('经办人证件名称');
    const agentDocumentNumber = text('经办人证件号码');
    const serviceType = text('短信端口服务类型');

    if (operation && !OPERATION_TYPES.has(operation)) addFieldIssue(issues, excelRow, '操作类型', '必须是新增、删除或变更');
    if (operation === '变更') externalChecks.add('变更操作需要通过历史台账核验：信息报送单位、局数据端口、真实发送端口、接入省不可变更');

    if (bureauPort && !isValidBureauPort(bureauPort)) addFieldIssue(issues, excelRow, '局数据端口', '不符合规定的号段前缀或长度组合');
    if (scope && !SCOPES.has(scope)) addFieldIssue(issues, excelRow, '码号使用范围', '必须是全国或省内');
    const requiredScope = is5G ? '全国' : expectedScope(bureauPort);
    if (scope && requiredScope && scope !== requiredScope) addFieldIssue(issues, excelRow, '码号使用范围', `与局数据端口“${bureauPort}”不匹配，应为“${requiredScope}”`);

    if (province && !reference.provinces.has(province)) addFieldIssue(issues, excelRow, '接入省', '不是省份地市名称表中的标准省级名称');
    if (province && city && reference.provinces.has(province) && !reference.citiesByProvince.get(province)?.has(city)) {
      addFieldIssue(issues, excelRow, '接入地市', `“${city}”不属于接入省“${province}”`);
    }

    if (realPort && !/^\d{1,20}$/.test(realPort)) addFieldIssue(issues, excelRow, '真实发送端口号', '必须是 1-20 位连续数字');
    if (typeof value('真实发送端口号') === 'number' && Math.abs(Number(value('真实发送端口号'))) > Number.MAX_SAFE_INTEGER) {
      addFieldIssue(issues, excelRow, '真实发送端口号', '超过 15 位时请在 Excel 中按文本格式填写，避免数字精度丢失');
    }
    if (bureauPort && realPort && !realPort.startsWith(bureauPort)) addFieldIssue(issues, excelRow, '真实发送端口号', '必须与局数据端口一致或以局数据端口作为前缀扩展');
    if (realPort) {
      const previous = associations.get(realPort);
      if (previous) {
        if (previous.unit !== unit || previous.signature !== signature) {
          addFieldIssue(issues, excelRow, '真实发送端口号', `已在第 ${previous.excelRow} 行关联到其他单位或企业签名`);
        } else {
          addFieldIssue(issues, excelRow, '真实发送端口号', `与第 ${previous.excelRow} 行重复`);
        }
      } else {
        associations.set(realPort, { excelRow, unit, signature });
      }
    }

    const organizationDocumentType = text('真实发送端口号的单位证件类型');
    const organizationDocumentNumber = text('真实发送端口号的单位证件号码（统一社会信用代码）');
    if (organizationDocumentType && !ORGANIZATION_DOCUMENT_TYPES.has(organizationDocumentType)) addFieldIssue(issues, excelRow, '真实发送端口号的单位证件类型', '包含不支持的证件类型');
    if (organizationDocumentNumber && !/^[0-9A-Z-]{6,30}$/.test(organizationDocumentNumber.toUpperCase())) {
      addFieldIssue(issues, excelRow, '真实发送端口号的单位证件号码（统一社会信用代码）', '只能包含大写字母、数字或连字符，长度为 6-30 位');
    }

    validateName(issues, excelRow, '责任人（含法人）姓名', ownerName);
    validateName(issues, excelRow, '经办人姓名', agentName);
    validatePhone(issues, excelRow, '责任人（含法人）手机号码', ownerPhone);
    validatePhone(issues, excelRow, '经办人手机号码', agentPhone);
    if (ownerDocumentType && !PERSON_DOCUMENT_TYPES.has(ownerDocumentType)) addFieldIssue(issues, excelRow, '责任人（含法人）证件类型', '包含不支持的证件类型');
    if (agentDocumentType && !PERSON_DOCUMENT_TYPES.has(agentDocumentType)) addFieldIssue(issues, excelRow, '经办人证件名称', '包含不支持的证件类型');
    validatePersonDocumentNumber(issues, excelRow, '责任人（含法人）证件号码', ownerDocumentType, ownerDocumentNumber);
    validatePersonDocumentNumber(issues, excelRow, '经办人证件号码', agentDocumentType, agentDocumentNumber);

    const startDate = dateText(value('授权开始时间'));
    const endDate = dateText(value('授权到期时间'));
    if (text('授权开始时间') && !startDate) addFieldIssue(issues, excelRow, '授权开始时间', '必须使用 yyyy-MM-dd 格式且日期有效');
    if (text('授权到期时间') && !endDate) addFieldIssue(issues, excelRow, '授权到期时间', '必须使用 yyyy-MM-dd 格式且日期有效');
    if (startDate && endDate && startDate > endDate) addFieldIssue(issues, excelRow, '授权开始时间', '不能晚于授权到期时间');

    if (serviceType && !SERVICE_TYPES.has(serviceType)) addFieldIssue(issues, excelRow, '短信端口服务类型', '必须是账号注册、账号登录、广告促销、通知提醒或公共服务，且只能选择一个值');
    const marketingCategory = text('广告营销类短信行业类别');
    if (serviceType === '广告促销' && !marketingCategory) addFieldIssue(issues, excelRow, '广告营销类短信行业类别', '在短信端口服务类型为广告促销时不能为空');
    if (marketingCategory && !MARKETING_CATEGORIES.has(marketingCategory)) addFieldIssue(issues, excelRow, '广告营销类短信行业类别', '包含不支持的营销行业类别，且只能单选');

    for (const field of ['客户是否需要自行扩展（企业签名一致）', '是否免企业签名']) {
      const fieldValue = text(field);
      if (fieldValue && !YES_OR_NO.has(fieldValue)) addFieldIssue(issues, excelRow, field, '必须填写是或否');
    }
    const usage = text('短信端口具体用途');
    const merchantLocation = text('短信端口企业商接入机房位置与设备位置');
    if (usage && charCount(usage) > 100) addFieldIssue(issues, excelRow, '短信端口具体用途', '不能超过 100 个字');
    if (merchantLocation && charCount(merchantLocation) > 100) addFieldIssue(issues, excelRow, '短信端口企业商接入机房位置与设备位置', '不能超过 100 个字');

    const consentType = text('商业性短信接收意愿类型');
    if (serviceType === '广告促销') {
      if (!consentType) addFieldIssue(issues, excelRow, '商业性短信接收意愿类型', '在短信端口服务类型为广告促销时不能为空');
    }
    if (consentType && !CONSENT_TYPES.has(consentType)) addFieldIssue(issues, excelRow, '商业性短信接收意愿类型', '必须是承诺书或证明材料');
    validateMultiSelect(issues, excelRow, '客户类型', text('客户类型'), CUSTOMER_TYPES);
    validateContentTemplate(issues, excelRow, text('内容模板实例'), serviceType, signature);
  }

  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return { dataRows: data.length, externalChecks: [...externalChecks] };
}

export async function validateUploadFile(filePath: string, errorDirectory?: string): Promise<UploadFileValidation> {
  try { return await validateUploadFileInternal(filePath); }
  catch (error) {
    if (!errorDirectory) throw error;
    throw new Error(await describeValidationFailure(filePath, error, errorDirectory));
  }
}

async function validateUploadFileInternal(filePath: string): Promise<UploadFileValidation> {
  const absolutePath = path.resolve(filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  if (extension !== '.xlsx') throw new Error('仅支持 .xlsx Excel 文件，请先转换后再导入。');

  const metadata = await stat(absolutePath);
  if (!metadata.isFile()) throw new Error(`不是普通文件：${absolutePath}`);
  if (metadata.size === 0) throw new Error('Excel 文件为空，已取消导入。');
  if (metadata.size > MAX_UPLOAD_BYTES) throw new Error(`Excel 文件为 ${metadata.size} 字节，超过本地配置的 2 MB 限制。`);

  const result = validateTemplate(readRows(absolutePath), filingTypeForFile(absolutePath) === '5G');
  const digest = createHash('sha256').update(await readFile(absolutePath)).digest('hex');
  return {
    absolutePath,
    fileName: path.basename(absolutePath),
    dataRows: result.dataRows,
    sha256: digest,
    externalChecks: result.externalChecks,
  };
}

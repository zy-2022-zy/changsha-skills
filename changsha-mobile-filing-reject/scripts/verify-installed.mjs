import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const installed = path.resolve(process.argv[2]);
const fixture = path.resolve(process.argv[3]);
const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package-manifest.json'), 'utf8'));
const skillDefinition = fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8');
assert.equal(skillDefinition.match(/^name:\s*(.+)$/m)?.[1].trim(), manifest.productName);
assert.equal(skillDefinition.match(/^display_name:\s*(.+)$/m)?.[1].trim(), manifest.productName);
assert.equal(process.execPath.toLowerCase(), path.join(installed, 'runtime', 'node.exe').toLowerCase());
assert.equal(process.version, manifest.node);
for (const file of manifest.files) {
  const bytes = fs.readFileSync(path.join(installed, file.path));
  assert.equal(bytes.length, file.size, `Installed size: ${file.path}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `Installed hash: ${file.path}`);
}
const requireInstalled = createRequire(path.join(installed, 'package.json'));
const XLSX = requireInstalled('xlsx');
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
  ['端口', '端口类型', '驳回类型', '驳回原因'],
  ['073412388', '局数据端口', '集团驳回', '任意原因'],
  ['10681025700002064387', '真实端口', '集团驳回', '另一个原因'],
  ['10681025700002064387', '真实端口', '集团驳回', '重复记录需保留'],
]), '驳回端口');
fs.mkdirSync(fixture, { recursive: true });
const input = path.join(fixture, '输入 file.xlsx');
const output = path.join(fixture, '输出 SEDP.xlsx');
XLSX.writeFile(book, input);

// Invoke the same launcher WorkBuddy will use, from a different working directory,
// with all globally installed development tools removed from PATH.
const launcher = path.join(installed, 'scripts', 'run.cmd');
const cmd = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
const isolatedEnv = { ...process.env, PATH: path.dirname(cmd), NODE_PATH: '', NODE_OPTIONS: '' };
for (const key of ['LOGIN_PHONE', 'DOWNLOAD_DIR', 'STATE_DIR', 'AUTH_DIR', 'BROWSER_CHANNEL']) delete isolatedEnv[key];
function invoke(args) {
  const commandLine = `""${launcher}" ${args.map(arg => `"${arg}"`).join(' ')}"`;
  return execFileSync(cmd, ['/d', '/s', '/c', commandLine], {
    cwd: os.tmpdir(), env: isolatedEnv, encoding: 'utf8', windowsHide: true,
    windowsVerbatimArguments: true,
  }).trim();
}
const help = invoke(['--help']);
assert.ok(help.includes('SEDP'));
const plan = JSON.parse(invoke(['export', '--date', '2026-11-05']));
assert.equal(plan.mode, 'plan');
assert.equal(plan.range.start, '2026-11-05');
assert.equal(plan.sedp.remark, '集团驳回');
assert.ok(path.isAbsolute(plan.downloadDir));
const converted = JSON.parse(invoke(['sedp', '--file', input, '--output', output]));
assert.equal(converted.total, 3);
assert.equal(converted.failed, 3);
const saved = XLSX.readFile(output);
assert.deepEqual(XLSX.utils.sheet_to_json(saved.Sheets.Sheet1, { header: 1, defval: '' }), [
  ['子端口', '签名', '报备结果', '备注'],
  ['073412388', '', '失败', '集团驳回'],
  ['10681025700002064387', '', '失败', '集团驳回'],
  ['10681025700002064387', '', '失败', '集团驳回'],
]);
const { chromium } = requireInstalled('playwright');
const config = fs.readFileSync(path.join(installed, '.env'), 'utf8');
const channel = config.match(/^BROWSER_CHANNEL=(.+)$/m)?.[1].trim() || 'chrome';
const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<title>Offline package check</title><input placeholder="phone">');
  await page.getByPlaceholder('phone').fill('13800138000');
  assert.equal(await page.getByPlaceholder('phone').inputValue(), '13800138000');
} finally { await browser.close(); }
if (!process.argv.includes('--allow-state')) {
  assert.ok(!fs.existsSync(path.join(installed, '.runtime')), 'Offline verification must not produce a login cache.');
  assert.ok(!fs.existsSync(path.join(installed, 'reports')), 'Offline verification must not create a production batch.');
}
console.log(JSON.stringify({ manifestFiles: manifest.files.length, globalNodeRequired: false,
  launcherFromOtherDirectory: true, records: converted.total, remarks: '集团驳回', offlineBrowser: channel }, null, 2));

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import XLSX from 'xlsx';
import { RejectPortal } from '../src/portal.js';
import { loadConfig } from '../src/config.js';
import { inspectWorkbook } from '../src/workbook.js';
import { dateRange } from '../src/dates.js';

const id = '2110281444303654914';
const other = '2110281444303654915';

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reject-ui-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await rm(dir, { recursive: true, force: true }); });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const config = loadConfig({ DOWNLOAD_DIR: dir, RESULT_POLL_TIMEOUT_MS: '5000', RESULT_POLL_INTERVAL_MS: '10' });
  return { page, portal: new RejectPortal(page, config), dir };
}

async function getFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  return address.port;
}

async function render(page: Page, html: string, rows: unknown[][] = [['端口', '端口类型', '驳回类型', '驳回原因'], ['1068', '真实端口', '集团驳回', '原因'], ['1069', '真实端口', '集团驳回', '原因']]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows));
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/query')) { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); }
    else if (url === '/export.xlsx' || url === '/fixed.xlsx' || url.startsWith('/file-api/exportFile/')) {
      res.setHeader('Content-Type', url.includes('file-api') ? 'text/html' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      if (!url.includes('file-api')) res.setHeader('Content-Disposition', 'attachment; filename="export.xlsx"');
      res.end(bytes);
    } else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  page.once('close', () => { server.close(); server.closeAllConnections(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}/`);
}

test('云浏览器模式复用现有标签页，关闭 Skill 只断开 CDP 连接', async t => {
  const port = await getFreePort();
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
  t.after(async () => { await browser.close(); });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto('about:blank');

  const config = loadConfig({ BROWSER_CDP_URL: `http://127.0.0.1:${port}` });
  const portal = await RejectPortal.launch(config);
  assert.equal(portal.page.url(), 'about:blank');
  await portal.close();

  // 断开 CDP 后，原 Playwright Page 对象可能被标记为已关闭；应重新连接验证远端标签页仍存在。
  // 再次连接确认云浏览器进程和原标签页仍然存在。
  const verifyBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const pages = verifyBrowser.contexts().flatMap(item => item.pages());
    assert.ok(pages.some(item => item.url() === 'about:blank'));
  } finally {
    await verifyBrowser.close();
  }
});

test('分阶段登录：自动填手机号并勾选协议，员工提供计算答案和短信验证码', async t => {
  const { page, dir } = await setup(t);
  const config = loadConfig({ LOGIN_PHONE: '13800138000', AUTH_DIR: dir, LOGIN_TIMEOUT_MS: '5000' });
  await page.route(config.baseUrl, r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<body>
    <label><input id="agree" type="checkbox">我已阅读并同意服务协议</label>
    <div>请完成计算验证：3 + 5 = ?</div>
    <input placeholder="请输入手机号">
    <input placeholder="请输入验证码">
    <button id="request" onclick="this.disabled=true;this.textContent='60秒后重新获取';document.querySelector('#state').textContent='短信已发送'">获取验证码</button>
    <input placeholder="请输入短信验证码">
    <button id="login" onclick="document.body.insertAdjacentHTML('beforeend','<div>端口上报管理</div>')">登录</button>
    <div id="state"></div>
  </body>` }));
  const portal = new RejectPortal(page, config);
  const start = await portal.beginLogin();
  assert.equal(start.status, 'challenge_required');
  assert.equal(start.agreementAccepted, true);
  assert.match(start.challenge ?? '', /3 \+ 5/);
  assert.equal(await page.locator('#agree').isChecked(), true);
  assert.equal(await page.getByPlaceholder('请输入手机号').inputValue(), '13800138000');
  assert.equal(await page.getByPlaceholder('请输入验证码').inputValue(), '');

  const requested = await portal.requestSmsCode('8');
  assert.equal(requested.status, 'sms_code_required');
  assert.equal(await page.getByPlaceholder('请输入验证码').inputValue(), '8');
  assert.equal(await page.locator('#state').innerText(), '短信已发送');

  await portal.submitSmsCode('123456');
  assert.equal(await page.getByText('端口上报管理', { exact: true }).isVisible(), true);
  assert.equal(await page.getByPlaceholder('请输入短信验证码').inputValue(), '123456');
});

test('本地页面验证筛选及导出确认框，驳回时间和导出均生效', async t => {
  const { page, portal } = await setup(t);
  await render(page, `<body>
    <aside class="el-menu"><span>端口上报管理</span><span>驳回端口查询</span></aside>
    <nav>端口上报管理</nav><span>驳回端口查询</span>
    <div class="el-form-item">驳回时间：<div class="el-date-editor--daterange"><input><input></div></div>
    <button>重置</button>
    <button onclick="fetch('/query')">查询</button>
    <button onclick="document.querySelector('#confirm').style.display='block'">批量导出</button>
    <div role="dialog"><div class="el-message-box" id="confirm" style="display:none">确定要导出吗？<button onclick="this.parentElement.style.display='none';document.querySelector('#notice').style.display='block'">确定</button></div></div>
    <div role="dialog" id="notice" style="display:none">批次号为：${id}<button onclick="this.parentElement.style.display='none'">查看详情</button></div>
  </body>`);
  await portal.prepare(dateRange({ date: '2026-10-22' }));
  assert.deepEqual(await page.locator('.el-date-editor--daterange input').evaluateAll(es => es.map(e => (e as HTMLInputElement).value)), ['2026-10-22', '2026-10-22']);
  assert.equal(await portal.createExport(), id);
});

function resultsHtml(taskName = '驳回端口导出', status = '处理完成') {
  return `<span>批量任务查询</span><span>批量导出结果查询</span>
    <div class="el-form-item">批次号：<input></div>
    <button onclick="fetch('/query?taskId='+document.querySelector('input').value)">查询</button>
    <table><thead><tr><th>批次号</th><th>任务名称</th><th>状态</th><th>已导数量</th><th>操作</th></tr></thead><tbody>
    <tr><td>${other}</td><td>驳回端口导出</td><td>处理完成</td><td>999</td><td><a download href="/wrong">下载</a></td></tr>
    <tr><td>${id}</td><td>${taskName}</td><td>${status}</td><td>123</td><td><a download href="/export.xlsx">下载</a></td></tr>
    </tbody></table>`;
}

/** 批次行的“下载”会弹出文件列表弹窗，里面是分片文件。 */
function fileListHtml(files: [string, string][], href = '/export.xlsx') {
  const rows = files.map(([fileId, name]) =>
    `<tr><td>${fileId}</td><td>${name}</td><td>2026-11-05 10:51:48</td><td><a download href="${href}">下载</a></td></tr>`).join('');
  return `<div role="dialog"><table><thead><tr><th>文件标识</th><th>文件</th><th>创建时间</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

test('门户明确返回操作异常时报告业务错误，不误认为提交成功', async t => {
  const { page, portal } = await setup(t);
  await render(page, `<button onclick="document.querySelector('[role=dialog]').style.display='block'">批量导出</button>
    <div role="dialog" style="display:none">确定要批量导出吗？<button onclick="this.parentElement.style.display='none';document.querySelector('.el-message').style.display='block'">确定</button></div>
    <div class="el-message" style="display:none">操作异常,请联系系统管理员</div>`);
  await assert.rejects(portal.createExport(), /门户未完成导出.*操作异常/);
});

test('精确查询非最新批次，下载并按文件统计，不采用门户已导数量', async t => {
  const { page, portal } = await setup(t);
  await render(page, resultsHtml() + fileListHtml([['2118177055795408898', `${id}_11.xlsx`]]));
  const result = await portal.waitAndDownload(id);
  assert.match(result, new RegExp(id));
  assert.equal((await inspectWorkbook(result)).actualRows, 2);
  assert.equal(await page.locator('input').inputValue(), id);
});

test('错误任务名称与处理失败均停止；未完成不误判为完成', async t => {
  const { page, portal } = await setup(t);
  await render(page, resultsHtml('导入失败数据'));
  await assert.rejects(portal.findTask(id), /任务名称不是/);
  await page.locator('tbody tr').nth(1).locator('td').nth(1).evaluate(e => e.textContent = '驳回端口导出');
  await page.locator('tbody tr').nth(1).locator('td').nth(2).evaluate(e => e.textContent = '未完成');
  assert.equal(await portal.findTask(id), undefined);
  await page.locator('tbody tr').nth(1).locator('td').nth(2).evaluate(e => e.textContent = '处理失败');
  await assert.rejects(portal.findTask(id), /导出任务失败/);
});

test('固定操作列按目标数据行下载，不能误取首行操作', async t => {
  const { page, portal } = await setup(t);
  await render(page, resultsHtml().replace(`<a download href="/export.xlsx">下载</a>`, `<a style="display:none">下载</a>`) +
    `<div class="el-table__fixed-right"><table><tbody><tr><td><a download href="/wrong">下载</a></td></tr><tr><td><a download href="/fixed.xlsx">下载</a></td></tr></tbody></table></div>` +
    fileListHtml([['2118177055795408898', `${id}_11.xlsx`]], '/fixed.xlsx'));
  const row = await portal.findTask(id);
  assert.ok(row);
  const file = await portal.download(row, id);
  assert.equal((await inspectWorkbook(file)).actualRows, 2);
});

test('门户无浏览器下载事件且错误标注 Content-Type 时，保存已验证接口的 XLSX 响应', async t => {
  const { page, portal } = await setup(t);
  await render(page, resultsHtml().replace('download href="/export.xlsx"', `href="#" onclick="event.preventDefault();fetch('/file-api/exportFile/downloadFile')"`) +
    fileListHtml([['2118177055795408898', `${id}_11.xlsx`]], '/file-api/exportFile/downloadFileByFileId'));
  const row = await portal.findTask(id);
  assert.ok(row);
  const file = await portal.download(row, id);
  assert.equal((await inspectWorkbook(file)).actualRows, 2);
});

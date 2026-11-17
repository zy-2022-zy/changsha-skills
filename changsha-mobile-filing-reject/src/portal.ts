import { mkdir, readFile, writeFile, rename, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page, type Locator, type Request, type Download, type Response } from 'playwright';
import type { Config } from './config.js';
import type { DateRange } from './dates.js';
import { requestContainsBatch } from './task-query.js';
import { isCompleteXlsx, mergeWorkbooks, repairXlsx } from './workbook.js';

const exact = (label: string) => new RegExp(`^\\s*${label}\\s*$`);
export function parseBatch(text: string): string | undefined {
  return text.match(/批次号(?:为)?\s*[：:]\s*(\d{12,})/)?.[1];
}
export function taskStatus(status: string): 'complete' | 'failed' | 'pending' {
  if (/失败|异常|取消/.test(status)) return 'failed';
  return status.trim() === '处理完成' ? 'complete' : 'pending';
}

/** 中文定位器以操作流程的两张截图为依据；与上传报备程序保持独立。 */
export class RejectPortal {
  constructor(readonly page: Page, private readonly config: Config, private readonly browser?: Browser) {}

  static async launch(config: Config): Promise<RejectPortal> {
    if (config.cdpUrl) {
      const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: config.cdpConnectTimeoutMs });
      try {
        const context = browser.contexts()[0];
        if (!context) throw new Error('云浏览器没有可用的默认浏览器上下文，请检查 Chromium 是否正常启动。');
        const origin = new URL(config.baseUrl).origin;
        const pages = context.pages();
        // 优先复用门户原有标签页，避免新标签页丢失 sessionStorage 登录状态。
        const page = pages.find(candidate => {
          try { return new URL(candidate.url()).origin === origin; } catch { return false; }
        }) ?? pages.find(candidate => candidate.url() === 'about:blank')
          ?? (pages.length === 1 ? pages[0] : undefined)
          ?? await context.newPage();
        return new RejectPortal(page, config, browser);
      } catch (e) {
        await browser.close().catch(() => undefined);
        throw e;
      }
    }

    // 未配置云浏览器地址时，继续兼容原来的本地浏览器运行方式。
    await mkdir(config.authDir, { recursive: true });
    const browser = await chromium.launch({ headless: false, channel: config.browserChannel, args: ['--disable-gpu'] });
    try {
      const authFile = path.join(config.authDir, 'auth.json');
      let storageState: string | undefined;
      try { await access(authFile); storageState = authFile; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const context = await browser.newContext({ storageState, acceptDownloads: true, viewport: { width: 1440, height: 960 } });
      const origin = new URL(config.baseUrl).origin;
      let session: Record<string, string> = {};
      try { session = JSON.parse(await readFile(path.join(config.authDir, 'session.json'), 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await context.addInitScript(({ origin, session }) => {
        if (location.origin === origin) for (const [k, v] of Object.entries(session)) sessionStorage.setItem(k, v);
      }, { origin, session });
      return new RejectPortal(await context.newPage(), config, browser);
    } catch (e) { await browser.close(); throw e; }
  }

  private async saveAuth(): Promise<void> {
    // 云浏览器会在服务器端持久化登录状态，不把 Cookie 或会话信息复制到员工电脑。
    if (this.config.cdpUrl) return;
    if (!await this.page.getByText('端口上报管理', { exact: true }).isVisible().catch(() => false)) return;
    await mkdir(this.config.authDir, { recursive: true });
    const storage = await this.page.context().storageState();
    const session = await this.page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
    for (const [name, content] of [['auth.json', storage], ['session.json', session]] as const) {
      const file = path.join(this.config.authDir, name);
      await writeFile(`${file}.tmp`, JSON.stringify(content), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    }
  }

  /** 自动准备登录页面；遇到人机验证时把题目交给员工，不自动破解验证。 */
  async beginLogin(): Promise<{ status: 'authenticated' | 'challenge_required' | 'sms_code_required'; challenge?: string; agreementAccepted: boolean }> {
    // 已经位于门户登录页时不重新加载，避免清掉验证码倒计时或重复触发短信发送。
    let currentOrigin = '';
    try { currentOrigin = new URL(this.page.url()).origin; } catch { /* about:blank 等页面需要导航到门户。 */ }
    if (currentOrigin !== new URL(this.config.baseUrl).origin) {
      await this.page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded' });
    }
    const menu = this.page.getByText('端口上报管理', { exact: true }).filter({ visible: true }).first();
    const phone = this.page.locator('input[placeholder*="手机号"], input[type="tel"], input[name*="phone" i]')
      .filter({ visible: true }).first();

    // SPA 在 DOMContentLoaded 后才渲染登录表单，等待登录菜单或手机号输入框出现。
    await menu.or(phone).first().waitFor({ state: 'visible', timeout: 30_000 });
    if (await menu.isVisible().catch(() => false)) {
      await this.saveAuth();
      return { status: 'authenticated', agreementAccepted: false };
    }

    if (!this.config.loginPhone) throw new Error('未配置 LOGIN_PHONE，无法自动填写登录手机号。');
    await phone.fill(this.config.loginPhone);
    await phone.press('Tab');
    if (await phone.inputValue() !== this.config.loginPhone) throw new Error('手机号填写后校验失败，请检查登录表单。');

    const agreementAccepted = await this.acceptLoginAgreement();
    const challengeInput = this.loginChallengeInput();
    if (await challengeInput.count()) {
      const bodyText = await this.page.locator('body').innerText().catch(() => '');
      const challenge = bodyText.split(/\r?\n/).map(line => line.trim())
        .find(line => /计算|算式|验证码/.test(line) && /[0-9０-９].*[+＋\-－×xX*÷／/=]/.test(line))
        ?? bodyText.split(/\r?\n/).map(line => line.trim()).find(line => /计算|算式|验证码/.test(line))
        ?? '登录页要求完成计算/验证码验证，请查看页面提示并把题目转发给员工。';
      return { status: 'challenge_required', challenge: challenge.slice(0, 240), agreementAccepted };
    }

    // 未发现独立计算验证输入框时，尝试直接请求短信；不触碰图片验证码或其他人机验证。
    await this.clickSmsRequest();
    return { status: 'sms_code_required', agreementAccepted };
  }

  /** 定位非短信验证码输入框，供员工提供普通计算题答案。 */
  private loginChallengeInput(): Locator {
    return this.page.locator(
      'input[placeholder*="验证码"]:not([placeholder*="短信"]):not([placeholder*="手机"]), ' +
      'input[placeholder*="计算"], input[name*="captcha" i]'
    ).filter({ visible: true }).first();
  }

  /** 只勾选文字明确表明为同意协议的复选框，不操作其他选项。 */
  private async acceptLoginAgreement(): Promise<boolean> {
    // 长沙移动门户使用 Element UI：协议文字与复选框是同级区域，不在 label 内部。
    const agreementLabels = this.page.locator('label.agree-label:visible').filter({ hasText: /我已阅读并同意/ });
    const agreementCount = await agreementLabels.count();
    if (agreementCount > 0) {
      if (agreementCount !== 1) {
        throw new Error('登录页存在多个协议说明，无法安全判断对应复选框，停止自动勾选。');
      }

      // 从协议文字向上找到 .agree-box，再只检查该容器内的复选框。
      const agreementBox = agreementLabels.first().locator('xpath=../..');
      const checkboxes = agreementBox.locator('input[type="checkbox"]');
      if (await agreementBox.locator('label.agree-label').count() !== 1 || await checkboxes.count() !== 1) {
        throw new Error('协议区域未包含唯一复选框；为避免误操作，停止登录。');
      }

      const checkbox = checkboxes.first();
      if (!await checkbox.isChecked()) {
        // Element UI 会把原生 input 隐藏在可视区域之外，必须点击用户实际看到的复选框外观。
        const visualCheckbox = agreementBox.locator('label.el-checkbox .el-checkbox__inner');
        if (await visualCheckbox.count() !== 1 || !await visualCheckbox.isVisible()) {
          throw new Error('协议复选框的可视点击区域不唯一或不可见，停止自动勾选。');
        }
        await visualCheckbox.click();
      }
      return await checkbox.isChecked();
    }

    // 兼容其他版本中“同意”文字直接包裹标准复选框的页面结构。
    const labels = this.page.locator('label:visible').filter({ hasText: /同意/ });
    const count = await labels.count();
    if (count === 0) return false;
    if (count !== 1) throw new Error('登录页存在多个“同意”选项，无法安全判断协议复选框，停止自动勾选。');

    const label = labels.first();
    const checkbox = label.locator('input[type="checkbox"]');
    if (await checkbox.count() === 1) {
      if (!await checkbox.isChecked()) await checkbox.check({ force: true });
      return await checkbox.isChecked();
    }

    const roleCheckbox = label.getByRole('checkbox');
    if (await roleCheckbox.count() === 1) {
      if (!await roleCheckbox.isChecked()) await roleCheckbox.check();
      return await roleCheckbox.isChecked();
    }

    throw new Error('识别到同意协议文字，但无法定位对应复选框；为避免误操作，停止登录。');
  }

  /** 点击获取短信验证码；如果按钮处于倒计时/禁用状态，不重复发送短信。 */
  private async clickSmsRequest(): Promise<void> {
    const buttons = this.page.locator('button:visible').filter({ hasText: /获取.*验证码|发送.*验证码/ });
    if (await buttons.count() !== 1) throw new Error('无法唯一定位“获取短信验证码”按钮，请检查登录页面结构。');
    const button = buttons.first();
    if (await button.isDisabled()) {
      const label = (await button.innerText()).trim();
      if (/\d+\s*秒|已发送|重新获取/.test(label)) return;
      throw new Error('获取短信验证码按钮当前不可用，未重复点击。');
    }
    await button.click();
  }

  /** 员工在聊天窗口提供计算题答案后，自动填写并请求短信验证码。 */
  async requestSmsCode(challengeAnswer?: string): Promise<{ status: 'sms_code_required'; message: string }> {
    const challengeInput = this.loginChallengeInput();
    if (await challengeInput.count()) {
      if (!challengeAnswer?.trim()) throw new Error('需要员工先提供登录页计算验证答案。');
      await challengeInput.fill(challengeAnswer.trim());
      await challengeInput.press('Tab');
    }
    await this.clickSmsRequest();
    return { status: 'sms_code_required', message: '短信验证码已请求，请向员工询问短信验证码。' };
  }

  /** 员工在聊天窗口提供短信验证码后，自动填写并提交登录。 */
  async submitSmsCode(code: string): Promise<void> {
    const normalized = code.trim();
    if (!/^\d{4,8}$/.test(normalized)) throw new Error('短信验证码格式不正确，请检查位数后重试。');

    const smsInput = this.page.locator(
      'input[placeholder*="短信验证码"], input[placeholder*="手机验证码"], input[name*="sms" i]'
    ).filter({ visible: true }).first();
    await smsInput.waitFor({ state: 'visible', timeout: 10_000 });
    await smsInput.fill(normalized);

    const loginButton = this.page.locator('button:visible').filter({ hasText: /^\s*登录\s*$/ });
    if (await loginButton.count() !== 1) throw new Error('无法唯一定位登录按钮，请检查登录页面结构。');
    await loginButton.click();

    const menu = this.page.getByText('端口上报管理', { exact: true }).filter({ visible: true }).first();
    await menu.waitFor({ state: 'visible', timeout: Math.min(this.config.loginTimeoutMs, 60_000) });
    await this.saveAuth();
  }

  /** 业务任务只复用已登录会话；未登录时立即提示 Agent 先走分阶段登录。 */
  async login(): Promise<void> {
    const menu = this.page.getByText('端口上报管理', { exact: true }).filter({ visible: true }).first();
    if (!await menu.isVisible().catch(() => false)) {
      throw new Error('当前云浏览器尚未登录。请先执行 login-start / login-verify / login-submit 分阶段登录，再运行业务任务。');
    }
    await this.saveAuth();
  }

  async close(): Promise<void> {
    if (this.config.cdpUrl) {
      // 只断开 Playwright 的 CDP 连接，不关闭云浏览器、上下文或当前标签页。
      await this.browser?.close().catch(() => undefined);
      return;
    }
    await this.saveAuth().catch(() => undefined);
    await this.page.context().close().catch(() => undefined);
    await this.browser?.close();
  }

  private async clickText(label: string): Promise<void> {
    const menu = this.page.locator('.el-menu:visible').first().getByText(label, { exact: true }).filter({ visible: true });
    // 菜单与面包屑可能具有相同文本，优先限定左侧 Element UI 菜单。
    const target = await menu.count() ? menu : this.page.getByText(label === '自定义:' ? /^\s*自定义\s*[:：]?\s*$/ : label, { exact: true }).filter({ visible: true });
    await target.first().waitFor({ state: 'visible', timeout: 10_000 });
    if (await target.count() !== 1) throw new Error(`无法唯一定位“${label}”，请核对门户页面结构。`);
    await target.click();
  }

  private async button(scope: Page | Locator, label: string): Promise<Locator> {
    const button = scope.locator('button').filter({ hasText: exact(label), visible: true });
    await button.waitFor({ state: 'visible', timeout: 10_000 });
    return button;
  }

  private async query(batchId?: string): Promise<void> {
    const button = await this.button(this.page, '查询');
    const requests = new Set<Request>();
    const capture = (r: Request) => {
      if (['xhr', 'fetch'].includes(r.resourceType()) && (!batchId || requestContainsBatch(r.url(), r.postData(), batchId))) requests.add(r);
    };
    this.page.on('request', capture);
    try {
      const [response] = await Promise.all([
        this.page.waitForResponse(r => requests.has(r.request()), { timeout: 20_000 }), button.click(),
      ]);
      if (!response.ok() || await response.finished()) throw new Error('门户查询请求失败。');
      await this.page.locator('.el-loading-mask:visible').first().waitFor({ state: 'hidden', timeout: 20_000 });
      await this.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    } finally { this.page.off('request', capture); }
  }

  async prepare(range: DateRange): Promise<void> {
    // 门户实测：文档所述“真实端口数据管理 + 状态=集团驳回”当前查不出任何记录，
    // 真正的集团驳回数据在“驳回端口查询”里，以“驳回类型=集团驳回”“驳回时间”筛选。
    await this.clickText('端口上报管理');
    await this.clickText('驳回端口查询');
    const reset = this.page.locator('button').filter({ hasText: exact('重置'), visible: true });
    await reset.first().waitFor({ state: 'visible', timeout: 15_000 });
    if (await reset.count() === 1) await reset.click();
    else throw new Error('未找到唯一的重置按钮，不能确保没有残留查询条件。');
    // 重置后表单会重新渲染，必须等筛选条件就位再填写，否则会读到旧控件。
    const rejectTime = this.page.locator('.el-form-item:visible').filter({ hasText: /驳回时间/ });
    await rejectTime.first().waitFor({ state: 'visible', timeout: 15_000 });
    // 驳回时间范围（门户实测该项可编辑，无需走日历）
    const rangeInput = rejectTime
      .locator('.el-date-editor--daterange, .el-date-editor--datetimerange');
    const inputs = rangeInput.locator('input');
    if (await inputs.count() !== 2) throw new Error('找不到唯一驳回时间范围，请核对日期控件。');
    if (await inputs.nth(0).getAttribute('readonly') !== null) {
      await inputs.nth(0).click();
      const picker = this.page.locator('.el-date-range-picker:visible');
      await picker.waitFor({ state: 'visible' });
      for (const date of [range.start, range.end]) {
        const [year, month, day] = date.split('-').map(Number);
        const left = picker.locator('.el-date-range-picker__content.is-left');
        for (let attempt = 0; ; attempt++) {
          const heading = await left.locator('.el-date-range-picker__header').innerText();
          const current = heading.match(/(\d{4})\s*年\s*(\d+)\s*月/);
          if (!current) throw new Error('无法识别日历年月。');
          const difference = (year - Number(current[1])) * 12 + month - Number(current[2]);
          if (!difference) break;
          if (attempt >= 240) throw new Error('日期超出日历导航范围。');
          // 两个面板各带一组箭头，右面板的上一月按钮常被禁用；
          // 下一月必须由左面板的右箭头推进，否则左面板月份不会前进。
          await picker.locator(difference < 0 ? '.is-left button.el-icon-arrow-left' : '.is-left button.el-icon-arrow-right').click();
        }
        await left.locator('td.available:not(.prev-month):not(.next-month):not(.disabled)').filter({ hasText: exact(String(day)) }).click();
      }
    } else {
      await inputs.nth(0).fill(range.start);
      await inputs.nth(1).fill(range.end);
      await inputs.nth(1).press('Tab');
    }
    const assertDate = async () => {
      const start = await inputs.nth(0).inputValue();
      const end = await inputs.nth(1).inputValue();
      if (start !== range.start || end !== range.end) throw new Error(`驳回时间范围未生效（当前 ${start} ~ ${end}），停止导出。`);
    };
    await assertDate();
    await this.query();
    await assertDate();
  }

  async createExport(): Promise<string> {
    await (await this.button(this.page, '批量导出')).click();
    const dialogs = this.page.locator('.el-message-box:visible, [role="dialog"]:visible:not(:has(.el-message-box))');
    const confirmation = dialogs.filter({ hasText: /确定.*导出|是否.*导出/ });
    // 有些版本直接创建任务，有些版本先弹确认框。
    await this.page.waitForFunction(() => Array.from(document.querySelectorAll('.el-message-box, [role="dialog"]')).some(e =>
      (e as HTMLElement).offsetHeight > 0 && /批次号|确定.*导出|是否.*导出/.test((e as HTMLElement).innerText)), undefined, { timeout: 15_000 });
    if (await confirmation.count() === 1) await (await this.button(confirmation, '确定')).click();
    const notice = dialogs.filter({ hasText: /批次号/ });
    const exportError = this.page.locator('.el-message:visible, .el-notification:visible')
      .filter({ hasText: /操作异常|导出失败|系统错误|无符合|暂无.*数据/ });
    await notice.or(exportError).first().waitFor({ state: 'visible', timeout: 30_000 });
    if (await exportError.count()) throw new Error(`门户未完成导出：${await exportError.first().innerText()}。保留状态，请核实门户后再恢复，勿自动重复提交。`);
    const id = parseBatch(await notice.innerText());
    if (!id) throw new Error('未取得导出批次号。请在批量导出结果查询中核实当前任务后，用 results --batch-id 续查；不要重复导出。');
    const detail = notice.getByRole('button', { name: /查看详情/ });
    if (await detail.isVisible().catch(() => false)) await detail.click();
    else {
      const ok = notice.getByRole('button', { name: exact('确定') });
      if (await ok.isVisible().catch(() => false)) await ok.click();
    }
    return id;
  }

  async openResults(): Promise<void> {
    await this.clickText('批量任务查询');
    await this.clickText('批量导出结果查询');
    await this.page.locator('th:visible').filter({ hasText: exact('已导数量') }).first().waitFor();
  }

  async findTask(batchId: string): Promise<Locator | undefined> {
    const field = this.page.locator('.el-form-item:visible').filter({ hasText: /批次号/ }).locator('input');
    await field.fill(batchId);
    await this.query(batchId);
    if (await field.inputValue() !== batchId) throw new Error('查询批次号已改变，停止下载。');
    const rows = this.page.locator('.el-table__body-wrapper tr:visible, table tbody tr:visible');
    const matches: Locator[] = [];
    const signatures = new Set<string>();
    for (const row of await rows.all()) {
      const cells = (await row.locator('td').allTextContents()).map(v => v.trim());
      if (!cells.includes(batchId)) continue;
      matches.push(row);
      signatures.add(cells.join(''));
    }
    if (matches.length === 0) return undefined;
    // Element UI 固定列会把同一行再渲染一份，必须去重，否则会误判为多行。
    const row = matches[0];
    if (signatures.size > 1) throw new Error('同一批次出现多个数据行，停止下载以避免错配。');
    const headers = (await this.page.locator('.el-table__header-wrapper:visible th, table:visible thead th').allTextContents()).map(v => v.replace(/\s/g, ''));
    const cells = (await row.locator('td').allTextContents()).map(v => v.trim());
    const nameIndex = headers.indexOf('任务名称'), statusIndex = headers.indexOf('状态');
    if (nameIndex < 0 || statusIndex < 0) throw new Error('导出任务表头缺失。');
    // 门户实测：从“驳回端口查询”导出的任务名称是“驳回端口导出”，数据类别“驳回端口”。
    if (cells[nameIndex] !== '驳回端口导出') throw new Error(`该批次任务名称不是“驳回端口导出”，停止下载。`);
    const state = taskStatus(cells[statusIndex] ?? '');
    if (state === 'failed') throw new Error('导出任务失败，请在门户核查。');
    if (state === 'pending') return undefined;
    return row;
  }

  /** 点击批次行的“下载”，门户会弹出该批次导出的文件列表。 */
  private async openFileList(row: Locator): Promise<Locator> {
    let button = row.getByRole('button', { name: /下载/ }).or(row.getByRole('link', { name: /下载/ })).filter({ visible: true });
    if (await button.count() === 0) {
      // Element UI 固定操作列独立渲染，必须按行号回退定位，不能取全页首个下载。
      const index = await row.evaluate(e => Array.from(e.parentElement!.children).indexOf(e));
      const fixed = this.page.locator('.el-table__fixed-right:visible tbody tr').nth(index);
      button = fixed.locator('button, a').filter({ hasText: /下载/ }).filter({ visible: true });
    }
    if (await button.count() !== 1) throw new Error('无法唯一定位该批次的下载按钮。');
    await button.first().click();
    const dialog = this.page.locator('.el-message-box:visible, [role="dialog"]:visible:not(:has(.el-message-box))')
      .filter({ hasText: /文件标识|文件列表/ });
    await dialog.first().waitFor({ state: 'visible', timeout: 15_000 });
    // 弹窗先出现，表头和表体再异步加载，必须等到真的有文件行。
    await dialog.first().locator('.el-table__body-wrapper tr:visible, table tbody tr:visible').first()
      .waitFor({ state: 'visible', timeout: 20_000 });
    return dialog.first();
  }

  /** 门户按分片导出，一次导出会有多个 xlsx，需要逐个下载后合并。 */
  private async downloadParts(dialog: Locator, batchId: string): Promise<string[]> {
    await mkdir(this.config.downloadDir, { recursive: true });
    const seen = new Set<string>();
    const saved: string[] = [];
    // 弹窗里的表格带分页，必须翻页才能取全部分片。
    for (let pageIndex = 1; pageIndex <= 20; pageIndex++) {
      const rows = dialog.locator('.el-table__body-wrapper tr:visible, table tbody tr:visible');
      for (let index = 0; index < await rows.count(); index++) {
        const row = rows.nth(index);
        const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        const fileId = text.match(/(\d{15,})/)?.[1];
        if (!fileId || !text.includes('.xlsx') || seen.has(fileId)) continue;
        seen.add(fileId);
        let button = row.getByRole('button', { name: /下载/ }).or(row.getByRole('link', { name: /下载/ })).filter({ visible: true });
        if (await button.count() === 0) {
          const fixed = dialog.locator('.el-table__fixed-right:visible tbody tr').nth(index);
          button = fixed.locator('button, a').filter({ hasText: /下载/ }).filter({ visible: true });
        }
        if (await button.count() !== 1) throw new Error(`无法定位分片 ${fileId} 的下载按钮。`);
        const part = path.join(this.config.downloadDir, `集团驳回-${batchId}-${fileId}.xlsx`);
        // 续查时复用已完整下载的分片，只补齐缺失或损坏的。
        if (!await this.hasValidShard(part)) await this.downloadOne(button.first(), part);
        saved.push(part);
      }
      const next = dialog.locator('.el-pagination:visible').first().locator('button.btn-next, .el-pagination button.el-icon-arrow-right').first();
      if (await next.count() === 0 || await next.isDisabled().catch(() => true)) break;
      await next.click();
      await this.page.waitForTimeout(600);
    }
    if (saved.length === 0) throw new Error(`批次 ${batchId} 的文件列表为空，导出可能尚未生成文件。`);
    return saved;
  }

  /** 判断本地分片是否已完整下载。 */
  private async hasValidShard(file: string): Promise<boolean> {
    try {
      return isCompleteXlsx(await readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    }
  }

  /** 单个分片下载：优先浏览器下载事件，其次接口二进制响应。 */
  private async downloadOne(button: Locator, target: string): Promise<void> {
    // 门户偶发返回尾部带多余字节的响应体，修复后仍不可用才重新点击下载。
    for (let attempt = 1; attempt <= 3; attempt++) {
      const bytes = await this.downloadOneAttempt(button, target);
      if (bytes) return;
      console.error(`分片 ${path.basename(target)} 第 ${attempt} 次下载不可用，重试。`);
      await this.page.waitForTimeout(1_500);
    }
    throw new Error(`分片 ${path.basename(target)} 连续 3 次下载均不可用，已保留状态文件，请用 results 续查原批次。`);
  }

  /**
   * 下载单个分片，返回保存成功的字节数；内容不可用时返回 undefined 以便重试。
   * 门户会在有效 ZIP 之后追加多余字节，按 ZIP 结构截断即可修复，行数不会丢失。
   */
  private async downloadOneAttempt(button: Locator, target: string): Promise<number | undefined> {
    let nativeDownload: Download | undefined;
    const responses: Response[] = [];
    const context = this.page.context();
    const pages = new Set<Page>();
    const captureDownload = (download: Download) => { nativeDownload = download; };
    const capturePage = (page: Page) => { pages.add(page); page.on('download', captureDownload); };
    const captureResponse = (response: Response) => {
      // 门户实测：真实接口是 /file-api/exportFile/downloadFileByFileId，
      // 首次请求可能返回 JSON 错误体，需要等后续返回 PK 的那一次。
      if (new URL(response.url()).pathname.includes('/file-api/exportFile/downloadFile') && response.ok()) responses.push(response);
    };
    capturePage(this.page);
    context.on('page', capturePage);
    context.on('response', captureResponse);
    try {
      await button.click();
      const confirmation = this.page.locator('.el-message-box:visible, [role="dialog"]:visible:not(:has(.el-message-box))')
        .filter({ hasText: /确定.*下载/ });
      if (await confirmation.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false)) {
        await (await this.button(confirmation, '确定')).click();
      }
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (nativeDownload) {
          const download = nativeDownload;
          nativeDownload = undefined;
          try {
            await download.saveAs(`${target}.part`);
            const bytes = repairXlsx(await readFile(`${target}.part`));
            if (isCompleteXlsx(bytes)) {
              await rename(`${target}.part`, target);
              return bytes.length;
            }
            await unlink(`${target}.part`).catch(() => undefined);
          } catch { /* 浏览器下载取消时，继续检查同次操作产生的二进制响应。 */ }
        }
        for (const response of responses.splice(0)) {
          const raw = await response.body().catch(() => undefined);
          const bytes = raw ? repairXlsx(raw) : undefined;
          if (!bytes || !isCompleteXlsx(bytes)) continue;
          await writeFile(`${target}.part`, bytes);
          await rename(`${target}.part`, target);
          return bytes.length;
        }
        await this.page.waitForTimeout(200);
      }
      return undefined;
    } finally {
      context.off('page', capturePage);
      context.off('response', captureResponse);
      for (const page of pages) page.off('download', captureDownload);
    }
  }

  async download(row: Locator, batchId: string): Promise<string> {
    const dialog = await this.openFileList(row);
    const parts = await this.downloadParts(dialog, batchId);
    // 门户按分片导出，多个文件需要合并成一份结果。
    const merged = await mergeWorkbooks(parts, path.join(this.config.downloadDir, `集团驳回-${batchId}.xlsx`));
    // 合并成功后清理分片，只保留最终结果。
    if (parts.length > 1) for (const part of parts) await unlink(part).catch(() => undefined);
    return merged;
  }

  async waitAndDownload(batchId: string): Promise<string> {
    await this.openResults();
    const deadline = Date.now() + this.config.pollTimeoutMs;
    do {
      const row = await this.findTask(batchId);
      if (row) return this.download(row, batchId);
      await this.page.waitForTimeout(Math.min(this.config.pollIntervalMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new Error(`导出批次 ${batchId} 尚未完成；用 results --batch-id ${batchId} 继续查询。`);
  }
}

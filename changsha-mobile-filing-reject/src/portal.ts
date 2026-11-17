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

  async login(): Promise<void> {
    await this.page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded' });
    const menu = this.page.getByText('端口上报管理', { exact: true }).filter({ visible: true }).first();
    const phone = this.page.locator('input[placeholder*="手机号"], input[type="tel"], input[name*="phone" i]')
      .filter({ visible: true }).first();
    // SPA 在 DOMContentLoaded 后才渲染登录表单，不能用瞬时 isVisible 跳过填写。
    await menu.or(phone).first().waitFor({ state: 'visible', timeout: 30_000 });
    if (!await menu.isVisible()) {
      if (this.config.loginPhone) {
        await phone.fill(this.config.loginPhone);
        await phone.press('Tab');
        if (await phone.inputValue() !== this.config.loginPhone) throw new Error('手机号填写后校验失败，请检查登录表单。');
        console.error('登录手机号已自动填写并核验。');
      }
      console.error('请在浏览器完成人工登录：手机号、计算题及短信验证码。程序会自动继续。');
      await menu.waitFor({ state: 'visible', timeout: this.config.loginTimeoutMs });
    }
    await this.saveAuth();
  }

  async close(): Promise<void> {
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

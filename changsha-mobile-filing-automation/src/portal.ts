import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePortalCounts } from './portal-counts.js';
import { uploadNavigation } from './filing-type.js';
import { requestContainsBatch, hasExactBatch } from './task-query.js';
import { chromium, type Browser, type BrowserContext, type Cookie, type Locator, type Page } from 'playwright';
import type { AppConfig } from './config.js';

export type ImportResult = {
  taskName: string;
  status: string;
  batchId?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  downloadPath?: string;
  failureExportPath?: string;
  /** “导出失败数据”生成的导出任务批次号，可用于审计与恢复下载。 */
  failureExportBatchId?: string;
};

export type UploadSubmission = {
  batchId?: string;
};

type StoredValue = { name: string; value: string };

type SavedAuthState = {
  version: 1;
  origin: string;
  savedAt: string;
  cookies: Cookie[];
  localStorage: StoredValue[];
  sessionStorage: StoredValue[];
};

const text = (value: string) => new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`);

async function clickFirstVisible(page: Page, candidates: Locator[], description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await candidate.count() > 0 && await candidate.first().isVisible().catch(() => false)) {
        await candidate.first().click();
        return;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`页面结构发生变化，10 秒内找不到“${description}”。请在 src/portal.ts 中更新定位方式。`);
}

function findColumnValue(headers: string[], cells: string[], header: string): string | undefined {
  const index = headers.findIndex((item) => item.trim() === header);
  return index >= 0 ? cells[index]?.trim() : undefined;
}

export class MobilePortal {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly config: AppConfig,
  ) {}

  static async launch(config: AppConfig): Promise<MobilePortal> {
    await mkdir(config.profileDir, { recursive: true });
    await mkdir(config.downloadDir, { recursive: true });
    // 登录凭据已由 auth-state.json 独立保存，无需复用 Chrome 用户目录。
    // 使用干净的临时会话可以避开受损配置或第三方组件造成的 Chrome 崩溃。
    const browser = await chromium.launch({
      channel: config.browserChannel,
      headless: false,
      // 部分 Windows 图形驱动会使 Playwright 启动的 Chrome 在业务页加载时崩溃。
      // 报备流程不依赖 GPU 渲染，禁用 GPU 可避免这类会话被意外关闭。
      args: ['--disable-gpu'],
    });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 960 },
    });
    await MobilePortal.restoreAuthenticationState(context, config);
    return new MobilePortal(browser, context, config);
  }

  private static async restoreAuthenticationState(context: BrowserContext, config: AppConfig): Promise<void> {
    try {
      const state = JSON.parse(await readFile(config.authStatePath, 'utf8')) as SavedAuthState;
      if (state.version !== 1 || state.origin !== new URL(config.baseUrl).origin) return;
      if (Array.isArray(state.cookies) && state.cookies.length > 0) await context.addCookies(state.cookies);
      const localStorage = Array.isArray(state.localStorage) ? state.localStorage : [];
      const sessionStorage = Array.isArray(state.sessionStorage) ? state.sessionStorage : [];
      await context.addInitScript(({ origin, localValues, sessionValues }) => {
        if (window.location.origin !== origin) return;
        for (const item of localValues) window.localStorage.setItem(item.name, item.value);
        for (const item of sessionValues) window.sessionStorage.setItem(item.name, item.value);
      }, { origin: state.origin, localValues: localStorage, sessionValues: sessionStorage });
      console.log(`已加载本地登录状态（保存于 ${state.savedAt}）。`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('本地登录状态无法读取，将按首次登录流程继续。');
      }
    }
  }

  async saveAuthenticationState(): Promise<void> {
    if (!await this.isAuthenticated()) return;
    const page = await this.page();
    const origin = new URL(this.config.baseUrl).origin;
    const browserState = await this.context.storageState();
    const originState = browserState.origins.find((item) => item.origin === origin);
    const sessionStorage = await page.evaluate((expectedOrigin) => {
      if (window.location.origin !== expectedOrigin) return [];
      return Object.entries(window.sessionStorage).map(([name, value]) => ({ name, value }));
    }, origin);
    const state: SavedAuthState = {
      version: 1,
      origin,
      savedAt: new Date().toISOString(),
      cookies: browserState.cookies,
      localStorage: originState?.localStorage ?? [],
      sessionStorage,
    };
    await mkdir(path.dirname(this.config.authStatePath), { recursive: true });
    const temporary = `${this.config.authStatePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.config.authStatePath);
  }

  async close(): Promise<void> {
    await this.saveAuthenticationState().catch(() => undefined);
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  private async page(): Promise<Page> {
    const [page] = this.context.pages();
    return page ?? await this.context.newPage();
  }

  async openLogin(): Promise<void> {
    const page = await this.page();
    await page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded' });
    // 已恢复会话时门户会直接跳转至业务首页，此时没有手机号输入框，不应输出无意义告警。
    if (await this.isAuthenticated()) return;
    await this.fillLoginPhone();
  }

  private async fillLoginPhone(): Promise<void> {
    if (!this.config.loginPhone) return;
    const page = await this.page();
    // 仅匹配登录页上带有明确手机号语义的输入框，避免填入短信验证码或业务数据字段。
    const candidates = [
      page.locator('input[placeholder*="手机号"]'),
      page.locator('input[placeholder*="手机号码"]'),
      page.locator('input[name*="phone" i]'),
      page.locator('input[id*="phone" i]'),
      page.locator('input[type="tel"]'),
    ];
    for (const candidate of candidates) {
      if (await candidate.count() === 0 || !await candidate.first().isVisible().catch(() => false)) continue;
      await candidate.first().fill(this.config.loginPhone);
      console.log('已自动填入登录手机号。');
      return;
    }
    console.warn('未找到登录手机号输入框，未自动填写；请检查门户登录页是否调整。');
  }

  async isAuthenticated(): Promise<boolean> {
    const page = await this.page();
    return await page.getByText(/^(?:5G)?端口上报管理$/).first().isVisible().catch(() => false);
  }

  async goToRealPortData(filePath: string): Promise<Page> {
    const page = await this.page();
    const navigation = uploadNavigation(filePath);
    for (const label of navigation) {
      await clickFirstVisible(page, [
        page.getByText(label, { exact: true }),
        page.locator(`text=${label}`),
      ], label);
    }
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  async uploadExcel(filePath: string): Promise<UploadSubmission> {
    const page = await this.goToRealPortData(filePath);
    await clickFirstVisible(page, [
      page.getByRole('button', { name: text('批量导入') }),
      page.getByText('批量导入', { exact: true }),
    ], '批量导入');

    const dialog = page.locator('.el-dialog, [role="dialog"]').filter({ hasText: /批量导入.*真实端口/ }).last();
    await dialog.waitFor({ state: 'visible' });
    const input = dialog.locator('input[type="file"]').last();
    const networkTrace: string[] = [];
    const browserDiagnostics: string[] = [];
    const traceUrl = (urlValue: string): string => {
      try {
        const url = new URL(urlValue);
        return url.pathname;
      } catch {
        return '未知地址';
      }
    };
    const captureRequest = (request: import('playwright').Request) => {
      networkTrace.push(`${request.method()} ${traceUrl(request.url())} 已发起`);
    };
    const captureResponse = (response: import('playwright').Response) => {
      const request = response.request();
      networkTrace.push(`${request.method()} ${traceUrl(response.url())} → HTTP ${response.status()}`);
    };
    const captureConsole = (message: import('playwright').ConsoleMessage) => {
      if (message.type() === 'error' || message.type() === 'warning') browserDiagnostics.push(`控制台 ${message.type()}: ${message.text()}`);
    };
    const capturePageError = (error: Error) => browserDiagnostics.push(`页面异常: ${error.message}`);
    page.on('request', captureRequest);
    page.on('response', captureResponse);
    page.on('console', captureConsole);
    page.on('pageerror', capturePageError);
    let submittedBatchId: string | undefined;
    try {
      await input.setInputFiles(filePath);
      // 部分门户会在选择文件后先异步上传到临时区；等待其完成后再点击提交。
      await page.waitForTimeout(1_000);
      // 页面将“确定”渲染为“确 定”，不能使用严格的“确定”文本匹配；
      // 仅定位当前导入弹窗底部的原生按钮，避免误点上传控件的内部元素。
      const confirmButton = dialog.locator('.el-dialog__footer button').filter({ hasText: /确\s*定/ }).last();
      await confirmButton.waitFor({ state: 'visible' });
      if (await confirmButton.isDisabled()) throw new Error('导入确认按钮当前不可用，请确认数据文件已选择完成。');
      const buttonState = await confirmButton.evaluate((element) => ({
        text: element.textContent?.replace(/\s+/g, ' ').trim(),
        disabled: (element as HTMLButtonElement).disabled,
        className: element.className,
      }));
      await confirmButton.click();
      // 门户的第一个“确定”只会打开“您确定要导入…”二次确认框；
      // 真正调用上传接口的是二次确认中的“确定”。
      const secondaryConfirmDialog = page.locator('.el-message-box, [role="dialog"]')
        .filter({ hasText: /您确定要导入/ }).last();
      if (await secondaryConfirmDialog.isVisible().catch(() => false)) {
        const secondaryConfirmButton = secondaryConfirmDialog.locator('.el-message-box__btns button, button')
          .filter({ hasText: /确\s*定/ }).last();
        await secondaryConfirmButton.waitFor({ state: 'visible' });
        if (await secondaryConfirmButton.isDisabled()) throw new Error('门户二次确认按钮当前不可用。');
        await secondaryConfirmButton.click();
      }
      // 只有弹窗关闭（或页面出现明确成功提示）才认为提交动作已经被系统接受，
      // 防止把“点击上传文件”或仍在校验中的状态误报为成功。
      await Promise.race([
        dialog.waitFor({ state: 'hidden', timeout: 30_000 }),
        page.getByText(/导入成功|提交成功|上传成功/).first().waitFor({ state: 'visible', timeout: 30_000 }),
      ]).catch(async () => {
        const dialogText = await dialog.innerText().catch(() => '');
        const trace = networkTrace.length > 0 ? ` 网络轨迹：${networkTrace.slice(-12).join('；')}` : ' 未观察到文件选择或确认后的网络请求。';
        const diagnostics = browserDiagnostics.length > 0 ? ` 浏览器诊断：${browserDiagnostics.slice(-5).join('；')}` : '';
        throw new Error(`未确认导入提交成功，弹窗仍处于打开状态。确认按钮：${JSON.stringify(buttonState)}。${trace}${diagnostics}${dialogText ? ` 页面提示：${dialogText}` : ''}`);
      });
      // 门户的成功提示框只有“取消”和“查看详情”，没有“确定”。
      // 点击“查看详情”可直接进入批量任务查询；若按钮缺失才回退到关闭弹窗。
      const successDialog = page.locator('.el-message-box, [role="dialog"]')
        .filter({ hasText: /导入成功|提交成功|上传成功/ }).last();
      if (await successDialog.isVisible().catch(() => false)) {
        const successText = await successDialog.innerText();
        submittedBatchId = successText.match(/批次号为[：:]\s*(\d+)/)?.[1];
        const detailsButton = successDialog.locator('.el-message-box__btns button, button')
          .filter({ hasText: /查看详情/ }).last();
        if (await detailsButton.isVisible().catch(() => false)) {
          await detailsButton.evaluate((element: HTMLButtonElement) => element.click());
        } else {
          const closeButton = successDialog.locator('.el-message-box__headerbtn, button[aria-label*="Close" i]').last();
          if (await closeButton.isVisible().catch(() => false)) await closeButton.click();
        }
        await successDialog.waitFor({ state: 'hidden' }).catch(() => undefined);
      }
      if (await dialog.isVisible().catch(() => false)) {
        const cancelButton = dialog.locator('.el-dialog__footer button').filter({ hasText: /取\s*消/ }).last();
        if (await cancelButton.isVisible().catch(() => false)) await cancelButton.click();
        await dialog.waitFor({ state: 'hidden' }).catch(() => undefined);
      }
    } finally {
      page.off('request', captureRequest);
      page.off('response', captureResponse);
      page.off('console', captureConsole);
      page.off('pageerror', capturePageError);
    }
    return { batchId: submittedBatchId };
  }

  async goToImportResults(): Promise<Page> {
    const page = await this.page();
    await clickFirstVisible(page, [
      page.getByText('批量任务查询', { exact: true }),
      page.locator('text=批量任务查询'),
    ], '批量任务查询');
    await clickFirstVisible(page, [
      page.getByText('批量导入结果查询', { exact: true }),
      page.locator('text=批量导入结果查询'),
    ], '批量导入结果查询');
    await page.locator('th:visible').filter({ hasText: '成功数量' }).first().waitFor({ state: 'visible', timeout: 15_000 });
    return page;
  }

  private async searchTaskByBatchId(page: Page, batchId: string): Promise<void> {
    const taskName = page.locator('.el-form-item:visible').filter({ hasText: '任务名称' }).locator('input').first();
    if (await taskName.count()) await taskName.fill('');
    const batchField = page.locator('.el-form-item')
      .filter({ has: page.locator('label[for="taskId"]') })
      .locator('input:visible')
      .first();
    await batchField.waitFor({ state: 'visible' });
    await batchField.fill(batchId);
    const queryButton = page.locator('button.el-button--primary:visible')
      .filter({ hasText: text('查询') })
      .first();
    await queryButton.waitFor({ state: 'visible' });
    const requests = new Set<import('playwright').Request>();
    const capture = (request: import('playwright').Request) => {
      if (['xhr', 'fetch'].includes(request.resourceType()) && requestContainsBatch(request.url(), request.postData(), batchId)) requests.add(request);
    };
    page.on('request', capture);
    try {
      const [response] = await Promise.all([
        page.waitForResponse((response) => requests.has(response.request()), { timeout: 20_000 }),
        queryButton.click({ noWaitAfter: true }),
      ]);
      if (!response.ok()) throw new Error(`查询批次 ${batchId} 返回 HTTP ${response.status()}。`);
      const failure = await response.finished();
      if (failure) throw new Error(`查询批次 ${batchId} 响应中断。`);
      await page.locator('.el-loading-mask:visible').first().waitFor({ state: 'hidden', timeout: 20_000 });
      // Wait for the framework to paint the completed response, including unchanged/empty results.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (await batchField.inputValue() !== batchId) throw new Error('查询期间批次号发生变化，停止读取结果。');
    } finally { page.off('request', capture); }
  }

  private async locateTaskRow(fileName: string, expectedBatchId?: string): Promise<Locator | undefined> {
    // “批量导入结果查询”和“批量导出结果查询”都有批次号输入框。
    // 每次查导入结果前必须显式回到导入页，不能用输入框是否存在判断当前页，
    // 否则会把导入批次号误填到导出结果查询页。
    const page = await this.goToImportResults();
    if (expectedBatchId) await this.searchTaskByBatchId(page, expectedBatchId);
    const bareName = path.basename(fileName, path.extname(fileName));
    const rows = page.locator('tbody tr, .el-table__body tr');
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!await row.isVisible()) continue;
      const rowText = await row.innerText().catch(() => '');
      if (expectedBatchId && hasExactBatch(await row.locator('td').allTextContents(), expectedBatchId)) return row;
      if (!expectedBatchId && (rowText.includes(fileName) || rowText.includes(bareName))) return row;
    }
    return undefined;
  }

  /** 单次查询，不等待；供批量调度器轮流检查多个门户批次。 */
  async queryImportResult(
    fileName: string,
    onTaskFound?: (batchId: string) => Promise<void>,
    expectedBatchId?: string,
  ): Promise<ImportResult | undefined> {
    const row = await this.locateTaskRow(fileName, expectedBatchId);
    if (!row) return undefined;
    const rowText = await row.innerText();
    const page = await this.page();
    const headers = await page.locator('.el-table__header-wrapper th, thead th').allTextContents();
    const cells = await row.locator('td').allTextContents();
    const statusValue = findColumnValue(headers, cells, '状态');
    const status = /处理完成|完成/.test(statusValue ?? '') || /处理完成|完成/.test(rowText)
      ? '处理完成'
      : '处理中';
    const batchId = expectedBatchId ?? findColumnValue(headers, cells, '批次号')
      ?? cells.map((cell) => cell.trim()).find((cell) => /^\d{12,}$/.test(cell));
    if (batchId) await onTaskFound?.(batchId);
    if (status !== '处理完成') return undefined;
    return {
      taskName: fileName, status, batchId,
      ...parsePortalCounts(findColumnValue(headers, cells, '数据总量'), findColumnValue(headers, cells, '成功数量'), findColumnValue(headers, cells, '失败数量'), status === '处理完成'),
    };
  }

  async waitForImportResult(
    fileName: string,
    onTaskFound?: (batchId: string) => Promise<void>,
    expectedBatchId?: string,
  ): Promise<ImportResult> {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    let reportedBatchId: string | undefined;
    while (Date.now() < deadline) {
      const row = await this.locateTaskRow(fileName, expectedBatchId);
      if (row) {
        const rowText = await row.innerText();
        const page = await this.page();
        const headers = await page.locator('.el-table__header-wrapper th, thead th').allTextContents();
        const cells = await row.locator('td').allTextContents();
        const statusValue = findColumnValue(headers, cells, '状态');
        // 固定列会造成表头和原始行单元格错位；整行文本包含“处理完成”时，
        // 应优先视为完成，避免已完成任务被持续轮询。
        const status = /处理完成|完成/.test(statusValue ?? '') || /处理完成|完成/.test(rowText)
          ? '处理完成'
          : '处理中';
        const batchId = expectedBatchId ?? findColumnValue(headers, cells, '批次号')
          ?? cells.map((cell) => cell.trim()).find((cell) => /^\d{12,}$/.test(cell));
        if (batchId && batchId !== reportedBatchId) {
          reportedBatchId = batchId;
          await onTaskFound?.(batchId);
        }
        if (status === '处理完成') {
          return {
            taskName: fileName,
            status,
            batchId,
            ...parsePortalCounts(findColumnValue(headers, cells, '数据总量'), findColumnValue(headers, cells, '成功数量'), findColumnValue(headers, cells, '失败数量'), status === '处理完成'),
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
      // 不刷新整个页面，避免清空批次号输入框；下一轮会保留批次号并再次点击“查询”。
    }
    throw new Error(`等待导入结果超时（${this.config.pollTimeoutMs} ms）。可稍后运行 results 命令继续查询。`);
  }

  private async visibleRowAction(row: Locator, title: string, fallbackLabel: string): Promise<Locator | undefined> {
    const page = await this.page();
    // Element Plus 表格将固定的“操作”列渲染成独立表格：业务数据行中按钮是隐藏副本，
    // 可见按钮按相同行号排列在固定列中。根据当前数据行索引定位可见操作按钮。
    const rowIndex = await row.evaluate((element) => {
      const siblings = element.parentElement?.children;
      return siblings ? Array.prototype.indexOf.call(siblings, element) : -1;
    });
    const visibleAction = rowIndex >= 0 ? page.locator(`button[title="${title}"]:visible`).nth(rowIndex) : undefined;
    const fallback = row.getByText(fallbackLabel, { exact: true }).first();
    const link = visibleAction && await visibleAction.isVisible().catch(() => false) ? visibleAction : fallback;
    return await link.isVisible().catch(() => false) ? link : undefined;
  }

  private async confirmDialog(page: Page, pattern: RegExp, timeout = 5_000): Promise<boolean> {
    const dialog = page.locator('.el-message-box, [role="dialog"]').filter({ hasText: pattern }).last();
    const visible = await dialog.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
    if (!visible) return false;
    const confirmButton = dialog.locator('.el-message-box__btns button, button').filter({ hasText: /确\s*定/ }).last();
    await confirmButton.waitFor({ state: 'visible' });
    // 门户确认后会触发下载/新窗口；使用页面原生 click 避免 Playwright 等待导航而阻塞。
    await confirmButton.evaluate((element: HTMLButtonElement) => element.click());
    return true;
  }

  private async waitForExportTask(taskId: string): Promise<Locator | undefined> {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    while (Date.now() < deadline) {
      const page = await this.page();
      const exportTab = page.getByText('批量导出结果查询', { exact: true });
      if (await exportTab.isVisible().catch(() => false)) {
        // Element Plus 页签切换并不是真实导航，使用原生 click 避免等待页面跳转。
        await exportTab.evaluate((element: HTMLElement) => element.click());
        await page.locator('th:visible').filter({ hasText: '已导数量' }).first().waitFor({ state: 'visible', timeout: 15_000 });
      }
      await this.searchTaskByBatchId(page, taskId);
      const rows = page.locator('tbody tr');
      for (let index = 0; index < await rows.count(); index += 1) {
        const row = rows.nth(index);
        if (!await row.isVisible().catch(() => false)) continue;
        const rowText = await row.innerText().catch(() => '');
        if (hasExactBatch(await row.locator('td').allTextContents(), taskId) && /处理完成/.test(rowText)) return row;
      }
      return undefined;
    }
    throw new Error(`等待失败明细导出任务 ${taskId} 完成超时。`);
  }

  private async downloadExportTaskFile(row: Locator, taskName: string): Promise<string> {
    const page = await this.page();
    // 导出任务页的“操作”列同样属于固定列，原始数据行中的按钮是隐藏副本。
    const button = await this.visibleRowAction(row, '下载导出数据文件', '下载');
    if (!button) throw new Error('失败明细导出任务已完成，但未找到“下载导出数据文件”按钮。');
    const binaryResponses: import('playwright').Response[] = [];
    const captureResponse = (response: import('playwright').Response) => {
      if (response.url().includes('/file-api/exportFile/downloadFile')) binaryResponses.push(response);
    };
    let nativeDownload: import('playwright').Download | undefined;
    void page.waitForEvent('download', { timeout: 30_000 })
      .then((download) => { nativeDownload = download; })
      .catch(() => undefined);
    // 门户会在新开的页面中发起文件请求，因此必须监听整个浏览器会话，
    // 不能只监听当前列表页。
    page.context().on('response', captureResponse);
    try {
      await button.click();
      await this.confirmDialog(page, /确定要/);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (nativeDownload) {
          const saveAs = path.join(this.config.downloadDir, `${taskName}-失败明细-${nativeDownload.suggestedFilename()}`);
          try {
            await nativeDownload.saveAs(saveAs);
            return saveAs;
          } catch {
            // 部分门户会同时触发浏览器下载事件和接口二进制响应，但下载对象无法保存。
            // 继续使用同一请求的 XLSX 响应体作为可靠回退。
            nativeDownload = undefined;
          }
        }
        for (const response of binaryResponses) {
          const body = await response.body().catch(() => undefined);
          // xlsx 为 ZIP 容器，文件头固定为 PK；门户错误设置了 text/html Content-Type，不能据此判断。
          if (body?.subarray(0, 2).toString() !== 'PK') continue;
          const saveAs = path.join(this.config.downloadDir, `${taskName}-失败明细.xlsx`);
          await writeFile(saveAs, body);
          return saveAs;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error('失败明细导出任务未返回可下载的 Excel 文件。');
    } finally {
      page.context().off('response', captureResponse);
    }
  }

  private async exportFailureDetails(
    row: Locator,
    taskName: string,
    importBatchId?: string,
    onCreated?: (id: string) => Promise<void>,
  ): Promise<string> {
    const page = await this.page();
    const exportButton = await this.visibleRowAction(row, '导出失败数据', '导出');
    if (!exportButton) throw new Error('存在失败数据但未找到导出按钮，停止生成结果。');
    await exportButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await exportButton.click();
    await this.confirmDialog(page, /确定要导出失败数据/);
    // 导入提交成功的弹窗和失败明细导出的完成弹窗都包含“批次号为”。
    // 导出任务号必须与当前导入批次号不同，不能将导入批次误带入“批量导出结果查询”。
    const deadline = Date.now() + 30_000;
    let taskDialog: Locator | undefined;
    let taskId: string | undefined;
    let observedIds: string[] = [];
    while (Date.now() < deadline && !taskId) {
      const dialogs = page.locator('.el-message-box:visible, [role="dialog"]:visible').filter({ hasText: /批次号为/ });
      observedIds = [];
      for (let index = 0; index < await dialogs.count(); index += 1) {
        const candidate = dialogs.nth(index);
        const candidateText = await candidate.innerText().catch(() => '');
        const candidateId = candidateText.match(/批次号为[：:]\s*(\d+)/)?.[1];
        if (!candidateId) continue;
        observedIds.push(candidateId);
        if (candidateId === importBatchId) continue;
        taskDialog = candidate;
        taskId = candidateId;
        break;
      }
      if (!taskId) await page.waitForTimeout(200);
    }
    if (!taskDialog || !taskId) {
      const observed = observedIds.length > 0 ? observedIds.join('、') : '无';
      throw new Error(`未取得失败明细导出任务批次号（导入批次号：${importBatchId ?? '未知'}；弹窗批次号：${observed}）。`);
    }
    const detailButton = taskDialog.locator('.el-message-box__btns button, button').filter({ hasText: /查看详情/ }).last();
    await onCreated?.(taskId);
    // “查看详情”会切换任务页签；避免 Playwright 把它当作页面导航而阻塞。
    await detailButton.evaluate((element: HTMLButtonElement) => element.click());
    await page.waitForTimeout(300);
    return taskId;
  }

  private async saveRowDownload(row: Locator, label: '下载', taskName: string): Promise<string | undefined> {
    const page = await this.page();
    const link = await this.visibleRowAction(row, '下载导入数据源文件', label);
    if (!link) return undefined;
    await link.scrollIntoViewIfNeeded().catch(() => undefined);
    const downloadPromise = page.waitForEvent('download');
    await link.click();
    // 结果页的“导出失败数据”和“下载导入源文件”都会再弹出一次确认框。
    const downloadConfirmDialog = page.locator('.el-message-box, [role="dialog"]')
      .filter({ hasText: /确定要(?:导出|下载)/ }).last();
    const requiresConfirmation = await downloadConfirmDialog.waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (requiresConfirmation) {
      const confirmButton = downloadConfirmDialog.locator('.el-message-box__btns button, button')
        .filter({ hasText: /确\s*定/ }).last();
      await confirmButton.waitFor({ state: 'visible' });
      await confirmButton.click();
    }
    const download = await downloadPromise;
    const saveAs = path.join(this.config.downloadDir, `${taskName}-${label}-${download.suggestedFilename()}`);
    await download.saveAs(saveAs);
    return saveAs;
  }

  async downloadArtifacts(result: ImportResult, onCreated?: (id: string) => Promise<void>): Promise<ImportResult | undefined> {
    if (!Number.isInteger(result.total) || !Number.isInteger(result.failed) || result.total! < 0 || result.failed! < 0 || result.failed! > result.total!) throw new Error('门户数量缺失或不合法，停止生成结果。');
    if (result.succeeded !== undefined && result.succeeded + result.failed! !== result.total) throw new Error('门户成功、失败数量与总数不一致。');
    if (result.failed === 0) return result;
    const row = await this.locateTaskRow(result.taskName, result.batchId);
    if (!row) throw new Error(`未找到任务 ${result.taskName}，无法下载结果。`);
    // 只有门户明确给出失败数量时，才创建失败明细导出任务。成功批次不应产生无意义的导出任务。
    if ((result.failed ?? 0) <= 0) return result;
    // “导出” -> 确定 -> 保存导出任务批次号 -> 批量导出结果查询精确检索 -> 处理完成后下载。
    const taskId = result.failureExportBatchId ?? await this.exportFailureDetails(row, result.taskName, result.batchId, onCreated);
    if (taskId === result.batchId) throw new Error('导出任务号不能等于导入批次号。');
    const exportRow = await this.waitForExportTask(taskId);
    if (!exportRow) return undefined;
    const downloadPath = await this.downloadExportTaskFile(exportRow, result.taskName);
    return {
      ...result,
      failureExportPath: downloadPath,
      failureExportBatchId: taskId,
    };
  }
}

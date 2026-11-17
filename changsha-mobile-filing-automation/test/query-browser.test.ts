import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { MobilePortal } from '../src/portal.js';

test('query waits for delayed response instead of reading old table', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://query.test/**', async route => {
      if (route.request().url().includes('/search')) {
        await new Promise(resolve => setTimeout(resolve, 1200));
        await route.fulfill({ json: { ok: true } });
      } else await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div class="el-form-item"><label for="taskId">批次号</label><input></div><button class="el-button--primary">查询</button><div id="result">旧数据</div><script>document.querySelector('button').onclick=async()=>{await fetch('/search?taskId='+document.querySelector('input').value);document.querySelector('#result').textContent='新数据';}</script>` });
    });
    await page.goto('https://query.test/');
    const portal = Object.create(MobilePortal.prototype) as { searchTaskByBatchId(page: Page, id: string): Promise<void> };
    await portal.searchTaskByBatchId(page, '2100464370991624193');
    assert.equal(await page.locator('#result').innerText(), '新数据');
  } finally { await browser.close(); }
});

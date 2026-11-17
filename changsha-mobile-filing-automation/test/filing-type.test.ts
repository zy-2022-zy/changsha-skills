import test from 'node:test';
import assert from 'node:assert/strict';
import { filingTypeForFile, uploadNavigation } from '../src/filing-type.js';

test('file names containing 5G use the 5G upload menu and other files use the standard menu', () => {
  assert.equal(filingTypeForFile('0923-共享表-长沙5G.xlsx'), '5G');
  assert.equal(filingTypeForFile('customer-5g-1.xlsx'), '5G');
  assert.equal(filingTypeForFile('0923-普通短信.xlsx'), 'STANDARD');
  assert.deepEqual(uploadNavigation('长沙5G.xlsx'), ['5G端口上报管理', '5G端口信息报送', '5G真实端口数据管理']);
  assert.deepEqual(uploadNavigation('长沙移动.xlsx'), ['端口上报管理', '端口信息报送', '真实端口数据管理']);
});

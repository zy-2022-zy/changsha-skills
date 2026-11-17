import test from 'node:test';
import assert from 'node:assert/strict';
import { requestContainsBatch, hasExactBatch } from '../src/task-query.js';
test('batch identifiers retain precision and match complete fields', () => {
  const id = '2100464370991624193';
  assert.equal(requestContainsBatch(`https://example.test/query?taskId=${id}`, null, id), true);
  assert.equal(requestContainsBatch('https://example.test/query', `{"taskId":${id}}`, id), true);
  assert.equal(requestContainsBatch('https://example.test/query', `{"taskId":"${id}"}`, id), true);
  assert.equal(requestContainsBatch('https://example.test/query', `taskId=${id}`, id), true);
  assert.equal(requestContainsBatch('https://example.test/query', `{"taskId":"${id}0"}`, id), false);
  assert.equal(hasExactBatch([`文件-${id}`, id + '0'], id), false);
  assert.equal(hasExactBatch([' '+id+' ', '处理完成'], id), true);
});

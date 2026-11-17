import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePortalCounts } from '../src/portal-counts.js';
import { MobilePortal } from '../src/portal.js';

test('completed all-success blank failure count is zero and requires no export', async () => {
  const counts = parsePortalCounts('107', '107', '  ', true);
  assert.deepEqual(counts, {total:107,succeeded:107,failed:0});
  const portal = Object.create(MobilePortal.prototype) as MobilePortal;
  const result = {taskName:'test.xlsx', status:'处理完成', ...counts};
  assert.deepEqual(await portal.downloadArtifacts(result), result);
});

test('unknown, incomplete and invalid counts are not silently treated as success', async () => {
  for (const args of [
    ['107','106','',true], ['107','107',undefined,true], ['107','107','-',true],
    ['107','107','',false], ['107',undefined,'',true], ['107','107','-1',true],
    ['107','107','1.5',true], ['107条','107','',true],
  ] as const) {
    const counts = parsePortalCounts(args[0], args[1], args[2], args[3]);
    assert.equal(counts.failed, undefined);
    const portal = Object.create(MobilePortal.prototype) as MobilePortal;
    await assert.rejects(portal.downloadArtifacts({taskName:'test',status:'处理完成',...counts}), /数量/);
  }
  assert.deepEqual(parsePortalCounts('1,000','999','1',true), {total:1000,succeeded:999,failed:1});
  const portal = Object.create(MobilePortal.prototype) as MobilePortal;
  await assert.rejects(portal.downloadArtifacts({taskName:'test',status:'处理完成',...parsePortalCounts('107','107','1',true)}), /不一致/);
});

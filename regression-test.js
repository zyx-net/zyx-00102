const http = require('http');
const fs = require('fs');
const path = require('path');

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: data ? JSON.parse(data) : null
          });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function printTest(name, pass, detail = '') {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail && !pass) {
    console.log(`  ${detail}`);
  }
  return pass;
}

const baseOptions = {
  hostname: 'localhost',
  port: 3000,
  headers: { 'Content-Type': 'application/json' }
};

async function getBatchCount(operatorId) {
  const res = await request({
    ...baseOptions,
    path: '/api/batches',
    method: 'GET',
    headers: { ...baseOptions.headers, 'X-Operator-Id': operatorId }
  });
  return res.body.batches.length;
}

async function getBatchDetail(batchNo, operatorId) {
  const res = await request({
    ...baseOptions,
    path: `/api/batches/${batchNo}`,
    method: 'GET',
    headers: { ...baseOptions.headers, 'X-Operator-Id': operatorId }
  });
  return res.body;
}

async function main() {
  console.log('========== 药品冷链到货放行 API 回归测试 ==========\n');

  let allPass = true;
  const timestamp = Date.now();

  console.log('--- 测试组 1: 混合合法/非法批次导入（整批回滚）---\n');

  const countBefore = await getBatchCount('receiver01');
  console.log(`测试前批次数量: ${countBefore}`);

  // 1. 混合导入：前2个合法，第3个缺失 batchNo
  const mixedBatches = [
    { batchNo: `MIX-${timestamp}-01`, drugName: '合法药1', manufacturer: '药厂A', quantity: 100 },
    { batchNo: `MIX-${timestamp}-02`, drugName: '合法药2', manufacturer: '药厂B', quantity: 200 },
    { drugName: '缺批号药', manufacturer: '药厂C', quantity: 300 }
  ];

  const res1 = await request({
    ...baseOptions,
    path: '/api/batches/import',
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, mixedBatches);

  allPass &= printTest('混合导入返回 400', res1.statusCode === 400, `实际: ${res1.statusCode}`);
  allPass &= printTest('返回错误信息', res1.body.error === '预校验失败，整批回滚', `实际: ${res1.body.error}`);
  allPass &= printTest('allSuccess 为 false', res1.body.allSuccess === false);
  allPass &= printTest('第3条标记失败', res1.body.results[2].success === false && res1.body.results[2].errors?.includes('缺少批号'));

  // 关键验证：批次数量没有变化
  const countAfter1 = await getBatchCount('receiver01');
  allPass &= printTest('无半截数据 - 批次数量不变', countAfter1 === countBefore,
    `测试前: ${countBefore}, 测试后: ${countAfter1}`);

  // 2. 混合导入：存在重复批号（本次导入内重复）
  const duplicateBatches = [
    { batchNo: `DUP-${timestamp}-01`, drugName: '药1', manufacturer: '药厂A', quantity: 100 },
    { batchNo: `DUP-${timestamp}-01`, drugName: '药2', manufacturer: '药厂B', quantity: 200 }
  ];

  const res2 = await request({
    ...baseOptions,
    path: '/api/batches/import',
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, duplicateBatches);

  allPass &= printTest('本次导入内重复 - 返回 400', res2.statusCode === 400);

  const countAfter2 = await getBatchCount('receiver01');
  allPass &= printTest('无半截数据 - 批次数量不变', countAfter2 === countBefore,
    `测试前: ${countBefore}, 测试后: ${countAfter2}`);

  // 3. 混合导入：存在已存在的批号
  const existingBatches = [
    { batchNo: `NEW-${timestamp}-01`, drugName: '新药', manufacturer: '药厂A', quantity: 100 }
  ];
  await request({
    ...baseOptions,
    path: '/api/batches/import',
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, existingBatches);

  const countAfter3 = await getBatchCount('receiver01');
  allPass &= printTest('成功导入1个批次', countAfter3 === countBefore + 1);

  const conflictBatches = [
    { batchNo: `NEW-${timestamp}-02`, drugName: '另一个新药', manufacturer: '药厂B', quantity: 200 },
    { batchNo: `NEW-${timestamp}-01`, drugName: '冲突药', manufacturer: '药厂C', quantity: 300 }
  ];

  const res3 = await request({
    ...baseOptions,
    path: '/api/batches/import',
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, conflictBatches);

  allPass &= printTest('与已存在批号冲突 - 返回 400', res3.statusCode === 400);
  const countAfter4 = await getBatchCount('receiver01');
  allPass &= printTest('无半截数据 - 批次数量不变', countAfter4 === countBefore + 1,
    `预期: ${countBefore + 1}, 实际: ${countAfter4}`);

  console.log('\n--- 测试组 2: 超温导入自动隔离 ---\n');

  // 导入新批次用于测试
  const overTempBatchNo = `OT-${timestamp}-01`;
  await request({
    ...baseOptions,
    path: '/api/batches/import',
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, [{
    batchNo: overTempBatchNo,
    drugName: '超温测试药',
    manufacturer: '测试药厂',
    quantity: 100
  }]);

  // 验证初始状态
  const detailBefore = await getBatchDetail(overTempBatchNo, 'pharmacist01');
  allPass &= printTest('初始状态为 pending_review', detailBefore.batch.status === 'pending_review',
    `实际: ${detailBefore.batch.status}`);

  // 导入超温温度日志
  const overTempLogs = [
    { batchNo: overTempBatchNo, timestamp: '2024-06-01T08:00:00.000Z', temperature: 4.5 },
    { batchNo: overTempBatchNo, timestamp: '2024-06-01T08:05:00.000Z', temperature: 4.2 },
    { batchNo: overTempBatchNo, timestamp: '2024-06-01T08:10:00.000Z', temperature: 9.5 },
    { batchNo: overTempBatchNo, timestamp: '2024-06-01T08:15:00.000Z', temperature: 10.2 },
    { batchNo: overTempBatchNo, timestamp: '2024-06-01T08:20:00.000Z', temperature: 5.0 }
  ];

  const resTemp = await request({
    ...baseOptions,
    path: `/api/batches/${overTempBatchNo}/temperature/import`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, overTempLogs);

  allPass &= printTest('超温日志导入成功', resTemp.statusCode === 200);
  allPass &= printTest('autoQuarantined 为 true', resTemp.body.autoQuarantined === true);
  allPass &= printTest('返回超温区间', resTemp.body.overTempRanges.length > 0);

  // 验证批次状态已变更为 quarantined
  const detailAfter = await getBatchDetail(overTempBatchNo, 'pharmacist01');
  allPass &= printTest('超温后自动进入隔离', detailAfter.batch.status === 'quarantined',
    `实际: ${detailAfter.batch.status}`);
  allPass &= printTest('超温区间已记录', detailAfter.batch.overTempRanges.length > 0);

  // 验证审计历史包含 auto_quarantine
  const hasAutoQuarantine = detailAfter.auditLogs.some(log => log.action === 'auto_quarantine');
  allPass &= printTest('审计历史包含自动隔离记录', hasAutoQuarantine);

  // 验证有 import_temperature 记录，状态从 pending_review 到 quarantined
  const importTempLog = detailAfter.auditLogs.find(log => log.action === 'import_temperature');
  allPass &= printTest('温度导入审计状态流转正确',
    importTempLog?.fromStatus === 'pending_review' && importTempLog?.toStatus === 'quarantined',
    `from: ${importTempLog?.fromStatus}, to: ${importTempLog?.toStatus}`);

  console.log('\n--- 测试组 3: 药师复核和质管决定 ---\n');

  // 药师不能直接放行
  const pharmacistRelease = await request({
    ...baseOptions,
    path: `/api/batches/${overTempBatchNo}/finalize`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  }, { decision: 'release', reason: '药师越权' });

  allPass &= printTest('药师越权放行失败', pharmacistRelease.statusCode === 400,
    `实际: ${pharmacistRelease.statusCode}, 错误: ${pharmacistRelease.body?.error}`);

  // 验证状态未变
  const detailAfterFail = await getBatchDetail(overTempBatchNo, 'pharmacist01');
  allPass &= printTest('越权后状态不变（仍为 quarantined）',
    detailAfterFail.batch.status === 'quarantined',
    `实际: ${detailAfterFail.batch.status}`);

  // 药师复核通过（进入隔离，实际上状态已经是隔离了，但这个操作是药师的权限）
  const reviewRes = await request({
    ...baseOptions,
    path: `/api/batches/${overTempBatchNo}/review`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  }, { decision: 'pass', reason: '已复核，超温情况需质管评估' });

  // 状态已经是 quarantined，不能再次转换到 quarantined，应该失败
  allPass &= printTest('状态重复转换失败', reviewRes.statusCode === 400);

  // 质管负责人放行
  const releaseRes = await request({
    ...baseOptions,
    path: `/api/batches/${overTempBatchNo}/finalize`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  }, { decision: 'release', reason: '超温时间短，评估后放行' });

  allPass &= printTest('质管放行成功', releaseRes.statusCode === 200);

  const detailReleased = await getBatchDetail(overTempBatchNo, 'quality01');
  allPass &= printTest('状态已变更为 released', detailReleased.batch.status === 'released',
    `实际: ${detailReleased.batch.status}`);

  console.log('\n--- 测试组 4: 失败场景无半截数据 ---\n');

  // 新批次用于失败测试
  const failBatchNo = `FAIL-${timestamp}-01`;
  await request({
    ...baseOptions,
    path: '/api/batches/import',
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, [{
    batchNo: failBatchNo,
    drugName: '失败测试药',
    manufacturer: '测试药厂',
    quantity: 50
  }]);

  const countBeforeTemp = await getBatchCount('receiver01');

  // 测试时间倒序
  const outOfOrderLogs = [
    { batchNo: failBatchNo, timestamp: '2024-06-01T08:00:00.000Z', temperature: 4.0 },
    { batchNo: failBatchNo, timestamp: '2024-06-01T08:05:00.000Z', temperature: 4.5 },
    { batchNo: failBatchNo, timestamp: '2024-06-01T08:03:00.000Z', temperature: 4.2 }
  ];

  const resOutOfOrder = await request({
    ...baseOptions,
    path: `/api/batches/${failBatchNo}/temperature/import`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, outOfOrderLogs);

  allPass &= printTest('时间倒序导入失败', resOutOfOrder.statusCode === 400);

  // 验证温度日志为空
  const detailAfterFail2 = await getBatchDetail(failBatchNo, 'receiver01');
  allPass &= printTest('失败后温度日志为空',
    (detailAfterFail2.temperatureLogs?.length || 0) === 0,
    `实际: ${detailAfterFail2.temperatureLogs?.length || 0}`);
  allPass &= printTest('失败后状态不变',
    detailAfterFail2.batch.status === 'pending_review',
    `实际: ${detailAfterFail2.batch.status}`);
  allPass &= printTest('失败后批次数量不变',
    await getBatchCount('receiver01') === countBeforeTemp);

  // 测试缺失温度段
  const gapLogs = [
    { batchNo: failBatchNo, timestamp: '2024-06-01T08:00:00.000Z', temperature: 4.0 },
    { batchNo: failBatchNo, timestamp: '2024-06-01T08:05:00.000Z', temperature: 4.5 },
    { batchNo: failBatchNo, timestamp: '2024-06-01T09:30:00.000Z', temperature: 4.8 }
  ];

  const resGap = await request({
    ...baseOptions,
    path: `/api/batches/${failBatchNo}/temperature/import`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, gapLogs);

  allPass &= printTest('缺失温度段导入失败', resGap.statusCode === 400);

  const detailAfterFail3 = await getBatchDetail(failBatchNo, 'receiver01');
  allPass &= printTest('失败后温度日志仍为空',
    (detailAfterFail3.temperatureLogs?.length || 0) === 0);

  // 测试批号不匹配
  const mismatchLogs = [
    { batchNo: 'WRONG-BATCH', timestamp: '2024-06-01T08:00:00.000Z', temperature: 4.0 },
    { batchNo: failBatchNo, timestamp: '2024-06-01T08:05:00.000Z', temperature: 4.5 }
  ];

  const resMismatch = await request({
    ...baseOptions,
    path: `/api/batches/${failBatchNo}/temperature/import`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, mismatchLogs);

  allPass &= printTest('批号不匹配导入失败', resMismatch.statusCode === 400);

  const detailAfterFail4 = await getBatchDetail(failBatchNo, 'receiver01');
  allPass &= printTest('失败后温度日志仍为空',
    (detailAfterFail4.temperatureLogs?.length || 0) === 0);

  console.log('\n--- 测试组 5: 正常温度不自动隔离 ---\n');

  const normalBatchNo = `NRM-${timestamp}-01`;
  await request({
    ...baseOptions,
    path: '/api/batches/import',
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, [{
    batchNo: normalBatchNo,
    drugName: '常温药',
    manufacturer: '测试药厂',
    quantity: 200
  }]);

  const normalLogs = [];
  const baseTime = new Date('2024-06-01T08:00:00.000Z').getTime();
  for (let i = 0; i < 10; i++) {
    normalLogs.push({
      batchNo: normalBatchNo,
      timestamp: new Date(baseTime + i * 5 * 60 * 1000).toISOString(),
      temperature: 4.0 + Math.random() * 2
    });
  }

  const resNormal = await request({
    ...baseOptions,
    path: `/api/batches/${normalBatchNo}/temperature/import`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, normalLogs);

  allPass &= printTest('正常温度导入成功', resNormal.statusCode === 200);
  allPass &= printTest('autoQuarantined 为 false', resNormal.body.autoQuarantined === false);
  allPass &= printTest('状态保持 pending_review',
    (await getBatchDetail(normalBatchNo, 'receiver01')).batch.status === 'pending_review');

  console.log('\n--- 测试组 6: 保存重启前状态 ---\n');

  const stateToVerify = {
    overTempBatchNo,
    releasedStatus: detailReleased.batch.status,
    releasedTempCount: detailReleased.temperatureLogs?.length || 0,
    releasedAuditCount: detailReleased.auditLogs?.length || 0,
    normalBatchNo,
    normalStatus: (await getBatchDetail(normalBatchNo, 'receiver01')).batch.status,
    normalTempCount: (await getBatchDetail(normalBatchNo, 'receiver01')).temperatureLogs?.length || 0,
    failBatchNo,
    failStatus: detailAfterFail4.batch.status,
    failTempCount: detailAfterFail4.temperatureLogs?.length || 0,
    batchCount: await getBatchCount('receiver01')
  };

  fs.writeFileSync(
    path.join(__dirname, 'data', 'pre-restart-state.json'),
    JSON.stringify(stateToVerify, null, 2)
  );

  console.log('重启前状态已保存到 data/pre-restart-state.json');
  console.log(`  批次总数: ${stateToVerify.batchCount}`);
  console.log(`  ${overTempBatchNo}: ${stateToVerify.releasedStatus}, 温度日志: ${stateToVerify.releasedTempCount}, 审计: ${stateToVerify.releasedAuditCount}`);
  console.log(`  ${normalBatchNo}: ${stateToVerify.normalStatus}, 温度日志: ${stateToVerify.normalTempCount}`);
  console.log(`  ${failBatchNo}: ${stateToVerify.failStatus}, 温度日志: ${stateToVerify.failTempCount}`);

  console.log('\n========================================');
  console.log(allPass ? '全部回归测试通过！' : '部分测试失败！');
  console.log('========================================');
  console.log('\n请重启服务后运行 node regression-test-verify.js 验证数据一致性');

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('测试出错:', err.message);
  console.error(err.stack);
  process.exit(1);
});

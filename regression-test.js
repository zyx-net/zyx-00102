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

  console.log('\n--- 测试组 6: 温控偏差处置单 - 创建与提交 ---\n');

  const dispBatchNo = `DISP-${timestamp}-01`;
  await request({
    ...baseOptions,
    path: '/api/batches/import',
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, [{
    batchNo: dispBatchNo,
    drugName: '处置单测试药',
    manufacturer: '测试药厂',
    quantity: 150
  }]);

  const dispOverTempLogs = [
    { batchNo: dispBatchNo, timestamp: '2024-06-01T08:00:00.000Z', temperature: 4.5 },
    { batchNo: dispBatchNo, timestamp: '2024-06-01T08:05:00.000Z', temperature: 4.2 },
    { batchNo: dispBatchNo, timestamp: '2024-06-01T08:10:00.000Z', temperature: 9.5 },
    { batchNo: dispBatchNo, timestamp: '2024-06-01T08:15:00.000Z', temperature: 10.2 },
    { batchNo: dispBatchNo, timestamp: '2024-06-01T08:20:00.000Z', temperature: 5.0 }
  ];

  await request({
    ...baseOptions,
    path: `/api/batches/${dispBatchNo}/temperature/import`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, dispOverTempLogs);

  const dispDetail0 = await getBatchDetail(dispBatchNo, 'pharmacist01');
  allPass &= printTest('处置单测试批次已隔离', dispDetail0.batch.status === 'quarantined');

  const createNoPerm = await request({
    ...baseOptions,
    path: `/api/batches/${dispBatchNo}/dispositions`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, { deviationLevel: 'moderate', cause: '测试越权', suggestedAction: '放行' });
  allPass &= printTest('收货员越权创建处置单被拒', createNoPerm.statusCode === 400,
    `实际: ${createNoPerm.statusCode}, 错误: ${createNoPerm.body?.error}`);

  const createNoPerm2 = await request({
    ...baseOptions,
    path: `/api/batches/${dispBatchNo}/dispositions`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  }, { deviationLevel: 'moderate', cause: '测试越权', suggestedAction: '放行' });
  allPass &= printTest('质管越权创建处置单被拒', createNoPerm2.statusCode === 400,
    `实际: ${createNoPerm2.statusCode}, 错误: ${createNoPerm2.body?.error}`);

  const createNonQuarantine = await request({
    ...baseOptions,
    path: `/api/batches/${normalBatchNo}/dispositions`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  }, { deviationLevel: 'moderate', cause: '测试', suggestedAction: '放行' });
  allPass &= printTest('非隔离状态批次无法创建处置单', createNonQuarantine.statusCode === 400);

  const createRes = await request({
    ...baseOptions,
    path: `/api/batches/${dispBatchNo}/dispositions`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  }, {
    deviationLevel: 'moderate',
    cause: '冷链箱中途断电10分钟导致温度超标',
    suggestedAction: '评估影响范围后可放行',
    attachmentSummary: '冷链箱断电记录.pdf、温度曲线截图.png'
  });
  allPass &= printTest('药师成功创建处置单', createRes.statusCode === 201,
    `实际: ${createRes.statusCode}, 错误: ${createRes.body?.error}`);
  allPass &= printTest('处置单初始状态为 draft', createRes.body.disposition.status === 'draft');
  allPass &= printTest('处置单包含超温区间', (createRes.body.disposition.overTempRanges?.length || 0) > 0);

  const dispositionId = createRes.body.disposition.id;
  allPass &= printTest('处置单 ID 格式正确', dispositionId.startsWith('DISP-'));

  const createDup = await request({
    ...baseOptions,
    path: `/api/batches/${dispBatchNo}/dispositions`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  }, { deviationLevel: 'minor', cause: '重复', suggestedAction: '放行' });
  allPass &= printTest('同批次重复创建处置单返回冲突', createDup.statusCode === 409,
    `实际: ${createDup.statusCode}`);
  allPass &= printTest('冲突响应包含 existingDispositionId', !!createDup.body?.existingDispositionId);

  const submitIncomplete = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}/submit`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  });
  allPass &= printTest('草稿处置单提交成功（数据已完整）', submitIncomplete.statusCode === 200,
    `实际: ${submitIncomplete.statusCode}, 错误: ${submitIncomplete.body?.error}`);
  allPass &= printTest('提交后状态为 pending_approval', submitIncomplete.body.disposition.status === 'pending_approval');

  const detailDisp1 = await getBatchDetail(dispBatchNo, 'pharmacist01');
  allPass &= printTest('批次详情包含处置单列表', Array.isArray(detailDisp1.dispositions));
  allPass &= printTest('批次详情 activeDisposition 正确',
    detailDisp1.activeDisposition?.id === dispositionId && detailDisp1.activeDisposition?.status === 'pending_approval');

  console.log('\n--- 测试组 7: 温控偏差处置单 - 退回补充与重新提交 ---\n');

  const returnNoPerm = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}/return`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  }, { returnReason: '越权退回' });
  allPass &= printTest('药师越权退回被拒', returnNoPerm.statusCode === 400);

  const returnNoReason = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}/return`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  }, { returnReason: '' });
  allPass &= printTest('退回无原因被拒', returnNoReason.statusCode === 400);

  const returnRes = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}/return`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  }, { returnReason: '请补充断电时间段的仓库环境温度记录和同批次其他箱子温度数据' });
  allPass &= printTest('质管退回补充成功', returnRes.statusCode === 200,
    `实际: ${returnRes.statusCode}, 错误: ${returnRes.body?.error}`);
  allPass &= printTest('退回后状态为 returned_for_supplement',
    returnRes.body.disposition.status === 'returned_for_supplement');
  allPass &= printTest('退回原因已记录',
    returnRes.body.disposition.returnReason?.includes('仓库环境温度'));

  const updateNoPerm = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}`,
    method: 'PUT',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  }, { cause: '越权修改' });
  allPass &= printTest('质管越权更新处置单被拒', updateNoPerm.statusCode === 400);

  const updateRes = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}`,
    method: 'PUT',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  }, {
    cause: '冷链箱中途断电10分钟导致温度超标，仓库同期温度记录显示环境温度正常',
    suggestedAction: '评估影响范围后可放行，已补充仓库温度记录',
    attachmentSummary: '冷链箱断电记录.pdf、温度曲线截图.png、仓库环境温度记录.xlsx'
  });
  allPass &= printTest('药师补充更新处置单成功', updateRes.statusCode === 200,
    `实际: ${updateRes.statusCode}, 错误: ${updateRes.body?.error}`);
  const versionAfterUpdate = updateRes.body.disposition.version;
  allPass &= printTest('更新后版本号递增', versionAfterUpdate > 1);

  const updateConflict = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}`,
    method: 'PUT',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  }, { expectedVersion: 1, cause: '旧版本冲突测试' });
  allPass &= printTest('版本冲突返回 409', updateConflict.statusCode === 409);

  const resubmitRes = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}/submit`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  });
  allPass &= printTest('补充后重新提交成功', resubmitRes.statusCode === 200);
  allPass &= printTest('重新提交后状态为 pending_approval',
    resubmitRes.body.disposition.status === 'pending_approval');

  console.log('\n--- 测试组 8: 温控偏差处置单 - 最终审批与状态联动 ---\n');

  const approveNoPerm = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}/approve`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  }, { decision: 'release' });
  allPass &= printTest('药师越权审批被拒', approveNoPerm.statusCode === 400);

  const approveInvalid = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}/approve`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  }, { decision: 'invalid_decision' });
  allPass &= printTest('无效审批决定被拒', approveInvalid.statusCode === 400);

  const approveRes = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}/approve`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  }, { decision: 'release', reason: '超温时间短，影响有限，同意放行' });
  allPass &= printTest('质管审批放行成功', approveRes.statusCode === 200,
    `实际: ${approveRes.statusCode}, 错误: ${approveRes.body?.error}`);
  allPass &= printTest('处置单状态变为 closed', approveRes.body.disposition.status === 'closed');
  allPass &= printTest('处置单记录最终结论 release', approveRes.body.disposition.finalDecision === 'release');
  allPass &= printTest('批次状态同步变更为 released', approveRes.body.batch.status === 'released');
  allPass &= printTest('批次记录 dispositionId', approveRes.body.batch.dispositionId === dispositionId);
  allPass &= printTest('批次记录 dispositionDecision', approveRes.body.batch.dispositionDecision === 'release');

  const detailFinal = await getBatchDetail(dispBatchNo, 'quality01');
  allPass &= printTest('批次详情状态最终为 released', detailFinal.batch.status === 'released');
  allPass &= printTest('处置单状态与批次状态一致（均已完成）',
    detailFinal.activeDisposition === null || detailFinal.activeDisposition === undefined);

  const auditLogs = detailFinal.auditLogs || [];
  const hasDispCreate = auditLogs.some(l => l.action === 'disposition_create');
  const hasDispSubmit = auditLogs.some(l => l.action === 'disposition_submit');
  const hasDispReturn = auditLogs.some(l => l.action === 'disposition_return_supplement');
  const hasDispApprove = auditLogs.some(l => l.action === 'disposition_approve_release');
  const hasReleaseAction = auditLogs.some(l => l.action === 'release');
  allPass &= printTest('审计日志包含 disposition_create', hasDispCreate);
  allPass &= printTest('审计日志包含 disposition_submit', hasDispSubmit);
  allPass &= printTest('审计日志包含 disposition_return_supplement', hasDispReturn);
  allPass &= printTest('审计日志包含 disposition_approve_release', hasDispApprove);
  allPass &= printTest('审计日志包含 release（批次状态变更）', hasReleaseAction);

  console.log('\n--- 测试组 9: 温控偏差处置单 - 拒收流程 & 导出 ---\n');

  const rejectBatchNo = `DISP-${timestamp}-02`;
  await request({
    ...baseOptions,
    path: '/api/batches/import',
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, [{
    batchNo: rejectBatchNo,
    drugName: '拒收处置单测试药',
    manufacturer: '测试药厂',
    quantity: 80
  }]);

  await request({
    ...baseOptions,
    path: `/api/batches/${rejectBatchNo}/temperature/import`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  }, dispOverTempLogs.map(l => ({ ...l, batchNo: rejectBatchNo })));

  const createRejectRes = await request({
    ...baseOptions,
    path: `/api/batches/${rejectBatchNo}/dispositions`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  }, {
    deviationLevel: 'major',
    cause: '冷链运输全程温度超标超过2小时',
    suggestedAction: '拒收',
    attachmentSummary: '全程温度超标报告.pdf'
  });
  const rejectDispositionId = createRejectRes.body.disposition.id;

  await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${rejectDispositionId}/submit`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  });

  const approveRejectRes = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${rejectDispositionId}/approve`,
    method: 'POST',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  }, { decision: 'reject', reason: '全程超标，药品质量无法保证，予以拒收' });
  allPass &= printTest('质管审批拒收成功', approveRejectRes.statusCode === 200);
  allPass &= printTest('拒收处置单 finalDecision 为 reject',
    approveRejectRes.body.disposition.finalDecision === 'reject');
  allPass &= printTest('拒收批次状态同步为 rejected', approveRejectRes.body.batch.status === 'rejected');

  const exportJsonRes = await request({
    ...baseOptions,
    path: `/api/batches/${dispBatchNo}/export?format=json`,
    method: 'GET',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  });
  const exportJson = exportJsonRes.body;
  allPass &= printTest('JSON 导出包含 dispositions 字段', Array.isArray(exportJson.dispositions));
  allPass &= printTest('JSON 导出处置单数量正确', exportJson.dispositions.length >= 1);
  allPass &= printTest('JSON 导出批次含 dispositionId', !!exportJson.batch.dispositionId);
  allPass &= printTest('JSON 导出批次含 dispositionDecision', !!exportJson.batch.dispositionDecision);
  const exportedDisp = exportJson.dispositions.find(d => d.id === dispositionId);
  allPass &= printTest('JSON 导出处置单含 finalDecision', exportedDisp?.finalDecision === 'release');
  allPass &= printTest('JSON 导出处置单含 approvalReason', !!exportedDisp?.approvalReason);

  const exportCsvRes = await request({
    ...baseOptions,
    path: `/api/batches/${dispBatchNo}/export?format=csv`,
    method: 'GET',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01', 'Accept': 'text/csv' }
  });
  const csvStr = typeof exportCsvRes.body === 'string' ? exportCsvRes.body : JSON.stringify(exportCsvRes.body);
  allPass &= printTest('CSV 导出包含处置单段', csvStr.includes('# 温控偏差处置单'));
  allPass &= printTest('CSV 导出包含处置单 ID', csvStr.includes(dispositionId));
  allPass &= printTest('CSV 导出包含 finalDecision', csvStr.includes('release'));
  allPass &= printTest('CSV 导出批次信息含 dispositionId 列', csvStr.includes('dispositionId'));
  allPass &= printTest('CSV 导出批次信息含 dispositionDecision 列', csvStr.includes('dispositionDecision'));

  const dispListRes = await request({
    ...baseOptions,
    path: '/api/batches/dispositions',
    method: 'GET',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  });
  allPass &= printTest('处置单列表接口可用', dispListRes.statusCode === 200 && Array.isArray(dispListRes.body.dispositions));
  allPass &= printTest('处置单列表包含刚创建的处置单',
    dispListRes.body.dispositions.some(d => d.id === dispositionId));

  const dispGetRes = await request({
    ...baseOptions,
    path: `/api/batches/dispositions/${dispositionId}`,
    method: 'GET',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01' }
  });
  allPass &= printTest('收货员可查看处置单（view 权限）', dispGetRes.statusCode === 200);

  const batchDispListRes = await request({
    ...baseOptions,
    path: `/api/batches/${dispBatchNo}/dispositions`,
    method: 'GET',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'pharmacist01' }
  });
  allPass &= printTest('按批次查询处置单列表可用', batchDispListRes.statusCode === 200);
  allPass &= printTest('按批次查询处置单数量正确',
    (batchDispListRes.body.dispositions || []).length >= 1);

  console.log('\n--- 测试组 10: 保存重启前状态 ---\n');

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
    batchCount: await getBatchCount('receiver01'),
    dispBatchNo,
    dispDispositionId: dispositionId,
    dispBatchStatus: detailFinal.batch.status,
    dispFinalDecision: 'release',
    dispVersion: versionAfterUpdate,
    rejectBatchNo,
    rejectDispositionId,
    rejectBatchStatus: approveRejectRes.body.batch.status,
    rejectFinalDecision: 'reject'
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
  console.log(`  [放行处置单] ${dispBatchNo}: 处置单=${dispositionId}, 批次状态=${stateToVerify.dispBatchStatus}, 结论=${stateToVerify.dispFinalDecision}`);
  console.log(`  [拒收处置单] ${rejectBatchNo}: 处置单=${rejectDispositionId}, 批次状态=${stateToVerify.rejectBatchStatus}, 结论=${stateToVerify.rejectFinalDecision}`);

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

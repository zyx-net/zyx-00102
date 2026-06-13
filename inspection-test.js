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
          resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : null });
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
  port: parseInt(process.env.PORT) || 3000,
  headers: { 'Content-Type': 'application/json' }
};

const headers = (operatorId) => ({ ...baseOptions.headers, 'X-Operator-Id': operatorId });

async function importBatch(batchNo, operatorId) {
  const res = await request({
    ...baseOptions, path: '/api/batches/import', method: 'POST',
    headers: headers(operatorId)
  }, [{
    batchNo,
    drugName: '测试药品',
    manufacturer: '测试药厂',
    quantity: 100,
    unit: '盒',
    productionDate: '2024-01-01',
    expiryDate: '2026-12-31'
  }]);
  return res;
}

async function createInspection(batchNo, operatorId) {
  const deadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await request({
    ...baseOptions, path: '/api/inspections', method: 'POST',
    headers: headers(operatorId)
  }, {
    batchNo,
    inspectionItems: [
      { name: '外观性状', criteria: '应为白色粉末', method: '目视检查' },
      { name: '装量差异', criteria: '±5%以内', method: '称重法' },
      { name: '含量测定', criteria: '95.0%~105.0%', method: 'HPLC' }
    ],
    sampleQuantity: 20,
    sampleUnit: '盒',
    deadline
  });
  return res;
}

async function submitResult(inspectionId, operatorId, expectedVersion = undefined) {
  const res = await request({
    ...baseOptions, path: `/api/inspections/${inspectionId}/submit`, method: 'PUT',
    headers: headers(operatorId)
  }, {
    items: [
      { name: '外观性状', result: '白色粉末，无异味', passed: true, remark: '符合规定' },
      { name: '装量差异', result: '平均差异+2.3%', passed: true },
      { name: '含量测定', result: '99.2%', passed: true }
    ],
    conclusion: '全部项目合格',
    expectedVersion
  });
  return res;
}

async function approveInspection(inspectionId, operatorId, expectedVersion = undefined) {
  const res = await request({
    ...baseOptions, path: `/api/inspections/${inspectionId}/approve`, method: 'POST',
    headers: headers(operatorId)
  }, {
    reason: '检测结果符合标准，同意通过',
    conclusion: '抽检合格，准予放行',
    expectedVersion
  });
  return res;
}

async function returnInspection(inspectionId, operatorId, expectedVersion = undefined) {
  const res = await request({
    ...baseOptions, path: `/api/inspections/${inspectionId}/return`, method: 'POST',
    headers: headers(operatorId)
  }, {
    reason: '含量测定数据不完整，请补充原始色谱图',
    expectedVersion
  });
  return res;
}

async function main() {
  console.log('========== 到货抽检任务模块回归测试 ==========\n');
  let allPass = true;
  const timestamp = Date.now();
  const batchNo = `BATCH-INS-${timestamp}`;
  const batchNo2 = `BATCH-INS2-${timestamp}`;

  console.log('--- 前置准备：导入测试批次 ---\n');

  const importRes = await importBatch(batchNo, 'receiver01');
  allPass &= printTest('收货员导入批次成功', importRes.statusCode === 200,
    `实际: ${importRes.statusCode}`);
  allPass &= printTest('导入返回 success: true', importRes.body?.success === true);

  const importRes2 = await importBatch(batchNo2, 'receiver01');
  allPass &= printTest('导入第二个批次成功', importRes2.statusCode === 200);

  const batchNo3 = `BATCH-INS3-${timestamp}`;
  const importRes3 = await importBatch(batchNo3, 'receiver01');
  allPass &= printTest('导入第三个批次成功', importRes3.statusCode === 200);

  console.log('\n--- 测试组 1: 权限控制 ---\n');

  const receiverCreate = await createInspection(batchNo, 'receiver01');
  allPass &= printTest('收货员创建抽检任务被拒', receiverCreate.statusCode === 400,
    `实际: ${receiverCreate.statusCode}, 错误: ${receiverCreate.body?.error}`);

  const pharmacistCreate = await createInspection(batchNo, 'pharmacist01');
  allPass &= printTest('药师创建抽检任务被拒', pharmacistCreate.statusCode === 400,
    `实际: ${pharmacistCreate.statusCode}, 错误: ${pharmacistCreate.body?.error}`);

  const qmCreate = await createInspection(batchNo, 'quality01');
  allPass &= printTest('质管创建抽检任务成功', qmCreate.statusCode === 201,
    `实际: ${qmCreate.statusCode}`);
  allPass &= printTest('任务 ID 格式正确', qmCreate.body.inspection.id.startsWith('INS-'));
  allPass &= printTest('初始状态为 pending', qmCreate.body.inspection.status === 'pending');
  allPass &= printTest('初始版本号为 1', qmCreate.body.inspection.version === 1);
  allPass &= printTest('抽检项目数量正确', qmCreate.body.inspection.inspectionItems.length === 3);

  const inspectionId = qmCreate.body.inspection.id;
  console.log(`  创建的抽检任务 ID: ${inspectionId}`);

  console.log('\n--- 测试组 2: 重复未完成任务冲突 ---\n');

  const duplicateCreate = await createInspection(batchNo, 'quality01');
  allPass &= printTest('同一批次重复创建未完成任务返回 409', duplicateCreate.statusCode === 409,
    `实际: ${duplicateCreate.statusCode}`);
  allPass &= printTest('返回 conflict 标识', duplicateCreate.body.conflict === true);
  allPass &= printTest('返回已存在的任务 ID', duplicateCreate.body.conflictId === inspectionId);

  console.log('\n--- 测试组 3: 查看权限与列表 ---\n');

  const receiverList = await request({
    ...baseOptions, path: '/api/inspections', method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('收货员可查看抽检任务列表', receiverList.statusCode === 200,
    `实际: ${receiverList.statusCode}`);
  allPass &= printTest('列表至少包含1条记录', receiverList.body.inspections.length >= 1);

  const batchList = await request({
    ...baseOptions, path: `/api/inspections/batch/${batchNo}`, method: 'GET',
    headers: headers('pharmacist01')
  });
  allPass &= printTest('按批次查询抽检任务成功', batchList.statusCode === 200);
  allPass &= printTest('按批次查询结果数量正确', batchList.body.inspections.length === 1);

  const detailRes = await request({
    ...baseOptions, path: `/api/inspections/${inspectionId}`, method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('查看抽检详情成功', detailRes.statusCode === 200);
  allPass &= printTest('详情包含 inspection 字段', detailRes.body.inspection !== undefined);
  allPass &= printTest('详情包含 auditLogs 字段', Array.isArray(detailRes.body.auditLogs));
  allPass &= printTest('审计日志至少有1条（创建记录）', detailRes.body.auditLogs.length >= 1);
  allPass &= printTest('审计日志包含创建动作',
    detailRes.body.auditLogs.some(l => l.action === 'inspection_create'));

  const auditRes = await request({
    ...baseOptions, path: `/api/inspections/${inspectionId}/audit`, method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('查看审计记录成功', auditRes.statusCode === 200);
  allPass &= printTest('审计日志数组存在', Array.isArray(auditRes.body.auditLogs));

  console.log('\n--- 测试组 4: 提交检测结果权限与状态流转 ---\n');

  const receiverSubmit = await submitResult(inspectionId, 'receiver01');
  allPass &= printTest('收货员提交检测结果被拒', receiverSubmit.statusCode === 400,
    `实际: ${receiverSubmit.statusCode}, 错误: ${receiverSubmit.body?.error}`);

  const pharmacistSubmit = await submitResult(inspectionId, 'pharmacist01');
  allPass &= printTest('药师提交检测结果成功', pharmacistSubmit.statusCode === 200,
    `实际: ${pharmacistSubmit.statusCode}`);
  allPass &= printTest('提交后状态为 submitted', pharmacistSubmit.body.inspection.status === 'submitted');
  allPass &= printTest('版本号增加到 2', pharmacistSubmit.body.inspection.version === 2);
  allPass &= printTest('检测结果已保存',
    pharmacistSubmit.body.inspection.inspectionItems.every(item => item.result !== ''));
  allPass &= printTest('整体合格判定为 true', pharmacistSubmit.body.inspection.overallPassed === true);
  allPass &= printTest('提交人信息正确', pharmacistSubmit.body.inspection.submittedBy === 'pharmacist01');

  console.log('\n--- 测试组 5: 状态不允许流转 ---\n');

  const submitAgain = await submitResult(inspectionId, 'pharmacist01');
  allPass &= printTest('已提交状态再次提交返回错误', submitAgain.statusCode === 400,
    `实际: ${submitAgain.statusCode}`);
  allPass &= printTest('返回 invalidStatus 标识', submitAgain.body.invalidStatus === true);

  console.log('\n--- 测试组 6: 质管确认与退回 ---\n');

  const pharmacistApprove = await approveInspection(inspectionId, 'pharmacist01');
  allPass &= printTest('药师确认抽检被拒', pharmacistApprove.statusCode === 400,
    `实际: ${pharmacistApprove.statusCode}`);

  const qmReturn = await returnInspection(inspectionId, 'quality01');
  allPass &= printTest('质管退回抽检成功', qmReturn.statusCode === 200,
    `实际: ${qmReturn.statusCode}`);
  allPass &= printTest('退回后状态为 returned', qmReturn.body.inspection.status === 'returned');
  allPass &= printTest('版本号增加到 3', qmReturn.body.inspection.version === 3);
  allPass &= printTest('退回原因已保存', qmReturn.body.inspection.returnReason !== '');
  allPass &= printTest('退回人信息正确', qmReturn.body.inspection.returnedBy === 'quality01');

  const pharmacistResubmit = await submitResult(inspectionId, 'pharmacist01');
  allPass &= printTest('退回后药师可重新提交', pharmacistResubmit.statusCode === 200);
  allPass &= printTest('重新提交后状态为 submitted', pharmacistResubmit.body.inspection.status === 'submitted');
  allPass &= printTest('版本号增加到 4', pharmacistResubmit.body.inspection.version === 4);

  const qmApprove = await approveInspection(inspectionId, 'quality01');
  allPass &= printTest('质管确认通过成功', qmApprove.statusCode === 200);
  allPass &= printTest('确认后状态为 approved', qmApprove.body.inspection.status === 'approved');
  allPass &= printTest('版本号增加到 5', qmApprove.body.inspection.version === 5);
  allPass &= printTest('确认人信息正确', qmApprove.body.inspection.approvedBy === 'quality01');

  const approveAgain = await approveInspection(inspectionId, 'quality01');
  allPass &= printTest('已通过状态再次确认返回错误', approveAgain.statusCode === 400);
  allPass &= printTest('返回 invalidStatus 标识', approveAgain.body.invalidStatus === true);

  const returnAfterApproved = await returnInspection(inspectionId, 'quality01');
  allPass &= printTest('已通过状态退回返回错误', returnAfterApproved.statusCode === 400);
  allPass &= printTest('返回 invalidStatus 标识', returnAfterApproved.body.invalidStatus === true);

  const submitAfterApproved = await submitResult(inspectionId, 'pharmacist01');
  allPass &= printTest('已通过状态提交结果返回错误', submitAfterApproved.statusCode === 400);
  allPass &= printTest('返回 invalidStatus 标识', submitAfterApproved.body.invalidStatus === true);

  console.log('\n--- 测试组 7: 版本号冲突（expectedVersion） ---\n');

  const inspection2Res = await createInspection(batchNo2, 'quality01');
  const inspection2Id = inspection2Res.body.inspection.id;

  const submitWithOldVersion = await submitResult(inspection2Id, 'pharmacist01', 999);
  allPass &= printTest('版本不匹配提交返回 409', submitWithOldVersion.statusCode === 409,
    `实际: ${submitWithOldVersion.statusCode}`);
  allPass &= printTest('返回 conflict 标识', submitWithOldVersion.body.conflict === true);
  allPass &= printTest('返回当前版本号', submitWithOldVersion.body.currentVersion !== undefined);
  allPass &= printTest('当前版本号为 1', submitWithOldVersion.body.currentVersion === 1);

  const submitWithCorrectVersion = await submitResult(inspection2Id, 'pharmacist01', 1);
  allPass &= printTest('版本匹配提交成功', submitWithCorrectVersion.statusCode === 200);
  allPass &= printTest('提交后版本号为 2', submitWithCorrectVersion.body.inspection.version === 2);

  const returnWithOldVersion = await returnInspection(inspection2Id, 'quality01', 1);
  allPass &= printTest('退回时版本不匹配返回 409', returnWithOldVersion.statusCode === 409);
  allPass &= printTest('返回当前版本号 2', returnWithOldVersion.body.currentVersion === 2);

  const returnWithCorrectVersion = await returnInspection(inspection2Id, 'quality01', 2);
  allPass &= printTest('退回时版本匹配成功', returnWithCorrectVersion.statusCode === 200);
  allPass &= printTest('退回后版本号为 3', returnWithCorrectVersion.body.inspection.version === 3);

  console.log('\n--- 测试组 8: 退回必须填写原因 ---\n');

  const inspection3Res = await createInspection(batchNo3, 'quality01');
  const inspection3Id = inspection3Res.body.inspection.id;
  await submitResult(inspection3Id, 'pharmacist01');

  const returnNoReason = await request({
    ...baseOptions, path: `/api/inspections/${inspection3Id}/return`, method: 'POST',
    headers: headers('quality01')
  }, { reason: '' });
  allPass &= printTest('退回未填原因返回错误', returnNoReason.statusCode === 400);
  allPass &= printTest('错误信息包含原因相关提示',
    returnNoReason.body.error?.includes('原因') || returnNoReason.body.error?.includes('reason'));

  console.log('\n--- 测试组 9: 批次不存在时创建任务 ---\n');

  const createForNonExistentBatch = await createInspection('NONEXISTENT-BATCH', 'quality01');
  allPass &= printTest('批次不存在时创建任务失败', createForNonExistentBatch.statusCode === 400);
  allPass &= printTest('错误信息提及批次不存在',
    createForNonExistentBatch.body.error?.includes('不存在'));

  console.log('\n--- 测试组 10: JSON/CSV 导出 ---\n');

  const jsonExportAll = await request({
    ...baseOptions, path: '/api/inspections/export/all?format=json', method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('JSON 全部导出成功', jsonExportAll.statusCode === 200);
  allPass &= printTest('JSON 导出包含 inspections 数组',
    typeof jsonExportAll.body === 'object' && Array.isArray(jsonExportAll.body.inspections));
  allPass &= printTest('JSON 导出至少有2条记录', jsonExportAll.body.inspections.length >= 2);

  const csvExportAll = await request({
    ...baseOptions, path: '/api/inspections/export/all?format=csv', method: 'GET',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'receiver01', 'Accept': 'text/csv' }
  });
  allPass &= printTest('CSV 全部导出成功', csvExportAll.statusCode === 200);
  allPass &= printTest('CSV 导出内容为字符串', typeof csvExportAll.body === 'string');
  allPass &= printTest('CSV 包含表头行', csvExportAll.body.includes('id') && csvExportAll.body.includes('batchNo'));

  const jsonExportDetail = await request({
    ...baseOptions, path: `/api/inspections/export/${inspectionId}?format=json`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('JSON 详情导出成功', jsonExportDetail.statusCode === 200);
  allPass &= printTest('JSON 详情包含 inspection 字段', jsonExportDetail.body.inspection !== undefined);
  allPass &= printTest('JSON 详情包含 auditLogs 字段', Array.isArray(jsonExportDetail.body.auditLogs));

  const csvExportDetail = await request({
    ...baseOptions, path: `/api/inspections/export/${inspectionId}?format=csv`, method: 'GET',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  });
  allPass &= printTest('CSV 详情导出成功', csvExportDetail.statusCode === 200);
  allPass &= printTest('CSV 详情包含基本信息段', csvExportDetail.body.includes('# 抽检任务基本信息'));
  allPass &= printTest('CSV 详情包含项目明细段', csvExportDetail.body.includes('# 抽检项目明细'));
  allPass &= printTest('CSV 详情包含审计记录段', csvExportDetail.body.includes('# 审计记录'));

  console.log('\n--- 测试组 11: 审计记录完整性 ---\n');

  const finalDetail = await request({
    ...baseOptions, path: `/api/inspections/${inspectionId}`, method: 'GET',
    headers: headers('quality01')
  });
  const auditLogs = finalDetail.body.auditLogs;
  allPass &= printTest('审计日志包含创建记录', auditLogs.some(l => l.action === 'inspection_create'));
  allPass &= printTest('审计日志包含提交记录', auditLogs.some(l => l.action === 'inspection_submit'));
  allPass &= printTest('审计日志包含退回记录', auditLogs.some(l => l.action === 'inspection_return'));
  allPass &= printTest('审计日志包含确认记录', auditLogs.some(l => l.action === 'inspection_approve'));
  allPass &= printTest('每条审计日志都有操作者信息',
    auditLogs.every(l => l.operatorId && l.operatorName && l.operatorRole));
  allPass &= printTest('每条审计日志都有时间戳',
    auditLogs.every(l => l.timestamp));

  console.log('\n--- 测试组 12: 状态过滤 ---\n');

  const pendingList = await request({
    ...baseOptions, path: '/api/inspections?status=pending', method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('按 pending 状态过滤成功', pendingList.statusCode === 200);
  allPass &= printTest('过滤结果全部为 pending 状态',
    pendingList.body.inspections.every(i => i.status === 'pending'));

  const approvedList = await request({
    ...baseOptions, path: '/api/inspections?status=approved', method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('按 approved 状态过滤成功', approvedList.statusCode === 200);
  allPass &= printTest('过滤结果全部为 approved 状态',
    approvedList.body.inspections.every(i => i.status === 'approved'));

  console.log('\n--- 保存测试数据用于跨重启验证 ---\n');

  const verifyData = {
    timestamp,
    batchNo,
    batchNo2,
    inspectionId,
    inspection2Id,
    finalVersion: finalDetail.body.inspection.version,
    finalStatus: finalDetail.body.inspection.status,
    auditLogCount: auditLogs.length
  };

  const dataFilePath = path.join(__dirname, 'data', 'inspection-test-data.json');
  fs.writeFileSync(dataFilePath, JSON.stringify(verifyData, null, 2));
  console.log(`  验证数据已保存到: ${dataFilePath}`);
  console.log(`  测试批次: ${batchNo}, ${batchNo2}`);
  console.log(`  抽检任务: ${inspectionId} (状态: ${finalDetail.body.inspection.status}, 版本: ${finalDetail.body.inspection.version})`);

  console.log('\n' + (allPass ? '✓ 所有测试通过！' : '✗ 部分测试失败，请检查。'));
  console.log(`\n总计: ${allPass ? '全部通过' : '存在失败'}`);

  process.exit(allPass ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('测试执行出错:', err);
    process.exit(1);
  });
}

module.exports = { request, printTest, baseOptions, headers };

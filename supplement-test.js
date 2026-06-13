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
  port: 3000,
  headers: { 'Content-Type': 'application/json' }
};

const headers = (opId) => ({ ...baseOptions.headers, 'X-Operator-Id': opId });

async function main() {
  console.log('========== 退回补证包专项回归测试 ==========\n');
  let allPass = true;
  const ts = Date.now();

  console.log('--- 1. 准备：导入批次并进入隔离 ---\n');

  const batchNo = `SUPP-TEST-${ts}`;
  await request({ ...baseOptions, path: '/api/batches/import', method: 'POST', headers: headers('receiver01') },
    [{ batchNo, drugName: '补证测试药', manufacturer: '测试药厂', quantity: 100 }]);

  const overTempLogs = [
    { batchNo, timestamp: '2024-06-01T08:00:00.000Z', temperature: 4.5 },
    { batchNo, timestamp: '2024-06-01T08:05:00.000Z', temperature: 4.2 },
    { batchNo, timestamp: '2024-06-01T08:10:00.000Z', temperature: 9.5 },
    { batchNo, timestamp: '2024-06-01T08:15:00.000Z', temperature: 10.2 },
    { batchNo, timestamp: '2024-06-01T08:20:00.000Z', temperature: 5.0 }
  ];
  await request({ ...baseOptions, path: `/api/batches/${batchNo}/temperature/import`, method: 'POST', headers: headers('receiver01') }, overTempLogs);

  const createDispRes = await request({
    ...baseOptions, path: `/api/batches/${batchNo}/dispositions`, method: 'POST', headers: headers('pharmacist01')
  }, { deviationLevel: 'moderate', cause: '冷链箱断电10分钟', suggestedAction: '评估后可放行', attachmentSummary: '断电记录.pdf' });
  const dispositionId = createDispRes.body.disposition.id;

  await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/submit`, method: 'POST', headers: headers('pharmacist01')
  });

  console.log('--- 2. 退回补证 ---\n');

  const pharmacistReturn = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/return`, method: 'POST', headers: headers('pharmacist01')
  }, { returnReason: '药师越权退回' });
  allPass &= printTest('药师越权退回被拒', pharmacistReturn.statusCode === 400,
    `实际: ${pharmacistReturn.statusCode}`);

  const receiverReturn = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/return`, method: 'POST', headers: headers('receiver01')
  }, { returnReason: '收货员越权退回' });
  allPass &= printTest('收货员越权退回被拒', receiverReturn.statusCode === 400,
    `实际: ${receiverReturn.statusCode}`);

  const returnRes = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/return`, method: 'POST', headers: headers('quality01')
  }, { returnReason: '请补充仓库环境温度记录' });
  allPass &= printTest('质管退回成功', returnRes.statusCode === 200,
    `实际: ${returnRes.statusCode}, 错误: ${returnRes.body?.error}`);
  allPass &= printTest('处置单状态变为 returned_for_supplement',
    returnRes.body.disposition?.status === 'returned_for_supplement');
  allPass &= printTest('退回时自动创建补证包',
    !!returnRes.body.supplement, `补证包: ${returnRes.body.supplement?.id || '无'}`);
  const supplementId = returnRes.body.supplement?.id;
  allPass &= printTest('补证包 ID 格式正确', supplementId?.startsWith('SUPP-'));
  allPass &= printTest('补证包初始状态为 pending', returnRes.body.supplement?.status === 'pending');
  allPass &= printTest('补证包退回人正确', returnRes.body.supplement?.returnedByName === '王质管');
  allPass &= printTest('补证包退回时间存在', !!returnRes.body.supplement?.returnedAt);

  console.log('\n--- 3. 重复退回冲突 ---\n');

  const dupReturn = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/return`, method: 'POST', headers: headers('quality01')
  }, { returnReason: '再次退回' });
  allPass &= printTest('存在未完成补证包时再次退回返回 409',
    dupReturn.statusCode === 409,
    `实际: ${dupReturn.statusCode}, 错误: ${dupReturn.body?.error}`);
  allPass &= printTest('冲突响应包含 existingSupplementId',
    dupReturn.body?.existingSupplementId === supplementId,
    `实际: ${dupReturn.body?.existingSupplementId}`);

  console.log('\n--- 4. 旧提交路由被阻断 ---\n');

  const blockedSubmit = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/submit`, method: 'POST', headers: headers('pharmacist01')
  });
  allPass &= printTest('有未提交补证包时旧提交路由被阻断',
    blockedSubmit.statusCode === 409,
    `实际: ${blockedSubmit.statusCode}, 错误: ${blockedSubmit.body?.error}`);

  console.log('\n--- 5. 越权提交补证包被拒 ---\n');

  const qmSubmit = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/supplement/submit`, method: 'POST', headers: headers('quality01')
  }, { supplementDescription: '质管越权', attachmentList: '无' });
  allPass &= printTest('质管越权提交补证包被拒', qmSubmit.statusCode === 400,
    `实际: ${qmSubmit.statusCode}, 错误: ${qmSubmit.body?.error}`);

  const rcvSubmit = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/supplement/submit`, method: 'POST', headers: headers('receiver01')
  }, { supplementDescription: '收货员越权', attachmentList: '无' });
  allPass &= printTest('收货员越权提交补证包被拒', rcvSubmit.statusCode === 400,
    `实际: ${rcvSubmit.statusCode}`);

  console.log('\n--- 6. 补证包字段校验 ---\n');

  const emptyDesc = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/supplement/submit`, method: 'POST', headers: headers('pharmacist01')
  }, { supplementDescription: '', attachmentList: '文件.pdf' });
  allPass &= printTest('补充说明为空被拒', emptyDesc.statusCode === 400);

  const emptyAttach = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/supplement/submit`, method: 'POST', headers: headers('pharmacist01')
  }, { supplementDescription: '有效说明', attachmentList: '' });
  allPass &= printTest('附件清单为空被拒', emptyAttach.statusCode === 400);

  console.log('\n--- 7. 药师成功提交补证包 ---\n');

  const suppSubmitRes = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/supplement/submit`, method: 'POST', headers: headers('pharmacist01')
  }, {
    supplementDescription: '已补充仓库环境温度记录，同批次其他箱子温度正常',
    relatedTempRangeIndices: [0],
    attachmentList: '仓库环境温度记录.xlsx、同批次温度监测报告.pdf'
  });
  allPass &= printTest('药师提交补证包成功', suppSubmitRes.statusCode === 200,
    `实际: ${suppSubmitRes.statusCode}, 错误: ${suppSubmitRes.body?.error}`);
  allPass &= printTest('补证包状态变为 submitted',
    suppSubmitRes.body.supplement?.status === 'submitted');
  allPass &= printTest('补证包含补充说明',
    suppSubmitRes.body.supplement?.supplementDescription?.includes('仓库环境温度'));
  allPass &= printTest('补证包含附件清单',
    suppSubmitRes.body.supplement?.attachmentList?.includes('仓库环境温度记录'));
  allPass &= printTest('补证包含关联温度区间',
    (suppSubmitRes.body.supplement?.relatedTempRanges?.length || 0) > 0);
  allPass &= printTest('补证包提交人正确',
    suppSubmitRes.body.supplement?.submittedByName === '李药师');
  allPass &= printTest('补证包提交时间存在',
    !!suppSubmitRes.body.supplement?.submittedAt);

  console.log('\n--- 8. 重复提交返回冲突 ---\n');

  const dupSubmit = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/supplement/submit`, method: 'POST', headers: headers('pharmacist01')
  }, { supplementDescription: '重复提交', attachmentList: '无' });
  allPass &= printTest('补证包已提交后再次提交返回 409',
    dupSubmit.statusCode === 409,
    `实际: ${dupSubmit.statusCode}, 错误: ${dupSubmit.body?.error}`);
  allPass &= printTest('冲突响应包含 supplementId',
    dupSubmit.body?.supplementId === supplementId,
    `实际: ${dupSubmit.body?.supplementId}`);

  console.log('\n--- 9. 补证后处置单自动回到待审批 ---\n');

  const detailAfterSupp = await request({
    ...baseOptions, path: `/api/batches/${batchNo}`, method: 'GET', headers: headers('pharmacist01')
  });
  allPass &= printTest('补证提交后处置单自动回到 pending_approval',
    detailAfterSupp.body.activeDisposition?.status === 'pending_approval',
    `实际: ${detailAfterSupp.body.activeDisposition?.status}`);

  console.log('\n--- 10. 查看补证包 ---\n');

  const viewByDisp = await request({
    ...baseOptions, path: `/api/batches/dispositions/${dispositionId}/supplement`, method: 'GET', headers: headers('receiver01')
  });
  allPass &= printTest('收货员可按处置单查看补证包', viewByDisp.statusCode === 200);
  allPass &= printTest('按处置单查询包含目标补证包',
    (viewByDisp.body?.supplements || []).some(s => s.id === supplementId));

  const viewByBatch = await request({
    ...baseOptions, path: `/api/batches/${batchNo}/supplements`, method: 'GET', headers: headers('pharmacist01')
  });
  allPass &= printTest('药师可按批次查看补证包', viewByBatch.statusCode === 200);
  allPass &= printTest('按批次查询包含目标补证包',
    (viewByBatch.body?.supplements || []).some(s => s.id === supplementId));

  console.log('\n--- 11. 审计日志 ---\n');

  const auditRes = await request({
    ...baseOptions, path: `/api/batches/${batchNo}/audit`, method: 'GET', headers: headers('quality01')
  });
  const auditLogs = auditRes.body?.auditLogs || [];
  allPass &= printTest('审计包含 supplement_create',
    auditLogs.some(l => l.action === 'supplement_create'));
  allPass &= printTest('审计包含 supplement_submit',
    auditLogs.some(l => l.action === 'supplement_submit'));
  allPass &= printTest('审计包含 disposition_return_supplement',
    auditLogs.some(l => l.action === 'disposition_return_supplement'));
  allPass &= printTest('审计包含 disposition_resubmit_after_supplement',
    auditLogs.some(l => l.action === 'disposition_resubmit_after_supplement'));

  const createAudit = auditLogs.find(l => l.action === 'supplement_create');
  allPass &= printTest('supplement_create 审计含操作人',
    createAudit?.operatorName === '王质管');
  allPass &= printTest('supplement_create 审计含补证包ID',
    createAudit?.detail?.supplementId === supplementId);

  const submitAudit = auditLogs.find(l => l.action === 'supplement_submit');
  allPass &= printTest('supplement_submit 审计含操作人',
    submitAudit?.operatorName === '李药师');

  console.log('\n--- 12. JSON/CSV 导出字段 ---\n');

  const jsonExportRes = await request({
    ...baseOptions, path: `/api/batches/${batchNo}/export?format=json`, method: 'GET', headers: headers('quality01')
  });
  const jsonExport = jsonExportRes.body;
  allPass &= printTest('JSON 导出包含 supplements 数组',
    Array.isArray(jsonExport.supplements));
  if (jsonExport.supplements?.length > 0) {
    const exportedSupp = jsonExport.supplements.find(s => s.id === supplementId);
    allPass &= printTest('JSON 导出补证包 ID 正确', !!exportedSupp);
    allPass &= printTest('JSON 导出补证包 status 字段', exportedSupp?.status === 'submitted');
    allPass &= printTest('JSON 导出补证包 supplementDescription 字段', !!exportedSupp?.supplementDescription);
    allPass &= printTest('JSON 导出补证包 attachmentList 字段', !!exportedSupp?.attachmentList);
    allPass &= printTest('JSON 导出补证包 submittedByName 字段', exportedSupp?.submittedByName === '李药师');
    allPass &= printTest('JSON 导出补证包 submittedAt 字段', !!exportedSupp?.submittedAt);
    allPass &= printTest('JSON 导出补证包 returnedByName 字段', exportedSupp?.returnedByName === '王质管');
    allPass &= printTest('JSON 导出补证包 relatedTempRanges 字段',
      Array.isArray(exportedSupp?.relatedTempRanges) && exportedSupp.relatedTempRanges.length > 0);
  }

  const csvExportRes = await request({
    ...baseOptions, path: `/api/batches/${batchNo}/export?format=csv`, method: 'GET',
    headers: { ...headers('quality01'), 'Accept': 'text/csv' }
  });
  const csvStr = typeof csvExportRes.body === 'string' ? csvExportRes.body : JSON.stringify(csvExportRes.body);
  allPass &= printTest('CSV 导出包含补证包段', csvStr.includes('# 补证包'));
  allPass &= printTest('CSV 导出包含补证包 ID', csvStr.includes(supplementId));
  allPass &= printTest('CSV 导出含 id 列', csvStr.includes('id,dispositionId'));
  allPass &= printTest('CSV 导出含 supplementDescription 列', csvStr.includes('supplementDescription'));
  allPass &= printTest('CSV 导出含 attachmentList 列', csvStr.includes('attachmentList'));
  allPass &= printTest('CSV 导出含 submittedBy 列', csvStr.includes('submittedBy'));
  allPass &= printTest('CSV 导出含 submittedAt 列', csvStr.includes('submittedAt'));
  allPass &= printTest('CSV 导出含 returnedBy 列', csvStr.includes('returnedBy'));
  allPass &= printTest('CSV 导出含 status 列', csvStr.includes('status'));

  console.log('\n--- 13. 保存重启前状态 ---\n');

  const stateToSave = {
    batchNo,
    dispositionId,
    supplementId,
    supplementStatus: suppSubmitRes.body.supplement?.status,
    supplementDescription: suppSubmitRes.body.supplement?.supplementDescription,
    supplementAttachmentList: suppSubmitRes.body.supplement?.attachmentList,
    supplementSubmittedBy: suppSubmitRes.body.supplement?.submittedBy,
    supplementSubmittedByName: suppSubmitRes.body.supplement?.submittedByName,
    supplementSubmittedAt: suppSubmitRes.body.supplement?.submittedAt,
    supplementReturnedBy: suppSubmitRes.body.supplement?.returnedBy,
    supplementReturnedByName: suppSubmitRes.body.supplement?.returnedByName,
    supplementReturnedAt: suppSubmitRes.body.supplement?.returnedAt,
    supplementRelatedTempRangeCount: (suppSubmitRes.body.supplement?.relatedTempRanges?.length || 0),
    dispositionStatus: detailAfterSupp.body.activeDisposition?.status,
    auditCreateCount: auditLogs.filter(l => l.action === 'supplement_create').length,
    auditSubmitCount: auditLogs.filter(l => l.action === 'supplement_submit').length,
    auditResubmitCount: auditLogs.filter(l => l.action === 'disposition_resubmit_after_supplement').length
  };

  const statePath = path.join(__dirname, 'data', 'supplement-pre-restart-state.json');
  fs.writeFileSync(statePath, JSON.stringify(stateToSave, null, 2));

  console.log(`重启前状态已保存到 data/supplement-pre-restart-state.json`);
  console.log(`  补证包 ID: ${supplementId}`);
  console.log(`  补证包状态: ${stateToSave.supplementStatus}`);
  console.log(`  提交人: ${stateToSave.supplementSubmittedByName}`);
  console.log(`  处置单状态: ${stateToSave.dispositionStatus}`);

  console.log('\n========================================');
  console.log(allPass ? '全部补证包专项测试通过！' : '部分测试失败！');
  console.log('========================================');
  console.log('\n请重启服务后运行 node supplement-test-verify.js 验证重启一致性');

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('测试出错:', err.message);
  console.error(err.stack);
  process.exit(1);
});

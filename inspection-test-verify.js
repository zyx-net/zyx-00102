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

async function main() {
  console.log('========== 到货抽检任务跨重启一致性验证 ==========\n');
  let allPass = true;

  const dataFilePath = path.join(__dirname, 'data', 'inspection-test-data.json');
  if (!fs.existsSync(dataFilePath)) {
    console.log('未找到测试数据文件，请先运行 inspection-test.js');
    process.exit(1);
  }

  const verifyData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
  const { inspectionId, inspection2Id, finalVersion, finalStatus, auditLogCount } = verifyData;

  console.log(`验证的抽检任务: ${inspectionId}\n`);

  console.log('--- 验证组 1: 数据持久化（服务重启后数据完整）---\n');

  const detailRes = await request({
    ...baseOptions, path: `/api/inspections/${inspectionId}`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('重启后抽检任务仍存在', detailRes.statusCode === 200,
    `实际: ${detailRes.statusCode}`);

  if (detailRes.statusCode === 200) {
    const inspection = detailRes.body.inspection;
    allPass &= printTest('重启后状态一致', inspection.status === finalStatus,
      `预期: ${finalStatus}, 实际: ${inspection.status}`);
    allPass &= printTest('重启后版本号一致', inspection.version === finalVersion,
      `预期: ${finalVersion}, 实际: ${inspection.version}`);
    allPass &= printTest('审计日志数量一致', detailRes.body.auditLogs.length === auditLogCount,
      `预期: ${auditLogCount}, 实际: ${detailRes.body.auditLogs.length}`);
    allPass &= printTest('抽检项目数量正确', inspection.inspectionItems.length === 3);
    allPass &= printTest('检测结果未丢失',
      inspection.inspectionItems.every(item => item.result !== ''));
    allPass &= printTest('创建人信息完整', inspection.createdBy && inspection.createdByName);
    allPass &= printTest('提交人信息完整', inspection.submittedBy && inspection.submittedByName);
    allPass &= printTest('确认人信息完整', inspection.approvedBy && inspection.approvedByName);
  }

  console.log('\n--- 验证组 2: 审计记录持久化 ---\n');

  const auditRes = await request({
    ...baseOptions, path: `/api/inspections/${inspectionId}/audit`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('重启后审计日志可访问', auditRes.statusCode === 200);

  if (auditRes.statusCode === 200) {
    const auditLogs = auditRes.body.auditLogs;
    allPass &= printTest('审计日志包含创建记录', auditLogs.some(l => l.action === 'inspection_create'));
    allPass &= printTest('审计日志包含提交记录', auditLogs.some(l => l.action === 'inspection_submit'));
    allPass &= printTest('审计日志包含退回记录', auditLogs.some(l => l.action === 'inspection_return'));
    allPass &= printTest('审计日志包含确认记录', auditLogs.some(l => l.action === 'inspection_approve'));
    allPass &= printTest('每条审计日志都有时间戳',
      auditLogs.every(l => l.timestamp));
    allPass &= printTest('每条审计日志都有操作者角色',
      auditLogs.every(l => l.operatorRole));
  }

  console.log('\n--- 验证组 3: 第二个任务数据持久化 ---\n');

  const detail2Res = await request({
    ...baseOptions, path: `/api/inspections/${inspection2Id}`, method: 'GET',
    headers: headers('pharmacist01')
  });
  allPass &= printTest('第二个抽检任务重启后仍存在', detail2Res.statusCode === 200);

  if (detail2Res.statusCode === 200) {
    const inspection2 = detail2Res.body.inspection;
    allPass &= printTest('第二个任务状态为 returned', inspection2.status === 'returned');
    allPass &= printTest('第二个任务版本号为 3', inspection2.version === 3,
      `实际版本: ${inspection2.version}`);
    allPass &= printTest('第二个任务退回原因存在', inspection2.returnReason !== '');
  }

  console.log('\n--- 验证组 4: 列表查询与按批次查询 ---\n');

  const listRes = await request({
    ...baseOptions, path: '/api/inspections', method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('重启后列表查询正常', listRes.statusCode === 200);
  allPass &= printTest('列表至少包含2条记录', listRes.body.inspections.length >= 2);

  const batchListRes = await request({
    ...baseOptions, path: `/api/inspections/batch/${verifyData.batchNo}`, method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('重启后按批次查询正常', batchListRes.statusCode === 200);
  allPass &= printTest('按批次查询结果数量正确', batchListRes.body.inspections.length === 1);
  allPass &= printTest('查询结果批次号匹配', batchListRes.body.inspections[0].batchNo === verifyData.batchNo);

  console.log('\n--- 验证组 5: 状态过滤功能 ---\n');

  const approvedList = await request({
    ...baseOptions, path: '/api/inspections?status=approved', method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('重启后状态过滤正常', approvedList.statusCode === 200);
  allPass &= printTest('过滤结果中包含测试任务',
    approvedList.body.inspections.some(i => i.id === inspectionId));

  console.log('\n--- 验证组 6: JSON/CSV 导出功能 ---\n');

  const jsonExport = await request({
    ...baseOptions, path: '/api/inspections/export/all?format=json', method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('重启后 JSON 导出正常', jsonExport.statusCode === 200);
  allPass &= printTest('JSON 导出包含 inspections 数组', Array.isArray(jsonExport.body.inspections));

  const csvExport = await request({
    ...baseOptions, path: '/api/inspections/export/all?format=csv', method: 'GET',
    headers: { ...baseOptions.headers, 'X-Operator-Id': 'quality01' }
  });
  allPass &= printTest('重启后 CSV 导出正常', csvExport.statusCode === 200);
  allPass &= printTest('CSV 导出内容为字符串', typeof csvExport.body === 'string');

  const detailJsonExport = await request({
    ...baseOptions, path: `/api/inspections/export/${inspectionId}?format=json`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('重启后详情 JSON 导出正常', detailJsonExport.statusCode === 200);
  allPass &= printTest('详情导出包含审计日志', Array.isArray(detailJsonExport.body.auditLogs));

  console.log('\n--- 验证组 7: 版本号和状态流转验证 ---\n');

  if (detailRes.statusCode === 200) {
    const inspection = detailRes.body.inspection;
    allPass &= printTest('版本号为整数且大于0', Number.isInteger(inspection.version) && inspection.version > 0);
    allPass &= printTest('状态为有效值',
      ['pending', 'submitted', 'approved', 'returned'].includes(inspection.status));
    allPass &= printTest('updatedAt 时间戳存在', inspection.updatedAt && !isNaN(new Date(inspection.updatedAt).getTime()));
    allPass &= printTest('createdAt 时间戳存在', inspection.createdAt && !isNaN(new Date(inspection.createdAt).getTime()));
  }

  console.log('\n--- 验证组 8: 权限控制重启后仍然有效 ---\n');

  const receiverCreate = await request({
    ...baseOptions, path: '/api/inspections', method: 'POST',
    headers: headers('receiver01')
  }, {
    batchNo: verifyData.batchNo,
    inspectionItems: [{ name: '测试项', criteria: '测试标准' }],
    sampleQuantity: 5,
    deadline: new Date(Date.now() + 86400000).toISOString()
  });
  allPass &= printTest('重启后收货员仍不能创建任务', receiverCreate.statusCode === 400,
    `实际: ${receiverCreate.statusCode}`);

  const pharmacistApprove = await request({
    ...baseOptions, path: `/api/inspections/${inspection2Id}/approve`, method: 'POST',
    headers: headers('pharmacist01')
  }, { reason: '越权测试' });
  allPass &= printTest('重启后药师仍不能确认任务', pharmacistApprove.statusCode === 400,
    `实际: ${pharmacistApprove.statusCode}`);

  console.log('\n' + (allPass ? '✓ 所有跨重启验证通过！' : '✗ 部分验证失败，请检查。'));
  console.log(`\n总计: ${allPass ? '全部通过' : '存在失败'}`);
  console.log('DEBUG allPass value:', allPass, 'type:', typeof allPass);

  process.exit(allPass ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('验证执行出错:', err);
    process.exit(1);
  });
}

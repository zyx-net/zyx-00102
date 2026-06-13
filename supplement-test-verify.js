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
  if (detail) {
    console.log(`  ${detail}`);
  }
  return pass;
}

const baseOptions = {
  hostname: 'localhost',
  port: 3000,
  headers: { 'Content-Type': 'application/json', 'X-Operator-Id': 'quality01' }
};

async function main() {
  console.log('========== 补证包重启后一致性验证 ==========\n');

  const stateFile = path.join(__dirname, 'data', 'supplement-pre-restart-state.json');
  if (!fs.existsSync(stateFile)) {
    console.log('错误: 未找到重启前状态文件，请先运行 node supplement-test.js');
    process.exit(1);
  }

  const pre = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  let allPass = true;

  console.log('--- 1. 补证包列表接口 ---\n');

  const batchSuppRes = await request({
    ...baseOptions, path: `/api/batches/${pre.batchNo}/supplements`, method: 'GET'
  });
  allPass &= printTest('按批次查询补证包接口可用',
    batchSuppRes.statusCode === 200 && Array.isArray(batchSuppRes.body?.supplements));

  const batchSupps = batchSuppRes.body?.supplements || [];
  const foundByBatch = batchSupps.find(s => s.id === pre.supplementId);
  allPass &= printTest('按批次查询包含目标补证包', !!foundByBatch);

  const dispSuppRes = await request({
    ...baseOptions, path: `/api/batches/dispositions/${pre.dispositionId}/supplement`, method: 'GET'
  });
  allPass &= printTest('按处置单查询补证包接口可用', dispSuppRes.statusCode === 200);
  const dispSupps = dispSuppRes.body?.supplements || [];
  const foundByDisp = dispSupps.find(s => s.id === pre.supplementId);
  allPass &= printTest('按处置单查询包含目标补证包', !!foundByDisp);

  console.log('\n--- 2. 补证包字段一致性 ---\n');

  const supp = foundByBatch || foundByDisp;
  if (supp) {
    allPass &= printTest('status 一致',
      supp.status === pre.supplementStatus,
      `重启前: ${pre.supplementStatus}, 重启后: ${supp.status}`);
    allPass &= printTest('supplementDescription 一致',
      supp.supplementDescription === pre.supplementDescription);
    allPass &= printTest('attachmentList 一致',
      supp.attachmentList === pre.supplementAttachmentList);
    allPass &= printTest('submittedBy 一致',
      supp.submittedBy === pre.supplementSubmittedBy);
    allPass &= printTest('submittedByName 一致',
      supp.submittedByName === pre.supplementSubmittedByName);
    allPass &= printTest('submittedAt 一致',
      supp.submittedAt === pre.supplementSubmittedAt);
    allPass &= printTest('returnedBy 一致',
      supp.returnedBy === pre.supplementReturnedBy);
    allPass &= printTest('returnedByName 一致',
      supp.returnedByName === pre.supplementReturnedByName);
    allPass &= printTest('returnedAt 一致',
      supp.returnedAt === pre.supplementReturnedAt);
    allPass &= printTest('relatedTempRanges 数量一致',
      (supp.relatedTempRanges?.length || 0) === pre.supplementRelatedTempRangeCount);
  }

  console.log('\n--- 3. supplements.json 文件一致性 ---\n');

  const dataDir = path.join(__dirname, 'data');
  const suppFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'supplements.json'), 'utf-8'));
  const fileSupp = suppFile[pre.supplementId];
  allPass &= printTest('补证包文件存在', !!fileSupp);
  if (fileSupp) {
    allPass &= printTest('文件 status 与 API 一致',
      fileSupp.status === pre.supplementStatus);
    allPass &= printTest('文件 supplementDescription 与 API 一致',
      fileSupp.supplementDescription === pre.supplementDescription);
    allPass &= printTest('文件 submittedBy 与 API 一致',
      fileSupp.submittedBy === pre.supplementSubmittedBy);
    allPass &= printTest('文件 submittedAt 与 API 一致',
      fileSupp.submittedAt === pre.supplementSubmittedAt);
    allPass &= printTest('文件 returnedByName 与 API 一致',
      fileSupp.returnedByName === pre.supplementReturnedByName);
  }

  console.log('\n--- 4. 处置单状态一致性 ---\n');

  const dispRes = await request({
    ...baseOptions, path: `/api/batches/dispositions/${pre.dispositionId}`, method: 'GET'
  });
  allPass &= printTest('处置单状态一致',
    dispRes.body?.disposition?.status === pre.dispositionStatus,
    `重启前: ${pre.dispositionStatus}, 重启后: ${dispRes.body?.disposition?.status}`);

  console.log('\n--- 5. 审计日志一致性 ---\n');

  const auditRes = await request({
    ...baseOptions, path: `/api/batches/${pre.batchNo}/audit`, method: 'GET'
  });
  const auditLogs = auditRes.body?.auditLogs || [];

  const createCount = auditLogs.filter(l => l.action === 'supplement_create').length;
  const submitCount = auditLogs.filter(l => l.action === 'supplement_submit').length;
  const resubmitCount = auditLogs.filter(l => l.action === 'disposition_resubmit_after_supplement').length;

  allPass &= printTest('supplement_create 审计数一致',
    createCount === pre.auditCreateCount,
    `重启前: ${pre.auditCreateCount}, 重启后: ${createCount}`);
  allPass &= printTest('supplement_submit 审计数一致',
    submitCount === pre.auditSubmitCount,
    `重启前: ${pre.auditSubmitCount}, 重启后: ${submitCount}`);
  allPass &= printTest('disposition_resubmit_after_supplement 审计数一致',
    resubmitCount === pre.auditResubmitCount,
    `重启前: ${pre.auditResubmitCount}, 重启后: ${resubmitCount}`);

  console.log('\n--- 6. JSON 导出字段 ---\n');

  const jsonExportRes = await request({
    ...baseOptions, path: `/api/batches/${pre.batchNo}/export?format=json`, method: 'GET'
  });
  const jsonExport = jsonExportRes.body;
  allPass &= printTest('JSON 导出包含 supplements 数组',
    Array.isArray(jsonExport.supplements));
  if (jsonExport.supplements?.length > 0) {
    const expSupp = jsonExport.supplements.find(s => s.id === pre.supplementId);
    allPass &= printTest('JSON 导出补证包 ID 正确', !!expSupp);
    allPass &= printTest('JSON 导出 status 正确',
      expSupp?.status === pre.supplementStatus);
    allPass &= printTest('JSON 导出 supplementDescription 正确',
      expSupp?.supplementDescription === pre.supplementDescription);
    allPass &= printTest('JSON 导出 submittedByName 正确',
      expSupp?.submittedByName === pre.supplementSubmittedByName);
    allPass &= printTest('JSON 导出 submittedAt 正确',
      expSupp?.submittedAt === pre.supplementSubmittedAt);
    allPass &= printTest('JSON 导出 returnedByName 正确',
      expSupp?.returnedByName === pre.supplementReturnedByName);
  }

  console.log('\n--- 7. CSV 导出字段 ---\n');

  const csvExportRes = await request({
    ...baseOptions, path: `/api/batches/${pre.batchNo}/export?format=csv`, method: 'GET',
    headers: { ...baseOptions.headers, 'Accept': 'text/csv' }
  });
  const csvStr = typeof csvExportRes.body === 'string' ? csvExportRes.body : JSON.stringify(csvExportRes.body);
  allPass &= printTest('CSV 导出包含补证包段', csvStr.includes('# 补证包'));
  allPass &= printTest('CSV 导出包含补证包 ID', csvStr.includes(pre.supplementId));
  allPass &= printTest('CSV 导出含 supplementDescription', csvStr.includes('supplementDescription'));
  allPass &= printTest('CSV 导出含 attachmentList', csvStr.includes('attachmentList'));
  allPass &= printTest('CSV 导出含 submittedBy', csvStr.includes('submittedBy'));
  allPass &= printTest('CSV 导出含 submittedAt', csvStr.includes('submittedAt'));
  allPass &= printTest('CSV 导出含 returnedBy', csvStr.includes('returnedBy'));
  allPass &= printTest('CSV 导出含 status', csvStr.includes('status'));

  console.log('\n========================================');
  if (allPass) {
    console.log('✓ 补证包重启后全部一致性验证通过！');
    console.log('✓ 补证包详情、提交人、提交时间、状态重启后保持一致');
    console.log('✓ supplements.json 文件与 API 返回一致');
    console.log('✓ 审计日志重启后完整保留');
    console.log('✓ JSON/CSV 导出重启后字段正确');
  } else {
    console.log('✗ 部分验证失败！');
  }
  console.log('========================================');

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('验证出错:', err.message);
  console.error(err.stack);
  process.exit(1);
});

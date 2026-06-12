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
  if (detail) {
    console.log(`  ${detail}`);
  }
  return pass;
}

const baseOptions = {
  hostname: 'localhost',
  port: 3000,
  headers: {
    'Content-Type': 'application/json',
    'X-Operator-Id': 'quality01'
  }
};

async function getBatchDetail(batchNo) {
  const res = await request({
    ...baseOptions,
    path: `/api/batches/${batchNo}`,
    method: 'GET'
  });
  return res.body;
}

async function getBatchList() {
  const res = await request({
    ...baseOptions,
    path: '/api/batches',
    method: 'GET'
  });
  return res.body.batches;
}

async function getExportJson(batchNo) {
  const res = await request({
    ...baseOptions,
    path: `/api/batches/${batchNo}/export?format=json`,
    method: 'GET'
  });
  return res.body;
}

async function getExportCsv(batchNo) {
  const res = await request({
    ...baseOptions,
    path: `/api/batches/${batchNo}/export?format=csv`,
    method: 'GET',
    headers: { ...baseOptions.headers, 'Accept': 'text/csv' }
  });
  return res.body;
}

async function main() {
  console.log('========== 服务重启后数据一致性验证 ==========\n');

  const stateFile = path.join(__dirname, 'data', 'pre-restart-state.json');
  if (!fs.existsSync(stateFile)) {
    console.log('错误: 未找到重启前状态文件，请先运行 node regression-test.js');
    process.exit(1);
  }

  const preState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  let allPass = true;

  console.log('--- 1. 批次总数一致性 ---\n');

  const currentBatchCount = (await getBatchList()).length;
  allPass &= printTest('批次总数一致',
    currentBatchCount === preState.batchCount,
    `重启前: ${preState.batchCount}, 重启后: ${currentBatchCount}`);

  console.log('\n--- 2. 超温批次（已放行）一致性 ---\n');

  const overTempDetail = await getBatchDetail(preState.overTempBatchNo);
  allPass &= printTest('状态一致',
    overTempDetail.batch.status === preState.releasedStatus,
    `重启前: ${preState.releasedStatus}, 重启后: ${overTempDetail.batch.status}`);
  allPass &= printTest('温度日志数一致',
    (overTempDetail.temperatureLogs?.length || 0) === preState.releasedTempCount,
    `重启前: ${preState.releasedTempCount}, 重启后: ${overTempDetail.temperatureLogs?.length || 0}`);
  allPass &= printTest('审计记录数一致',
    (overTempDetail.auditLogs?.length || 0) === preState.releasedAuditCount,
    `重启前: ${preState.releasedAuditCount}, 重启后: ${overTempDetail.auditLogs?.length || 0}`);
  allPass &= printTest('超温区间数据完整',
    (overTempDetail.batch.overTempRanges?.length || 0) > 0,
    `超温区间数: ${overTempDetail.batch.overTempRanges?.length || 0}`);

  // 验证审计历史顺序（时间倒序）
  const auditLogs = overTempDetail.auditLogs || [];
  let auditOrderOk = true;
  for (let i = 1; i < auditLogs.length; i++) {
    if (new Date(auditLogs[i - 1].timestamp) < new Date(auditLogs[i].timestamp)) {
      auditOrderOk = false;
      break;
    }
  }
  allPass &= printTest('审计历史时间倒序正确', auditOrderOk);

  // 验证自动隔离审计记录存在
  const autoQuarantineLog = auditLogs.find(l => l.action === 'auto_quarantine');
  allPass &= printTest('自动隔离审计记录存在', !!autoQuarantineLog,
    autoQuarantineLog ? '存在' : '不存在');

  if (autoQuarantineLog) {
    allPass &= printTest('自动隔离状态流转正确',
      autoQuarantineLog.fromStatus === 'pending_review' && autoQuarantineLog.toStatus === 'quarantined',
      `from: ${autoQuarantineLog.fromStatus}, to: ${autoQuarantineLog.toStatus}`);
  }

  console.log('\n--- 3. 正常温度批次一致性 ---\n');

  const normalDetail = await getBatchDetail(preState.normalBatchNo);
  allPass &= printTest('状态一致',
    normalDetail.batch.status === preState.normalStatus,
    `重启前: ${preState.normalStatus}, 重启后: ${normalDetail.batch.status}`);
  allPass &= printTest('温度日志数一致',
    (normalDetail.temperatureLogs?.length || 0) === preState.normalTempCount,
    `重启前: ${preState.normalTempCount}, 重启后: ${normalDetail.temperatureLogs?.length || 0}`);

  console.log('\n--- 4. 失败批次一致性（无半截数据） ---\n');

  const failDetail = await getBatchDetail(preState.failBatchNo);
  allPass &= printTest('状态一致',
    failDetail.batch.status === preState.failStatus,
    `重启前: ${preState.failStatus}, 重启后: ${failDetail.batch.status}`);
  allPass &= printTest('温度日志为空',
    (failDetail.temperatureLogs?.length || 0) === preState.failTempCount,
    `重启前: ${preState.failTempCount}, 重启后: ${failDetail.temperatureLogs?.length || 0}`);

  console.log('\n--- 5. 查询接口与 JSON 导出一致性 ---\n');

  const exportJson = await getExportJson(preState.overTempBatchNo);
  allPass &= printTest('JSON 导出状态一致',
    exportJson.batch.status === overTempDetail.batch.status);
  allPass &= printTest('JSON 导出温度日志一致',
    JSON.stringify(exportJson.temperatureLogs) === JSON.stringify(overTempDetail.temperatureLogs));
  allPass &= printTest('JSON 导出审计记录一致',
    JSON.stringify(exportJson.auditLogs) === JSON.stringify(overTempDetail.auditLogs));
  allPass &= printTest('JSON 导出超温区间一致',
    JSON.stringify(exportJson.batch.overTempRanges) === JSON.stringify(overTempDetail.batch.overTempRanges));

  console.log('\n--- 6. CSV 导出数据完整性 ---\n');

  const exportCsv = await getExportCsv(preState.overTempBatchNo);
  const csvStr = typeof exportCsv === 'string' ? exportCsv : JSON.stringify(exportCsv);
  allPass &= printTest('CSV 包含批次信息', csvStr.includes(preState.overTempBatchNo));
  allPass &= printTest('CSV 包含温度日志段', csvStr.includes('# 温度日志'));
  allPass &= printTest('CSV 包含审计历史段', csvStr.includes('# 审计历史'));
  allPass &= printTest('CSV 包含状态信息', csvStr.includes(overTempDetail.batch.status));

  console.log('\n--- 7. 与存储文件直接对比 ---\n');

  const dataDir = path.join(__dirname, 'data');
  const batchesFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'batches.json'), 'utf-8'));
  const tempFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'temperature-logs.json'), 'utf-8'));
  const auditFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'audit-logs.json'), 'utf-8'));

  const fileBatch = batchesFile[preState.overTempBatchNo];
  allPass &= printTest('文件中批次状态与 API 一致',
    fileBatch.status === overTempDetail.batch.status);

  const fileTemp = tempFile[preState.overTempBatchNo] || [];
  allPass &= printTest('文件中温度日志数与 API 一致',
    fileTemp.length === (overTempDetail.temperatureLogs?.length || 0));

  const fileAudit = auditFile[preState.overTempBatchNo] || [];
  allPass &= printTest('文件中审计记录数与 API 一致',
    fileAudit.length === (overTempDetail.auditLogs?.length || 0));

  console.log('\n========================================');
  if (allPass) {
    console.log('✓ 全部一致性验证通过！');
    console.log('✓ 服务重启后所有数据保持一致');
    console.log('✓ 查询接口、JSON/CSV 导出、文件存储三者一致');
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

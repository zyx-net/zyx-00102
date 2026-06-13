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

const headers = (operatorId) => ({ ...baseOptions.headers, 'X-Operator-Id': operatorId });

async function main() {
  console.log('========== 校准记录跨重启一致性验证 ==========\n');

  const statePath = path.join(__dirname, 'data', 'calibration-pre-restart-state.json');
  if (!fs.existsSync(statePath)) {
    console.error('找不到 data/calibration-pre-restart-state.json，请先运行 calibration-test.js');
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  let allPass = true;

  console.log('--- 验证校准记录数据持久性 ---\n');

  const cal1 = await request({
    ...baseOptions, path: `/api/calibrations/${state.calId1}`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('校准记录1重启后仍存在', cal1.statusCode === 200);
  allPass &= printTest('校准记录1 deviceNo 一致',
    cal1.body.calibration.deviceNo === state.calId1DeviceNo,
    `预期: ${state.calId1DeviceNo}, 实际: ${cal1.body.calibration?.deviceNo}`);
  allPass &= printTest('校准记录1 certificateNo 一致',
    cal1.body.calibration.certificateNo === state.calId1CertificateNo,
    `预期: ${state.calId1CertificateNo}, 实际: ${cal1.body.calibration?.certificateNo}`);
  allPass &= printTest('校准记录1 status 一致',
    cal1.body.calibration.status === state.calId1Status);
  allPass &= printTest('校准记录1 version 一致',
    cal1.body.calibration.version === state.calId1Version,
    `预期: ${state.calId1Version}, 实际: ${cal1.body.calibration?.version}`);
  allPass &= printTest('校准记录1 validUntil 一致',
    cal1.body.calibration.validUntil === state.calId1ValidUntil);

  const cal2 = await request({
    ...baseOptions, path: `/api/calibrations/${state.calId2}`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('校准记录2重启后仍存在', cal2.statusCode === 200);
  allPass &= printTest('校准记录2 status 为 voided', cal2.body.calibration.status === 'voided');
  allPass &= printTest('校准记录2作废原因一致',
    cal2.body.calibration.voidReason === state.calId2VoidReason);

  const cal3 = await request({
    ...baseOptions, path: `/api/calibrations/${state.calId3}`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('校准记录3重启后仍存在', cal3.statusCode === 200);
  allPass &= printTest('校准记录3 deviceNo 一致',
    cal3.body.calibration.deviceNo === state.calId3DeviceNo);

  console.log('\n--- 验证设备校验功能重启后正常 ---\n');

  const validateActive = await request({
    ...baseOptions, path: `/api/calibrations/validate?deviceNo=${state.calId1DeviceNo}`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('活跃设备重启后校验通过', validateActive.body.valid === true);

  const validateVoided = await request({
    ...baseOptions, path: `/api/calibrations/validate?deviceNo=${state.calId2DeviceNo || state.calId3DeviceNo}`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('设备校验接口重启后正常', validateVoided.statusCode === 200);

  const validateExpired = await request({
    ...baseOptions, path: `/api/calibrations/validate?deviceNo=${state.expiredDevNo}`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('过期设备重启后校验失败', validateExpired.body.valid === false);

  console.log('\n--- 验证审计日志重启后持久性 ---\n');

  const audit1 = await request({
    ...baseOptions, path: `/api/calibrations/${state.calId1}/audit`, method: 'GET',
    headers: headers('quality01')
  });
  const auditLogs1 = audit1.body.auditLogs || [];
  allPass &= printTest('审计日志重启后仍存在', auditLogs1.length > 0);
  allPass &= printTest('审计日志包含 create', auditLogs1.some(l => l.action === 'calibration_create'));
  allPass &= printTest('审计日志包含 update', auditLogs1.some(l => l.action === 'calibration_update'));
  allPass &= printTest('审计日志包含 change_expiry', auditLogs1.some(l => l.action === 'calibration_change_expiry'));

  console.log('\n--- 验证批次关联设备信息重启后持久 ---\n');

  const batchDetail = await request({
    ...baseOptions, path: `/api/batches/${state.refBatchNo}`, method: 'GET',
    headers: headers('quality01')
  });
  if (batchDetail.statusCode === 200) {
    allPass &= printTest('批次重启后仍存在', true);
    allPass &= printTest('批次关联设备重启后仍在',
      JSON.stringify(batchDetail.body.batch.deviceNos) === JSON.stringify(state.refBatchDeviceNos),
      `预期: ${JSON.stringify(state.refBatchDeviceNos)}, 实际: ${JSON.stringify(batchDetail.body.batch.deviceNos)}`);
  } else {
    allPass &= printTest('批次重启后仍存在', false, `状态码: ${batchDetail.statusCode}`);
  }

  console.log('\n--- 验证记录总数 ---\n');

  const allCal = await request({
    ...baseOptions, path: '/api/calibrations', method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('记录总数一致',
    allCal.body.calibrations.length === state.calibrationCount,
    `预期: ${state.calibrationCount}, 实际: ${allCal.body.calibrations.length}`);

  console.log('\n========================================');
  console.log(allPass ? '跨重启一致性验证全部通过！' : '部分验证失败！');
  console.log('========================================');

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('验证出错:', err.message);
  console.error(err.stack);
  process.exit(1);
});

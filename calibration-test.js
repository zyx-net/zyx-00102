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
  console.log('========== 冷链温度设备校准记录模块回归测试 ==========\n');
  let allPass = true;
  const timestamp = Date.now();
  const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const pastDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const farFutureDate = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  console.log('--- 测试组 1: 权限控制 ---\n');

  const createData = {
    deviceNo: `DEV-T1-${timestamp}`,
    deviceType: 'thermometer',
    certificateNo: `CERT-T1-${timestamp}`,
    calibratedAt: '2026-01-01',
    validUntil: futureDate
  };

  const receiverCreate = await request({
    ...baseOptions, path: '/api/calibrations', method: 'POST',
    headers: headers('receiver01')
  }, createData);
  allPass &= printTest('收货员创建校准记录被拒', receiverCreate.statusCode === 400,
    `实际: ${receiverCreate.statusCode}`);

  const pharmacistCreate = await request({
    ...baseOptions, path: '/api/calibrations', method: 'POST',
    headers: headers('pharmacist01')
  }, createData);
  allPass &= printTest('药师创建校准记录被拒', pharmacistCreate.statusCode === 400,
    `实际: ${pharmacistCreate.statusCode}`);

  const qmCreate = await request({
    ...baseOptions, path: '/api/calibrations', method: 'POST',
    headers: headers('quality01')
  }, createData);
  allPass &= printTest('质管创建校准记录成功', qmCreate.statusCode === 201,
    `实际: ${qmCreate.statusCode}`);
  allPass &= printTest('记录 ID 格式正确', qmCreate.body.calibration.id.startsWith('CAL-'));
  allPass &= printTest('记录状态为 active', qmCreate.body.calibration.status === 'active');
  const calId1 = qmCreate.body.calibration.id;

  const receiverView = await request({
    ...baseOptions, path: '/api/calibrations', method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('收货员可查看列表', receiverView.statusCode === 200);
  allPass &= printTest('收货员看到记录', receiverView.body.calibrations.length > 0);

  const receiverValidate = await request({
    ...baseOptions, path: `/api/calibrations/validate?deviceNo=${createData.deviceNo}`, method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('收货员可引用校验接口', receiverValidate.statusCode === 200);

  const receiverVoid = await request({
    ...baseOptions, path: `/api/calibrations/${calId1}/void`, method: 'POST',
    headers: headers('receiver01')
  }, { reason: '收货员越权作废' });
  allPass &= printTest('收货员作废被拒', receiverVoid.statusCode === 400,
    `实际: ${receiverVoid.statusCode}`);

  const pharmacistVoid = await request({
    ...baseOptions, path: `/api/calibrations/${calId1}/void`, method: 'POST',
    headers: headers('pharmacist01')
  }, { reason: '药师越权作废' });
  allPass &= printTest('药师作废被拒', pharmacistVoid.statusCode === 400,
    `实际: ${pharmacistVoid.statusCode}`);

  const receiverChangeExpiry = await request({
    ...baseOptions, path: `/api/calibrations/${calId1}/expiry`, method: 'PUT',
    headers: headers('receiver01')
  }, { validUntil: farFutureDate, reason: '收货员越权改期' });
  allPass &= printTest('收货员改有效期被拒', receiverChangeExpiry.statusCode === 400);

  console.log('\n--- 测试组 2: 冲突校验 ---\n');

  const dupData = {
    deviceNo: `DEV-T2-${timestamp}`,
    deviceType: 'data_logger',
    certificateNo: `CERT-DUP1-${timestamp}`,
    calibratedAt: '2026-01-01',
    validUntil: '2027-06-01'
  };
  const create2 = await request({
    ...baseOptions, path: '/api/calibrations', method: 'POST',
    headers: headers('quality01')
  }, dupData);
  allPass &= printTest('创建校准记录2成功', create2.statusCode === 201);
  const calId2 = create2.body.calibration.id;

  const dupConflict = await request({
    ...baseOptions, path: '/api/calibrations', method: 'POST',
    headers: headers('quality01')
  }, {
    deviceNo: `DEV-T2-${timestamp}`,
    deviceType: 'data_logger',
    certificateNo: `CERT-DUP2-${timestamp}`,
    calibratedAt: '2026-02-01',
    validUntil: '2027-06-01'
  });
  allPass &= printTest('同一设备同一有效期重复录入返回冲突', dupConflict.statusCode === 409,
    `实际: ${dupConflict.statusCode}`);
  allPass &= printTest('冲突响应包含 conflictId', !!dupConflict.body.conflictId);

  const noConflictDiffDate = await request({
    ...baseOptions, path: '/api/calibrations', method: 'POST',
    headers: headers('quality01')
  }, {
    deviceNo: `DEV-T2-${timestamp}`,
    deviceType: 'data_logger',
    certificateNo: `CERT-DUP3-${timestamp}`,
    calibratedAt: '2026-01-01',
    validUntil: '2027-12-01'
  });
  allPass &= printTest('同一设备不同有效期可录入', noConflictDiffDate.statusCode === 201,
    `实际: ${noConflictDiffDate.statusCode}`);
  const calId3 = noConflictDiffDate.body.calibration.id;

  console.log('\n--- 测试组 3: 作废流程 ---\n');

  const voidNoReason = await request({
    ...baseOptions, path: `/api/calibrations/${calId2}/void`, method: 'POST',
    headers: headers('quality01')
  }, { reason: '' });
  allPass &= printTest('作废无原因被拒', voidNoReason.statusCode === 400);

  const voidSuccess = await request({
    ...baseOptions, path: `/api/calibrations/${calId2}/void`, method: 'POST',
    headers: headers('quality01')
  }, { reason: '校准证书遗失，设备已送检' });
  allPass &= printTest('质管作废成功', voidSuccess.statusCode === 200,
    `实际: ${voidSuccess.statusCode}, 错误: ${voidSuccess.body?.error}`);
  allPass &= printTest('作废后状态为 voided', voidSuccess.body.calibration.status === 'voided');
  allPass &= printTest('作废人正确', voidSuccess.body.calibration.voidedByName === '王质管');
  allPass &= printTest('作废原因已记录', voidSuccess.body.calibration.voidReason === '校准证书遗失，设备已送检');

  const voidAgain = await request({
    ...baseOptions, path: `/api/calibrations/${calId2}/void`, method: 'POST',
    headers: headers('quality01')
  }, { reason: '重复作废' });
  allPass &= printTest('重复作废被拒', voidAgain.statusCode === 400);

  const updateVoided = await request({
    ...baseOptions, path: `/api/calibrations/${calId2}`, method: 'PUT',
    headers: headers('quality01')
  }, { certificateNo: 'NEW-CERT' });
  allPass &= printTest('已作废记录不能更新', updateVoided.statusCode === 400);

  console.log('\n--- 测试组 4: 更新与改有效期 ---\n');

  const updateSuccess = await request({
    ...baseOptions, path: `/api/calibrations/${calId1}`, method: 'PUT',
    headers: headers('quality01')
  }, { certificateNo: `CERT-UPDATED-${timestamp}`, remark: '补充校准备注' });
  allPass &= printTest('质管更新校准记录成功', updateSuccess.statusCode === 200,
    `实际: ${updateSuccess.statusCode}, 错误: ${updateSuccess.body?.error}`);
  allPass &= printTest('更新后版本递增', updateSuccess.body.calibration.version === 2);
  allPass &= printTest('更新后证书编号正确', updateSuccess.body.calibration.certificateNo === `CERT-UPDATED-${timestamp}`);
  allPass &= printTest('更新后备注正确', updateSuccess.body.calibration.remark === '补充校准备注');

  const updateConflict = await request({
    ...baseOptions, path: `/api/calibrations/${calId1}`, method: 'PUT',
    headers: headers('quality01')
  }, { expectedVersion: 1, certificateNo: 'CONFLICT' });
  allPass &= printTest('版本冲突返回 409', updateConflict.statusCode === 409);
  allPass &= printTest('冲突响应含 currentVersion', updateConflict.body.currentVersion === 2);

  const changeExpiryNoReason = await request({
    ...baseOptions, path: `/api/calibrations/${calId1}/expiry`, method: 'PUT',
    headers: headers('quality01')
  }, { validUntil: farFutureDate, reason: '' });
  allPass &= printTest('改有效期无原因被拒', changeExpiryNoReason.statusCode === 400);

  const changeExpirySuccess = await request({
    ...baseOptions, path: `/api/calibrations/${calId1}/expiry`, method: 'PUT',
    headers: headers('quality01')
  }, { validUntil: farFutureDate, reason: '延长校准有效期，因延期送检' });
  allPass &= printTest('质管改有效期成功', changeExpirySuccess.statusCode === 200,
    `实际: ${changeExpirySuccess.statusCode}, 错误: ${changeExpirySuccess.body?.error}`);
  allPass &= printTest('改有效期后版本递增', changeExpirySuccess.body.calibration.version === 3);
  allPass &= printTest('新有效期已更新', changeExpirySuccess.body.calibration.validUntil === farFutureDate);

  console.log('\n--- 测试组 5: 设备校验接口 ---\n');

  const validateActive = await request({
    ...baseOptions, path: `/api/calibrations/validate?deviceNo=DEV-T1-${timestamp}`, method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('活跃校准设备校验通过', validateActive.body.valid === true);

  const voidOnlyDevNo = `DEV-VOIDONLY-${timestamp}`;
  const voidOnlyCal = await request({
    ...baseOptions, path: '/api/calibrations', method: 'POST',
    headers: headers('quality01')
  }, {
    deviceNo: voidOnlyDevNo,
    deviceType: 'thermometer',
    certificateNo: `CERT-VOIDONLY-${timestamp}`,
    calibratedAt: '2026-01-01',
    validUntil: futureDate
  });
  allPass &= printTest('创建设备（仅作废测试）成功', voidOnlyCal.statusCode === 201);
  const voidOnlyCalId = voidOnlyCal.body.calibration.id;

  const voidOnlySuccess = await request({
    ...baseOptions, path: `/api/calibrations/${voidOnlyCalId}/void`, method: 'POST',
    headers: headers('quality01')
  }, { reason: '设备已报废' });
  allPass &= printTest('作废仅作废测试设备成功', voidOnlySuccess.statusCode === 200);

  const validateAllVoided = await request({
    ...baseOptions, path: `/api/calibrations/validate?deviceNo=${voidOnlyDevNo}`, method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('全部作废设备校验失败', validateAllVoided.body.valid === false);
  allPass &= printTest('全部作废设备错误类型为 all_voided',
    validateAllVoided.body.errorType === 'all_voided');

  const validatePartialVoided = await request({
    ...baseOptions, path: `/api/calibrations/validate?deviceNo=DEV-T2-${timestamp}`, method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('部分作废但有活跃记录的设备校验通过', validatePartialVoided.body.valid === true);

  const validateNotExist = await request({
    ...baseOptions, path: '/api/calibrations/validate?deviceNo=NOT-EXIST-DEV', method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('不存在设备校验失败', validateNotExist.body.valid === false);
  allPass &= printTest('不存在设备错误类型为 no_record', validateNotExist.body.errorType === 'no_record');

  const expiredDevNo = `DEV-EXP-${timestamp}`;
  const expiredCal = await request({
    ...baseOptions, path: '/api/calibrations', method: 'POST',
    headers: headers('quality01')
  }, {
    deviceNo: expiredDevNo,
    deviceType: 'thermometer',
    certificateNo: `CERT-EXP-${timestamp}`,
    calibratedAt: '2024-01-01',
    validUntil: pastDate
  });
  allPass &= printTest('创建已过期校准记录成功', expiredCal.statusCode === 201);

  const validateExpired = await request({
    ...baseOptions, path: `/api/calibrations/validate?deviceNo=${expiredDevNo}`, method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('过期设备校验失败', validateExpired.body.valid === false);
  allPass &= printTest('过期设备错误类型为 expired', validateExpired.body.errorType === 'expired');

  console.log('\n--- 测试组 6: 导入温度日志时设备校验拦截 ---\n');

  const calDevNo = `DEV-CALREF-${timestamp}`;
  const calFutureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await request({
    ...baseOptions, path: '/api/calibrations', method: 'POST',
    headers: headers('quality01')
  }, {
    deviceNo: calDevNo,
    deviceType: 'data_logger',
    certificateNo: `CERT-REF-${timestamp}`,
    calibratedAt: '2026-01-01',
    validUntil: calFutureDate
  });

  const refBatchNo = `REF-${timestamp}-01`;
  await request({
    ...baseOptions, path: '/api/batches/import', method: 'POST',
    headers: headers('receiver01')
  }, [{ batchNo: refBatchNo, drugName: '校准引用测试药', manufacturer: '测试药厂', quantity: 50 }]);

  const validDeviceLogs = [
    { batchNo: refBatchNo, timestamp: '2024-06-01T08:00:00.000Z', temperature: 4.5, deviceNo: calDevNo },
    { batchNo: refBatchNo, timestamp: '2024-06-01T08:05:00.000Z', temperature: 4.8, deviceNo: calDevNo },
    { batchNo: refBatchNo, timestamp: '2024-06-01T08:10:00.000Z', temperature: 5.0, deviceNo: calDevNo }
  ];
  const validDevImport = await request({
    ...baseOptions, path: `/api/batches/${refBatchNo}/temperature/import`, method: 'POST',
    headers: headers('receiver01')
  }, validDeviceLogs);
  allPass &= printTest('有效设备温度日志导入成功', validDevImport.statusCode === 200,
    `实际: ${validDevImport.statusCode}, 错误: ${validDevImport.body?.error}`);

  const voidDevBatchNo = `VOIDDEV-${timestamp}-01`;
  await request({
    ...baseOptions, path: '/api/batches/import', method: 'POST',
    headers: headers('receiver01')
  }, [{ batchNo: voidDevBatchNo, drugName: '作废设备测试药', manufacturer: '测试药厂', quantity: 50 }]);

  const voidedDevLogs = [
    { batchNo: voidDevBatchNo, timestamp: '2024-06-01T08:00:00.000Z', temperature: 4.5, deviceNo: voidOnlyDevNo },
    { batchNo: voidDevBatchNo, timestamp: '2024-06-01T08:05:00.000Z', temperature: 4.8, deviceNo: voidOnlyDevNo }
  ];
  const voidedDevImport = await request({
    ...baseOptions, path: `/api/batches/${voidDevBatchNo}/temperature/import`, method: 'POST',
    headers: headers('receiver01')
  }, voidedDevLogs);
  allPass &= printTest('作废设备导入温度日志被拦截', voidedDevImport.statusCode === 400,
    `实际: ${voidedDevImport.statusCode}`);
  allPass &= printTest('返回校准校验失败信息',
    voidedDevImport.body.error === '设备校准校验失败',
    `实际: ${voidedDevImport.body.error}`);

  const expDevBatchNo = `EXPDEV-${timestamp}-01`;
  await request({
    ...baseOptions, path: '/api/batches/import', method: 'POST',
    headers: headers('receiver01')
  }, [{ batchNo: expDevBatchNo, drugName: '过期设备测试药', manufacturer: '测试药厂', quantity: 50 }]);

  const expiredDevLogs = [
    { batchNo: expDevBatchNo, timestamp: '2024-06-01T08:00:00.000Z', temperature: 4.5, deviceNo: expiredDevNo },
    { batchNo: expDevBatchNo, timestamp: '2024-06-01T08:05:00.000Z', temperature: 4.8, deviceNo: expiredDevNo }
  ];
  const expiredDevImport = await request({
    ...baseOptions, path: `/api/batches/${expDevBatchNo}/temperature/import`, method: 'POST',
    headers: headers('receiver01')
  }, expiredDevLogs);
  allPass &= printTest('过期设备导入温度日志被拦截', expiredDevImport.statusCode === 400,
    `实际: ${expiredDevImport.statusCode}`);

  const noRecDevBatchNo = `NOREC-${timestamp}-01`;
  await request({
    ...baseOptions, path: '/api/batches/import', method: 'POST',
    headers: headers('receiver01')
  }, [{ batchNo: noRecDevBatchNo, drugName: '无记录设备测试药', manufacturer: '测试药厂', quantity: 50 }]);

  const noRecDevLogs = [
    { batchNo: noRecDevBatchNo, timestamp: '2024-06-01T08:00:00.000Z', temperature: 4.5, deviceNo: 'NO-SUCH-DEVICE' },
    { batchNo: noRecDevBatchNo, timestamp: '2024-06-01T08:05:00.000Z', temperature: 4.8, deviceNo: 'NO-SUCH-DEVICE' }
  ];
  const noRecDevImport = await request({
    ...baseOptions, path: `/api/batches/${noRecDevBatchNo}/temperature/import`, method: 'POST',
    headers: headers('receiver01')
  }, noRecDevLogs);
  allPass &= printTest('无校准记录设备导入温度日志被拦截', noRecDevImport.statusCode === 400);

  console.log('\n--- 测试组 7: 审计日志 ---\n');

  const auditRes = await request({
    ...baseOptions, path: `/api/calibrations/${calId1}/audit`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('审计日志接口可用', auditRes.statusCode === 200);
  const auditLogs = auditRes.body.auditLogs || [];
  allPass &= printTest('包含创建审计', auditLogs.some(l => l.action === 'calibration_create'));
  allPass &= printTest('包含更新审计', auditLogs.some(l => l.action === 'calibration_update'));
  allPass &= printTest('包含改有效期审计', auditLogs.some(l => l.action === 'calibration_change_expiry'));

  const auditRes2 = await request({
    ...baseOptions, path: `/api/calibrations/${calId2}/audit`, method: 'GET',
    headers: headers('quality01')
  });
  const auditLogs2 = auditRes2.body.auditLogs || [];
  allPass &= printTest('包含作废审计', auditLogs2.some(l => l.action === 'calibration_void'));

  console.log('\n--- 测试组 8: 导入导出 ---\n');

  const importRes = await request({
    ...baseOptions, path: '/api/calibrations/import', method: 'POST',
    headers: headers('quality01')
  }, [
    { deviceNo: `DEV-IMP1-${timestamp}`, deviceType: 'thermometer', certificateNo: `CERT-IMP1-${timestamp}`, calibratedAt: '2026-01-01', validUntil: calFutureDate },
    { deviceNo: `DEV-IMP2-${timestamp}`, deviceType: 'data_logger', certificateNo: `CERT-IMP2-${timestamp}`, calibratedAt: '2026-02-01', validUntil: calFutureDate }
  ]);
  allPass &= printTest('批量导入校准记录成功', importRes.statusCode === 200);
  allPass &= printTest('批量导入结果全部成功', importRes.body.allSuccess === true);
  allPass &= printTest('批量导入结果数量正确', importRes.body.results.length === 2);

  const exportJsonRes = await request({
    ...baseOptions, path: '/api/calibrations/export/all?format=json', method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('JSON 导出成功', exportJsonRes.statusCode === 200);
  const exportCalibrations = exportJsonRes.body?.calibrations || [];
  allPass &= printTest('JSON 导出包含记录', exportCalibrations.length > 0);
  const exportedCal1 = exportCalibrations.find(c => c.id === calId1);
  allPass &= printTest('JSON 导出包含 deviceNo', !!exportedCal1?.deviceNo);
  allPass &= printTest('JSON 导出包含 certificateNo', !!exportedCal1?.certificateNo);
  allPass &= printTest('JSON 导出包含 validUntil', !!exportedCal1?.validUntil);
  allPass &= printTest('JSON 导出包含 status', !!exportedCal1?.status);
  allPass &= printTest('JSON 导出包含 deviceType', !!exportedCal1?.deviceType);
  allPass &= printTest('JSON 导出包含 calibratedAt', !!exportedCal1?.calibratedAt);

  const exportCsvRes = await request({
    ...baseOptions, path: '/api/calibrations/export/all?format=csv', method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('CSV 导出成功', exportCsvRes.statusCode === 200);
  const csvStr = typeof exportCsvRes.body === 'string' ? exportCsvRes.body : JSON.stringify(exportCsvRes.body);
  allPass &= printTest('CSV 导出包含 deviceNo 列', csvStr.includes('deviceNo'));
  allPass &= printTest('CSV 导出包含 certificateNo 列', csvStr.includes('certificateNo'));
  allPass &= printTest('CSV 导出包含 validUntil 列', csvStr.includes('validUntil'));
  allPass &= printTest('CSV 导出包含 deviceType 列', csvStr.includes('deviceType'));
  allPass &= printTest('CSV 导出包含 calibratedAt 列', csvStr.includes('calibratedAt'));
  allPass &= printTest('CSV 导出包含 status 列', csvStr.includes('status'));

  const batchExportJson = await request({
    ...baseOptions, path: `/api/batches/${refBatchNo}/export?format=json`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('批次 JSON 导出包含 deviceNos',
    Array.isArray(batchExportJson.body?.batch?.deviceNos) && batchExportJson.body.batch.deviceNos.includes(calDevNo));

  const batchExportCsv = await request({
    ...baseOptions, path: `/api/batches/${refBatchNo}/export?format=csv`, method: 'GET',
    headers: headers('quality01')
  });
  const batchCsvStr = typeof batchExportCsv.body === 'string' ? batchExportCsv.body : JSON.stringify(batchExportCsv.body);
  allPass &= printTest('批次 CSV 导出包含关联设备段', batchCsvStr.includes('# 关联设备'));

  console.log('\n--- 测试组 9: 查询过滤 ---\n');

  const filterByDeviceNo = await request({
    ...baseOptions, path: `/api/calibrations?deviceNo=DEV-T1-${timestamp}`, method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('按设备编号过滤', filterByDeviceNo.body.calibrations.length > 0);
  allPass &= printTest('过滤结果全部匹配',
    filterByDeviceNo.body.calibrations.every(c => c.deviceNo === `DEV-T1-${timestamp}`));

  const filterByStatus = await request({
    ...baseOptions, path: '/api/calibrations?status=voided', method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('按状态过滤', filterByStatus.body.calibrations.length > 0);
  allPass &= printTest('过滤结果全部为 voided',
    filterByStatus.body.calibrations.every(c => c.status === 'voided'));

  console.log('\n--- 测试组 10: 保存重启前状态 ---\n');

  const stateToVerify = {
    calId1,
    calId1DeviceNo: `DEV-T1-${timestamp}`,
    calId1CertificateNo: `CERT-UPDATED-${timestamp}`,
    calId1Status: 'active',
    calId1Version: 3,
    calId1ValidUntil: farFutureDate,
    calId2,
    calId2Status: 'voided',
    calId2VoidReason: '校准证书遗失，设备已送检',
    calId3,
    calId3DeviceNo: `DEV-T2-${timestamp}`,
    expiredDevNo,
    calDevNo,
    refBatchNo,
    refBatchDeviceNos: [calDevNo],
    calibrationCount: (await request({
      ...baseOptions, path: '/api/calibrations', method: 'GET',
      headers: headers('quality01')
    })).body.calibrations.length
  };

  fs.writeFileSync(
    path.join(__dirname, 'data', 'calibration-pre-restart-state.json'),
    JSON.stringify(stateToVerify, null, 2)
  );

  console.log('重启前校准状态已保存到 data/calibration-pre-restart-state.json');
  console.log(`  校准记录总数: ${stateToVerify.calibrationCount}`);
  console.log(`  ${calId1}: deviceNo=${stateToVerify.calId1DeviceNo}, status=active, version=3`);
  console.log(`  ${calId2}: status=voided, voidReason=${stateToVerify.calId2VoidReason}`);
  console.log(`  ${calId3}: deviceNo=${stateToVerify.calId3DeviceNo}, status=active`);

  console.log('\n========================================');
  console.log(allPass ? '全部校准记录回归测试通过！' : '部分测试失败！');
  console.log('========================================');
  console.log('\n请重启服务后运行 node calibration-test-verify.js 验证跨重启数据一致性');

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('测试出错:', err.message);
  console.error(err.stack);
  process.exit(1);
});

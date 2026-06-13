const http = require('http');

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
  console.log('========== 校准记录批量导入越权修复回归测试 ==========\n');
  let allPass = true;
  const timestamp = Date.now();
  const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const receiverDevices = [
    { deviceNo: `R-UNAUTH-${timestamp}-01`, deviceType: 'thermometer', certificateNo: `RCERT-01-${timestamp}`, calibratedAt: '2026-01-01', validUntil: futureDate },
    { deviceNo: `R-UNAUTH-${timestamp}-02`, deviceType: 'data_logger', certificateNo: `RCERT-02-${timestamp}`, calibratedAt: '2026-01-01', validUntil: futureDate }
  ];

  console.log('--- 场景 1: 收货员越权批量导入 ---\n');

  const receiverImport = await request({
    ...baseOptions, path: '/api/calibrations/import', method: 'POST',
    headers: headers('receiver01')
  }, receiverDevices);
  allPass &= printTest('收货员导入返回 400（非 200）',
    receiverImport.statusCode === 400,
    `实际: ${receiverImport.statusCode}, 响应体: ${JSON.stringify(receiverImport.body)}`);
  allPass &= printTest('响应 success 字段为 false',
    receiverImport.body?.success === false,
    `实际 success: ${receiverImport.body?.success}`);
  allPass &= printTest('响应包含明确错误信息',
    typeof receiverImport.body?.error === 'string' && receiverImport.body.error.length > 0,
    `实际 error: ${receiverImport.body?.error}`);
  allPass &= printTest('错误信息与权限相关',
    (receiverImport.body?.error || '').includes('权限'),
    `实际 error: ${receiverImport.body?.error}`);
  allPass &= printTest('响应 allSuccess 字段为 false',
    receiverImport.body?.allSuccess === false,
    `实际 allSuccess: ${receiverImport.body?.allSuccess}`);
  allPass &= printTest('响应 results 数组为空',
    Array.isArray(receiverImport.body?.results) && receiverImport.body.results.length === 0,
    `实际 results: ${JSON.stringify(receiverImport.body?.results)}`);

  console.log('\n--- 场景 2: 药师越权批量导入 ---\n');

  const pharmacistDevices = [
    { deviceNo: `P-UNAUTH-${timestamp}-01`, deviceType: 'thermometer', certificateNo: `PCERT-01-${timestamp}`, calibratedAt: '2026-01-01', validUntil: futureDate }
  ];
  const pharmacistImport = await request({
    ...baseOptions, path: '/api/calibrations/import', method: 'POST',
    headers: headers('pharmacist01')
  }, pharmacistDevices);
  allPass &= printTest('药师导入返回 400',
    pharmacistImport.statusCode === 400,
    `实际: ${pharmacistImport.statusCode}`);
  allPass &= printTest('响应 success 为 false',
    pharmacistImport.body?.success === false,
    `实际 success: ${pharmacistImport.body?.success}`);
  allPass &= printTest('错误信息与权限相关',
    (pharmacistImport.body?.error || '').includes('权限'),
    `实际 error: ${pharmacistImport.body?.error}`);

  console.log('\n--- 场景 3: 确认越权导入数据未落库（持久化验证） ---\n');

  const qmListAfterUnauth = await request({
    ...baseOptions, path: '/api/calibrations', method: 'GET',
    headers: headers('quality01')
  });
  const allDeviceNos = (qmListAfterUnauth.body?.calibrations || []).map(c => c.deviceNo);
  for (const dev of receiverDevices) {
    allPass &= printTest(`收货员设备 ${dev.deviceNo} 未被写入数据库`,
      !allDeviceNos.includes(dev.deviceNo),
      `发现设备号在列表中: ${allDeviceNos}`);
  }
  for (const dev of pharmacistDevices) {
    allPass &= printTest(`药师设备 ${dev.deviceNo} 未被写入数据库`,
      !allDeviceNos.includes(dev.deviceNo),
      `发现设备号在列表中: ${allDeviceNos}`);
  }

  console.log('\n--- 场景 4: 质管正常批量导入（确认未被带坏） ---\n');

  const qmDevices = [
    { deviceNo: `Q-AUTH-${timestamp}-01`, deviceType: 'thermometer', certificateNo: `QCERT-01-${timestamp}`, calibratedAt: '2026-01-01', validUntil: futureDate },
    { deviceNo: `Q-AUTH-${timestamp}-02`, deviceType: 'data_logger', certificateNo: `QCERT-02-${timestamp}`, calibratedAt: '2026-02-01', validUntil: futureDate },
    { deviceNo: `Q-AUTH-${timestamp}-03`, deviceType: 'thermometer', certificateNo: `QCERT-03-${timestamp}`, calibratedAt: '2026-03-01', validUntil: futureDate }
  ];
  const qmImport = await request({
    ...baseOptions, path: '/api/calibrations/import', method: 'POST',
    headers: headers('quality01')
  }, qmDevices);
  allPass &= printTest('质管导入返回 200',
    qmImport.statusCode === 200,
    `实际: ${qmImport.statusCode}, 错误: ${qmImport.body?.error}`);
  allPass &= printTest('质管导入 success 为 true',
    qmImport.body?.success === true,
    `实际 success: ${qmImport.body?.success}`);
  allPass &= printTest('质管导入 allSuccess 为 true',
    qmImport.body?.allSuccess === true,
    `实际 allSuccess: ${qmImport.body?.allSuccess}`);
  allPass &= printTest('质管导入 results 数量正确',
    Array.isArray(qmImport.body?.results) && qmImport.body.results.length === 3,
    `实际长度: ${qmImport.body?.results?.length}`);
  allPass &= printTest('质管导入每条都成功',
    qmImport.body?.results?.every(r => r.success && r.calibrationId),
    `实际 results: ${JSON.stringify(qmImport.body?.results)}`);

  const qmListAfterAuth = await request({
    ...baseOptions, path: '/api/calibrations', method: 'GET',
    headers: headers('quality01')
  });
  const allDeviceNosAfter = (qmListAfterAuth.body?.calibrations || []).map(c => c.deviceNo);
  for (const dev of qmDevices) {
    allPass &= printTest(`质管设备 ${dev.deviceNo} 已写入数据库`,
      allDeviceNosAfter.includes(dev.deviceNo),
      `未找到设备号，现有设备: ${allDeviceNosAfter}`);
  }

  console.log('\n--- 场景 5: 质管正常 CSV 导入（确认未被带坏） ---\n');

  const csvData = `deviceNo,deviceType,certificateNo,calibratedAt,validUntil\nCSV-${timestamp}-01,thermometer,CSV-CERT-1-${timestamp},2026-01-15,${futureDate}\nCSV-${timestamp}-02,data_logger,CSV-CERT-2-${timestamp},2026-01-20,${futureDate}`;
  const csvImport = await request({
    hostname: 'localhost',
    port: 3000,
    method: 'POST',
    path: '/api/calibrations/import?format=csv',
    headers: { 'Content-Type': 'text/plain', 'X-Operator-Id': 'quality01' }
  }, csvData);
  allPass &= printTest('质管 CSV 导入返回 200',
    csvImport.statusCode === 200,
    `实际: ${csvImport.statusCode}, 错误: ${csvImport.body?.error}`);
  allPass &= printTest('质管 CSV 导入 success 为 true',
    csvImport.body?.success === true);
  allPass &= printTest('质管 CSV 导入 allSuccess 为 true',
    csvImport.body?.allSuccess === true);
  allPass &= printTest('质管 CSV 导入 results 数量正确',
    Array.isArray(csvImport.body?.results) && csvImport.body.results.length === 2);

  const qmListAfterCsv = await request({
    ...baseOptions, path: '/api/calibrations', method: 'GET',
    headers: headers('quality01')
  });
  const allDeviceNosCsv = (qmListAfterCsv.body?.calibrations || []).map(c => c.deviceNo);
  allPass &= printTest(`CSV 设备 CSV-${timestamp}-01 已写入数据库`,
    allDeviceNosCsv.includes(`CSV-${timestamp}-01`));
  allPass &= printTest(`CSV 设备 CSV-${timestamp}-02 已写入数据库`,
    allDeviceNosCsv.includes(`CSV-${timestamp}-02`));

  console.log('\n--- 场景 6: 质管 JSON/CSV 导出（确认未被带坏） ---\n');

  const exportJson = await request({
    ...baseOptions, path: '/api/calibrations/export/all?format=json', method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('JSON 导出返回 200',
    exportJson.statusCode === 200,
    `实际: ${exportJson.statusCode}`);
  allPass &= printTest('JSON 导出包含 calibrations 数组',
    Array.isArray(exportJson.body?.calibrations),
    `实际类型: ${typeof exportJson.body?.calibrations}`);
  allPass &= printTest('JSON 导出包含质管导入的数据',
    exportJson.body?.calibrations?.some(c => c.deviceNo === `Q-AUTH-${timestamp}-01`));

  const exportCsv = await request({
    ...baseOptions, path: '/api/calibrations/export/all?format=csv', method: 'GET',
    headers: headers('quality01')
  });
  allPass &= printTest('CSV 导出返回 200',
    exportCsv.statusCode === 200,
    `实际: ${exportCsv.statusCode}`);
  const csvStr = typeof exportCsv.body === 'string' ? exportCsv.body : JSON.stringify(exportCsv.body);
  allPass &= printTest('CSV 导出包含质管导入的设备',
    csvStr.includes(`Q-AUTH-${timestamp}-01`));

  console.log('\n--- 场景 7: 设备校验接口（确认未被带坏） ---\n');

  const validateGood = await request({
    ...baseOptions, path: `/api/calibrations/validate?deviceNo=Q-AUTH-${timestamp}-01`, method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('有效设备校验通过',
    validateGood.statusCode === 200 && validateGood.body?.valid === true);

  const validateBad = await request({
    ...baseOptions, path: `/api/calibrations/validate?deviceNo=R-UNAUTH-${timestamp}-01`, method: 'GET',
    headers: headers('receiver01')
  });
  allPass &= printTest('不存在设备校验失败（no_record）',
    validateBad.statusCode === 200 && validateBad.body?.valid === false && validateBad.body?.errorType === 'no_record');

  console.log('\n--- 场景 8: 质管单条创建校准记录（确认未被带坏） ---\n');

  const singleCreate = await request({
    ...baseOptions, path: '/api/calibrations', method: 'POST',
    headers: headers('quality01')
  }, {
    deviceNo: `SINGLE-${timestamp}`,
    deviceType: 'thermometer',
    certificateNo: `SINGLE-CERT-${timestamp}`,
    calibratedAt: '2026-01-01',
    validUntil: futureDate
  });
  allPass &= printTest('单条创建返回 201',
    singleCreate.statusCode === 201,
    `实际: ${singleCreate.statusCode}, 错误: ${singleCreate.body?.error}`);
  allPass &= printTest('单条创建 success 为 true',
    singleCreate.body?.success === true);
  allPass &= printTest('单条创建后可查询',
    (await request({
      ...baseOptions, path: `/api/calibrations/validate?deviceNo=SINGLE-${timestamp}`, method: 'GET',
      headers: headers('quality01')
    })).body?.valid === true);

  console.log('\n========================================');
  console.log(allPass ? '全部测试通过！越权批量导入漏洞已修复。' : '部分测试失败！');
  console.log('========================================');

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('测试出错:', err.message);
  console.error(err.stack);
  process.exit(1);
});

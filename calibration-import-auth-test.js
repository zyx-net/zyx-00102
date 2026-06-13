const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, fork } = require('child_process');

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

async function findFreePort(startPort = 41000, maxAttempts = 100) {
  for (let p = startPort; p < startPort + maxAttempts; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('无法找到空闲端口');
}

function waitForServer(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const req = http.request({ port, path: '/health', timeout: 500 }, (res) => {
        if (res.statusCode === 200) {
          resolve(true);
        } else if (Date.now() - start < timeoutMs) {
          setTimeout(tryConnect, 200);
        } else {
          reject(new Error('服务启动超时'));
        }
      });
      req.on('error', () => {
        if (Date.now() - start < timeoutMs) {
          setTimeout(tryConnect, 200);
        } else {
          reject(new Error('服务启动超时'));
        }
      });
      req.end();
    };
    tryConnect();
  });
}

function requestJSON(baseUrl, options, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + options.path);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : null, raw: data });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data, raw: data });
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

async function main() {
  console.log('========== 校准导入权限修复 + 临时 dataDir 回归测试 ==========\n');

  // 1. 创建临时 dataDir
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-test-'));
  const tmpDataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(tmpDataDir, { recursive: true });
  console.log(`临时 dataDir: ${tmpDataDir}\n`);

  // 记录原始默认 data 目录快照，用于事后无污染验证
  const defaultDataDir = path.join(__dirname, 'data');
  const defaultSnapshot = fs.readdirSync(defaultDataDir).sort().join(',');

  // 2. 找到空闲端口
  const port = await findFreePort();
  console.log(`使用端口: ${port}\n`);
  const baseUrl = `http://localhost:${port}`;

  // 3. 启动服务器子进程
  const serverPath = path.join(__dirname, 'server.js');
  const serverProc = fork(serverPath, [], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: tmpDataDir
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    silent: true
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});

  let allPass = true;
  let crossRestartState = null;

  try {
    await waitForServer(port);
    const timestamp = Date.now();
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const headers = (opId) => ({ 'Content-Type': 'application/json', 'X-Operator-Id': opId });

    console.log('--- 场景 1: 收货员越权批量导入（应失败） ---\n');

    const receiverDevices = [
      { deviceNo: `R-UNAUTH-${timestamp}-01`, deviceType: 'thermometer', certificateNo: `RCERT-01-${timestamp}`, calibratedAt: '2026-01-01', validUntil: futureDate },
      { deviceNo: `R-UNAUTH-${timestamp}-02`, deviceType: 'data_logger', certificateNo: `RCERT-02-${timestamp}`, calibratedAt: '2026-01-01', validUntil: futureDate }
    ];
    const receiverImport = await requestJSON(baseUrl, {
      path: '/api/calibrations/import',
      method: 'POST',
      headers: headers('receiver01')
    }, receiverDevices);
    allPass &= printTest('收货员导入 HTTP 400', receiverImport.statusCode === 400,
      `实际: ${receiverImport.statusCode}`);
    allPass &= printTest('响应 success: false', receiverImport.body?.success === false,
      `实际 success: ${receiverImport.body?.success}`);
    allPass &= printTest('响应包含权限错误', (receiverImport.body?.error || '').includes('权限'),
      `实际 error: ${receiverImport.body?.error}`);
    allPass &= printTest('响应 allSuccess: false', receiverImport.body?.allSuccess === false,
      `实际 allSuccess: ${receiverImport.body?.allSuccess}`);
    allPass &= printTest('响应 results 为空数组',
      Array.isArray(receiverImport.body?.results) && receiverImport.body.results.length === 0);

    console.log('\n--- 场景 2: 药师越权批量导入（应失败） ---\n');

    const pharmacistDevices = [
      { deviceNo: `P-UNAUTH-${timestamp}-01`, deviceType: 'thermometer', certificateNo: `PCERT-01-${timestamp}`, calibratedAt: '2026-01-01', validUntil: futureDate }
    ];
    const pharmacistImport = await requestJSON(baseUrl, {
      path: '/api/calibrations/import',
      method: 'POST',
      headers: headers('pharmacist01')
    }, pharmacistDevices);
    allPass &= printTest('药师导入 HTTP 400', pharmacistImport.statusCode === 400);
    allPass &= printTest('药师导入 success: false', pharmacistImport.body?.success === false);
    allPass &= printTest('药师导入 error 含权限', (pharmacistImport.body?.error || '').includes('权限'));

    console.log('\n--- 场景 3: 越权导入未落库（持久化验证） ---\n');

    const qmListAfterUnauth = await requestJSON(baseUrl, {
      path: '/api/calibrations',
      method: 'GET',
      headers: headers('quality01')
    });
    const allDeviceNos = (qmListAfterUnauth.body?.calibrations || []).map(c => c.deviceNo);
    for (const dev of receiverDevices) {
      allPass &= printTest(`收货员设备 ${dev.deviceNo} 未落库`, !allDeviceNos.includes(dev.deviceNo));
    }
    for (const dev of pharmacistDevices) {
      allPass &= printTest(`药师设备 ${dev.deviceNo} 未落库`, !allDeviceNos.includes(dev.deviceNo));
    }

    const tmpCalFile = path.join(tmpDataDir, 'calibrations.json');
    let tmpCalContent = '';
    if (fs.existsSync(tmpCalFile)) {
      tmpCalContent = fs.readFileSync(tmpCalFile, 'utf-8');
    }
    allPass &= printTest('临时 calibrations.json 不含越权数据',
      !tmpCalContent.includes('R-UNAUTH-') && !tmpCalContent.includes('P-UNAUTH-'));

    console.log('\n--- 场景 4: 质管正常批量 JSON 导入 ---\n');

    const qmDevices = [
      { deviceNo: `Q-AUTH-${timestamp}-01`, deviceType: 'thermometer', certificateNo: `QCERT-01-${timestamp}`, calibratedAt: '2026-01-01', validUntil: futureDate },
      { deviceNo: `Q-AUTH-${timestamp}-02`, deviceType: 'data_logger', certificateNo: `QCERT-02-${timestamp}`, calibratedAt: '2026-02-01', validUntil: futureDate },
      { deviceNo: `Q-AUTH-${timestamp}-03`, deviceType: 'thermometer', certificateNo: `QCERT-03-${timestamp}`, calibratedAt: '2026-03-01', validUntil: futureDate }
    ];
    const qmImport = await requestJSON(baseUrl, {
      path: '/api/calibrations/import',
      method: 'POST',
      headers: headers('quality01')
    }, qmDevices);
    allPass &= printTest('质管 JSON 导入 HTTP 200', qmImport.statusCode === 200,
      `实际: ${qmImport.statusCode}, 错误: ${qmImport.body?.error}`);
    allPass &= printTest('质管导入 success: true', qmImport.body?.success === true);
    allPass &= printTest('质管导入 allSuccess: true', qmImport.body?.allSuccess === true);
    allPass &= printTest('质管导入 3 条 results',
      Array.isArray(qmImport.body?.results) && qmImport.body.results.length === 3);
    allPass &= printTest('质管导入每条成功',
      qmImport.body?.results?.every(r => r.success && r.calibrationId));

    const qmListAfter = await requestJSON(baseUrl, {
      path: '/api/calibrations',
      method: 'GET',
      headers: headers('quality01')
    });
    const deviceNosAfter = (qmListAfter.body?.calibrations || []).map(c => c.deviceNo);
    for (const dev of qmDevices) {
      allPass &= printTest(`质管设备 ${dev.deviceNo} 已落库`, deviceNosAfter.includes(dev.deviceNo));
    }

    crossRestartState = {
      expectedDeviceNos: qmDevices.map(d => d.deviceNo),
      expectedCount: qmDevices.length,
      firstDeviceNo: qmDevices[0].deviceNo,
      timestamp
    };

    console.log('\n--- 场景 5: 质管正常 CSV 批量导入 ---\n');

    const csvData = `deviceNo,deviceType,certificateNo,calibratedAt,validUntil\nCSV-${timestamp}-01,thermometer,CSV-CERT-1-${timestamp},2026-01-15,${futureDate}\nCSV-${timestamp}-02,data_logger,CSV-CERT-2-${timestamp},2026-01-20,${futureDate}`;
    const csvImport = await requestJSON(baseUrl, {
      path: '/api/calibrations/import?format=csv',
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Operator-Id': 'quality01' }
    }, csvData);
    allPass &= printTest('质管 CSV 导入 HTTP 200', csvImport.statusCode === 200,
      `实际: ${csvImport.statusCode}, 错误: ${csvImport.body?.error}`);
    allPass &= printTest('质管 CSV 导入 success: true', csvImport.body?.success === true);
    allPass &= printTest('质管 CSV 导入 allSuccess: true', csvImport.body?.allSuccess === true);
    allPass &= printTest('质管 CSV 导入 2 条 results',
      Array.isArray(csvImport.body?.results) && csvImport.body.results.length === 2);

    const qmListAfterCsv = await requestJSON(baseUrl, {
      path: '/api/calibrations',
      method: 'GET',
      headers: headers('quality01')
    });
    const deviceNosCsv = (qmListAfterCsv.body?.calibrations || []).map(c => c.deviceNo);
    allPass &= printTest(`CSV-${timestamp}-01 已落库`, deviceNosCsv.includes(`CSV-${timestamp}-01`));
    allPass &= printTest(`CSV-${timestamp}-02 已落库`, deviceNosCsv.includes(`CSV-${timestamp}-02`));

    console.log('\n--- 场景 6: 校准校验接口（确认未被带坏） ---\n');

    const validateGood = await requestJSON(baseUrl, {
      path: `/api/calibrations/validate?deviceNo=Q-AUTH-${timestamp}-01`,
      method: 'GET',
      headers: headers('receiver01')
    });
    allPass &= printTest('有效设备校验 valid: true', validateGood.statusCode === 200 && validateGood.body?.valid === true);

    const validateBad = await requestJSON(baseUrl, {
      path: `/api/calibrations/validate?deviceNo=NO-SUCH-${timestamp}`,
      method: 'GET',
      headers: headers('receiver01')
    });
    allPass &= printTest('不存在设备校验 valid: false + no_record',
      validateBad.statusCode === 200 && validateBad.body?.valid === false && validateBad.body?.errorType === 'no_record');

    console.log('\n--- 场景 7: 质管 JSON/CSV 导出（确认未被带坏） ---\n');

    const exportJson = await requestJSON(baseUrl, {
      path: '/api/calibrations/export/all?format=json',
      method: 'GET',
      headers: headers('quality01')
    });
    allPass &= printTest('JSON 导出 HTTP 200', exportJson.statusCode === 200);
    allPass &= printTest('JSON 导出含 calibrations 数组', Array.isArray(exportJson.body?.calibrations));
    allPass &= printTest(`JSON 导出含 Q-AUTH-${timestamp}-01`,
      exportJson.body?.calibrations?.some(c => c.deviceNo === `Q-AUTH-${timestamp}-01`));
    allPass &= printTest('JSON 导出每条含必需字段',
      exportJson.body?.calibrations?.every(c =>
        c.id && c.deviceNo && c.certificateNo && c.validUntil && c.status && c.deviceType && c.calibratedAt
      ));

    const exportCsv = await requestJSON(baseUrl, {
      path: '/api/calibrations/export/all?format=csv',
      method: 'GET',
      headers: headers('quality01')
    });
    allPass &= printTest('CSV 导出 HTTP 200', exportCsv.statusCode === 200);
    const csvStr = exportCsv.raw || '';
    allPass &= printTest('CSV 导出含 deviceNo 列', csvStr.includes('deviceNo'));
    allPass &= printTest('CSV 导出含 certificateNo 列', csvStr.includes('certificateNo'));
    allPass &= printTest('CSV 导出含 validUntil 列', csvStr.includes('validUntil'));
    allPass &= printTest('CSV 导出含 status 列', csvStr.includes('status'));
    allPass &= printTest(`CSV 导出含 Q-AUTH-${timestamp}-01`, csvStr.includes(`Q-AUTH-${timestamp}-01`));

    console.log('\n--- 场景 8: 服务重启 + 跨重启数据持久化（临时 dataDir） ---\n');

    await new Promise(r => serverProc.kill('SIGTERM') && setTimeout(r, 1500));

    const serverProc2 = fork(serverPath, [], {
      env: { ...process.env, PORT: String(port), DATA_DIR: tmpDataDir },
      silent: true
    });
    serverProc2.stdout.on('data', () => {});
    serverProc2.stderr.on('data', () => {});

    try {
      await waitForServer(port);

      const listAfterRestart = await requestJSON(baseUrl, {
        path: '/api/calibrations',
        method: 'GET',
        headers: headers('quality01')
      });
      const afterRestartDeviceNos = (listAfterRestart.body?.calibrations || []).map(c => c.deviceNo);

      allPass &= printTest('重启后校准记录仍存在',
        listAfterRestart.body?.calibrations?.length >= crossRestartState.expectedCount + 2,
        `实际数量: ${listAfterRestart.body?.calibrations?.length}`);
      for (const dn of crossRestartState.expectedDeviceNos) {
        allPass &= printTest(`重启后 ${dn} 仍存在`, afterRestartDeviceNos.includes(dn));
      }
      allPass &= printTest(`重启后 CSV-${timestamp}-01 仍存在`, afterRestartDeviceNos.includes(`CSV-${timestamp}-01`));
      allPass &= printTest(`重启后 CSV-${timestamp}-02 仍存在`, afterRestartDeviceNos.includes(`CSV-${timestamp}-02`));

      const validateAfterRestart = await requestJSON(baseUrl, {
        path: `/api/calibrations/validate?deviceNo=${crossRestartState.firstDeviceNo}`,
        method: 'GET',
        headers: headers('receiver01')
      });
      allPass &= printTest('重启后设备校验仍通过', validateAfterRestart.body?.valid === true);

      await new Promise(r => serverProc2.kill('SIGTERM') && setTimeout(r, 1000));
    } catch (err) {
      console.error('重启后服务启动失败:', err.message);
      allPass &= printTest('重启服务启动', false, err.message);
      try { serverProc2.kill(); } catch {}
    }

    console.log('\n--- 场景 9: 默认 data 目录无污染验证 ---\n');

    const defaultAfter = fs.readdirSync(defaultDataDir).sort().join(',');
    allPass &= printTest('默认 data 目录文件列表不变',
      defaultSnapshot === defaultAfter,
      `之前: ${defaultSnapshot}\n之后: ${defaultAfter}`);

    const defaultCalFile = path.join(defaultDataDir, 'calibrations.json');
    const defaultCalContent = fs.readFileSync(defaultCalFile, 'utf-8');
    allPass &= printTest('默认 calibrations.json 仍为空 {}', defaultCalContent.trim() === '{}',
      `实际内容: ${defaultCalContent.trim().slice(0, 100)}`);

    allPass &= printTest(`默认 calibrations.json 不含 Q-AUTH-${timestamp}-01`,
      !defaultCalContent.includes(`Q-AUTH-${timestamp}-01`));
    allPass &= printTest(`默认 calibrations.json 不含 CSV-${timestamp}-01`,
      !defaultCalContent.includes(`CSV-${timestamp}-01`));
    allPass &= printTest(`默认 calibrations.json 不含 R-UNAUTH-${timestamp}-01`,
      !defaultCalContent.includes(`R-UNAUTH-${timestamp}-01`));

    console.log('\n========================================');
    console.log(allPass ? '全部测试通过！越权导入漏洞已修复，默认 data 目录无污染。' : '部分测试失败！');
    console.log('========================================');

  } catch (err) {
    console.error('测试运行出错:', err.message);
    console.error(err.stack);
    allPass = false;
  } finally {
    // 清理子进程
    try { if (!serverProc.killed) serverProc.kill(); } catch {}

    // 清理临时目录
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    console.log(`\n临时目录已清理: ${tmpRoot}`);
  }

  process.exit(allPass ? 0 : 1);
}

main();

const http = require('http');

const BASE_URL = 'http://localhost:3000';
const TEST_BATCH_NO = 'TEST-BATCH-001';

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = body ? JSON.parse(body) : {};
          resolve({ statusCode: res.statusCode, ...json });
        } catch {
          resolve({ statusCode: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.log(`✗ ${name}`);
    console.error(`  Error: ${error.message}`);
    throw error;
  }
}

async function runTests() {
  let actionId = null;
  let initialVersion = null;

  console.log('\n=== 供应商到货异常整改模块回归测试 ===\n');

  await test('1. 创建整改单 - 收货员有权限', async () => {
    const options = {
      method: 'POST',
      hostname: 'localhost',
      port: 3000,
      path: '/api/corrective-actions',
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Id': 'receiver01'
      }
    };
    const data = {
      batchNo: TEST_BATCH_NO,
      source: 'batch_review',
      severity: 'moderate',
      supplierId: 'SUP001',
      supplierName: '测试供应商',
      description: '批次复核发现外包装破损',
      attachmentSummary: '照片3张',
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    };
    const result = await request(options, data);
    if (result.statusCode !== 201 || !result.success) {
      throw new Error(`创建失败: ${result.error || JSON.stringify(result)}`);
    }
    actionId = result.correctiveAction.id;
    initialVersion = result.correctiveAction.version;
    if (result.correctiveAction.status !== 'draft') {
      throw new Error(`初始状态应为draft，实际为${result.correctiveAction.status}`);
    }
    console.log(`  创建的整改单ID: ${actionId}`);
  });

  await test('2. 同一批次重复创建 - 应拒绝', async () => {
    const options = {
      method: 'POST',
      hostname: 'localhost',
      port: 3000,
      path: '/api/corrective-actions',
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Id': 'receiver01'
      }
    };
    const data = {
      batchNo: TEST_BATCH_NO,
      source: 'temp_deviation',
      severity: 'minor',
      supplierId: 'SUP001',
      description: '温度偏差问题'
    };
    const result = await request(options, data);
    if (result.statusCode !== 409 || result.success) {
      throw new Error(`应返回409冲突，实际返回${result.statusCode}: ${result.error}`);
    }
  });

  await test('3. 供应商联系人创建整改单 - 应拒绝（越权）', async () => {
    const options = {
      method: 'POST',
      hostname: 'localhost',
      port: 3000,
      path: '/api/corrective-actions',
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Id': 'supplier01'
      }
    };
    const data = {
      batchNo: 'OTHER-BATCH',
      source: 'batch_review',
      severity: 'minor',
      supplierId: 'SUP001',
      description: '测试越权'
    };
    const result = await request(options, data);
    if (result.statusCode !== 400 || result.success) {
      throw new Error(`应返回400无权限，实际返回${result.statusCode}: ${result.error}`);
    }
  });

  await test('4. 提交整改单等待分派', async () => {
    const options = {
      method: 'POST',
      hostname: 'localhost',
      port: 3000,
      path: `/api/corrective-actions/${actionId}/submit`,
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Id': 'receiver01'
      }
    };
    const result = await request(options, { expectedVersion: initialVersion });
    if (result.statusCode !== 200 || !result.success) {
      throw new Error(`提交失败: ${result.error}`);
    }
    if (result.correctiveAction.status !== 'pending_assign') {
      throw new Error(`状态应为pending_assign，实际为${result.correctiveAction.status}`);
    }
    initialVersion = result.correctiveAction.version;
  });

  await test('5. 质管分派整改单给供应商', async () => {
    const options = {
      method: 'POST',
      hostname: 'localhost',
      port: 3000,
      path: `/api/corrective-actions/${actionId}/assign`,
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Id': 'quality01'
      }
    };
    const result = await request(options, { assigneeId: 'supplier01', expectedVersion: initialVersion });
    if (result.statusCode !== 200 || !result.success) {
      throw new Error(`分派失败: ${result.error}`);
    }
    if (result.correctiveAction.status !== 'assigned') {
      throw new Error(`状态应为assigned，实际为${result.correctiveAction.status}`);
    }
    if (result.correctiveAction.assignedTo !== 'supplier01') {
      throw new Error(`被分派人错误`);
    }
    initialVersion = result.correctiveAction.version;
  });

  await test('6. 供应商联系人提交整改说明', async () => {
    const options = {
      method: 'POST',
      hostname: 'localhost',
      port: 3000,
      path: `/api/corrective-actions/${actionId}/response`,
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Id': 'supplier01'
      }
    };
    const result = await request(options, {
      response: '已重新更换外包装，确保运输过程中的保护措施',
      responseEvidence: '整改前后对比照片',
      expectedVersion: initialVersion
    });
    if (result.statusCode !== 200 || !result.success) {
      throw new Error(`提交整改说明失败: ${result.error}`);
    }
    if (result.correctiveAction.status !== 'pending_verification') {
      throw new Error(`状态应为pending_verification，实际为${result.correctiveAction.status}`);
    }
    initialVersion = result.correctiveAction.version;
  });

  await test('7. 供应商提交非分派给自己的整改单 - 应拒绝', async () => {
    const options = {
      method: 'POST',
      hostname: 'localhost',
      port: 3000,
      path: `/api/corrective-actions/${actionId}/response`,
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Id': 'supplier01'
      }
    };
    const result = await request(options, {
      response: '测试',
      expectedVersion: initialVersion + 1
    });
    if (result.statusCode !== 409 || result.success) {
      throw new Error(`应返回409版本冲突，实际返回${result.statusCode}: ${result.error}`);
    }
  });

  await test('8. 质管验收通过整改', async () => {
    const options = {
      method: 'POST',
      hostname: 'localhost',
      port: 3000,
      path: `/api/corrective-actions/${actionId}/approve`,
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Id': 'quality01'
      }
    };
    const result = await request(options, {
      note: '整改措施有效，验收通过',
      expectedVersion: initialVersion
    });
    if (result.statusCode !== 200 || !result.success) {
      throw new Error(`验收失败: ${result.error}`);
    }
    if (result.correctiveAction.status !== 'approved') {
      throw new Error(`状态应为approved，实际为${result.correctiveAction.status}`);
    }
    initialVersion = result.correctiveAction.version;
  });

  await test('9. 质管关闭整改单', async () => {
    const options = {
      method: 'POST',
      hostname: 'localhost',
      port: 3000,
      path: `/api/corrective-actions/${actionId}/close`,
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Id': 'quality01'
      }
    };
    const result = await request(options, {
      note: '整改完成，关闭整改单',
      expectedVersion: initialVersion
    });
    if (result.statusCode !== 200 || !result.success) {
      throw new Error(`关闭失败: ${result.error}`);
    }
    if (result.correctiveAction.status !== 'closed') {
      throw new Error(`状态应为closed，实际为${result.correctiveAction.status}`);
    }
    initialVersion = result.correctiveAction.version;
  });

  await test('10. 关闭后尝试退回 - 应拒绝（状态非法流转）', async () => {
    const options = {
      method: 'POST',
      hostname: 'localhost',
      port: 3000,
      path: `/api/corrective-actions/${actionId}/return`,
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Id': 'quality01'
      }
    };
    const result = await request(options, {
      reason: '重新整改',
      expectedVersion: initialVersion
    });
    if (result.statusCode !== 400 || result.success) {
      throw new Error(`应返回400状态非法流转，实际返回${result.statusCode}: ${result.error}`);
    }
  });

  await test('11. 导出整改单列表(JSON)', async () => {
    const options = {
      method: 'GET',
      hostname: 'localhost',
      port: 3000,
      path: '/api/corrective-actions/export/all?format=json',
      headers: {
        'X-Operator-Id': 'quality01'
      }
    };
    const result = await request(options);
    if (result.statusCode !== 200) {
      throw new Error(`导出失败: ${result.statusCode}`);
    }
    if (!result.correctiveActions || !Array.isArray(result.correctiveActions)) {
      throw new Error('导出格式错误');
    }
  });

  await test('12. 导出整改单列表(CSV)', async () => {
    const options = {
      method: 'GET',
      hostname: 'localhost',
      port: 3000,
      path: '/api/corrective-actions/export/all?format=csv',
      headers: {
        'X-Operator-Id': 'quality01'
      }
    };
    const result = await request(options);
    if (result.statusCode !== 200) {
      throw new Error(`导出失败: ${result.statusCode}`);
    }
    if (typeof result.body !== 'string' || !result.body.includes('id,batchNo')) {
      throw new Error('CSV格式错误');
    }
  });

  await test('13. 按批次查询整改单', async () => {
    const options = {
      method: 'GET',
      hostname: 'localhost',
      port: 3000,
      path: `/api/corrective-actions/batch/${TEST_BATCH_NO}`,
      headers: {
        'X-Operator-Id': 'quality01'
      }
    };
    const result = await request(options);
    if (result.statusCode !== 200) {
      throw new Error(`查询失败: ${result.statusCode}`);
    }
    const actions = result.correctiveActions || [];
    if (actions.length !== 1 || actions[0].id !== actionId) {
      throw new Error('查询结果不正确');
    }
  });

  await test('14. 按供应商查询整改单', async () => {
    const options = {
      method: 'GET',
      hostname: 'localhost',
      port: 3000,
      path: '/api/corrective-actions/supplier/SUP001',
      headers: {
        'X-Operator-Id': 'quality01'
      }
    };
    const result = await request(options);
    if (result.statusCode !== 200) {
      throw new Error(`查询失败: ${result.statusCode}`);
    }
    const actions = result.correctiveActions || [];
    if (actions.length === 0) {
      throw new Error('未找到供应商的整改单');
    }
  });

  await test('15. 查看整改单详情及审计日志', async () => {
    const options = {
      method: 'GET',
      hostname: 'localhost',
      port: 3000,
      path: `/api/corrective-actions/${actionId}`,
      headers: {
        'X-Operator-Id': 'quality01'
      }
    };
    const result = await request(options);
    if (result.statusCode !== 200) {
      throw new Error(`查询失败: ${result.statusCode}`);
    }
    if (!result.correctiveAction || !result.correctiveAction.auditLogs) {
      throw new Error('详情格式错误');
    }
    if (result.correctiveAction.auditLogs.length < 5) {
      throw new Error('审计日志不足');
    }
  });

  console.log('\n=== 所有测试通过 ===\n');
  console.log(`创建的整改单ID: ${actionId}`);
  console.log(`最终版本号: ${initialVersion}`);
  console.log(`状态流转: draft -> pending_assign -> assigned -> pending_verification -> approved -> closed`);
}

runTests().catch((error) => {
  console.error('\n测试失败:', error.message);
  process.exit(1);
});
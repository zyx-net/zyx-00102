const storage = require('../storage');
const config = require('../config');

const INSPECTION_STATUS = config.inspectionStatus;
const INSPECTION_PERMS = config.inspectionPermissions;
const ROLES = config.roles;

const STATUS_TRANSITIONS = {
  [INSPECTION_STATUS.PENDING]: [INSPECTION_STATUS.SUBMITTED],
  [INSPECTION_STATUS.SUBMITTED]: [INSPECTION_STATUS.APPROVED, INSPECTION_STATUS.RETURNED],
  [INSPECTION_STATUS.RETURNED]: [INSPECTION_STATUS.SUBMITTED],
  [INSPECTION_STATUS.APPROVED]: []
};

function findUser(userId) {
  return config.users.find(u => u.id === userId) || null;
}

function hasInspectionPermission(userRole, action) {
  const perms = INSPECTION_PERMS[userRole.toUpperCase()] || [];
  return perms.includes(action);
}

function canTransition(currentStatus, targetStatus) {
  const allowed = STATUS_TRANSITIONS[currentStatus] || [];
  return allowed.includes(targetStatus);
}

function generateInspectionId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `INS-${dateStr}-${rand}`;
}

function validateInspectionData(data) {
  const errors = [];
  if (!data.batchNo || typeof data.batchNo !== 'string' || data.batchNo.trim() === '') {
    errors.push('缺少批次号');
  }
  if (!data.inspectionItems || !Array.isArray(data.inspectionItems) || data.inspectionItems.length === 0) {
    errors.push('抽检项目不能为空');
  } else {
    for (let i = 0; i < data.inspectionItems.length; i++) {
      const item = data.inspectionItems[i];
      if (!item.name || typeof item.name !== 'string' || item.name.trim() === '') {
        errors.push(`第${i + 1}项抽检项目缺少名称`);
      }
      if (!item.criteria || typeof item.criteria !== 'string' || item.criteria.trim() === '') {
        errors.push(`第${i + 1}项抽检项目缺少判定标准`);
      }
    }
  }
  if (data.sampleQuantity === undefined || data.sampleQuantity === null) {
    errors.push('缺少抽样数量');
  } else if (typeof data.sampleQuantity !== 'number' || data.sampleQuantity <= 0) {
    errors.push('抽样数量必须是大于0的数字');
  }
  if (!data.deadline) {
    errors.push('缺少截止时间');
  } else if (isNaN(new Date(data.deadline).getTime())) {
    errors.push('截止时间格式无效');
  }
  return { valid: errors.length === 0, errors };
}

function validateInspectionResults(items) {
  const errors = [];
  if (!items || !Array.isArray(items) || items.length === 0) {
    errors.push('检测结果不能为空');
  } else {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.name || typeof item.name !== 'string' || item.name.trim() === '') {
        errors.push(`第${i + 1}项结果缺少项目名称`);
      }
      if (item.result === undefined || item.result === null || item.result === '') {
        errors.push(`第${i + 1}项结果缺少检测结果`);
      }
      if (item.passed === undefined || item.passed === null || typeof item.passed !== 'boolean') {
        errors.push(`第${i + 1}项结果缺少是否合格标识`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function createInspection(data, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasInspectionPermission(operator.role, 'create')) {
    return { success: false, error: '无权限创建抽检任务' };
  }

  const validation = validateInspectionData(data);
  if (!validation.valid) {
    return { success: false, error: '抽检任务校验失败', errors: validation.errors };
  }

  const batch = storage.getBatch(data.batchNo.trim());
  if (!batch) {
    return { success: false, error: `批次 ${data.batchNo} 不存在，请先导入批次` };
  }

  const activeInspection = storage.getActiveInspectionForBatch(data.batchNo.trim());
  if (activeInspection) {
    return {
      success: false,
      error: `批次 ${data.batchNo} 已存在未完成的抽检任务（${activeInspection.id}），请勿重复创建`,
      conflict: true,
      conflictId: activeInspection.id
    };
  }

  const now = new Date().toISOString();
  const inspection = {
    id: generateInspectionId(),
    batchNo: data.batchNo.trim(),
    drugName: batch.drugName || '',
    inspectionItems: data.inspectionItems.map(item => ({
      name: item.name.trim(),
      criteria: item.criteria.trim(),
      method: item.method || '',
      result: '',
      passed: null,
      remark: ''
    })),
    sampleQuantity: data.sampleQuantity,
    sampleUnit: data.sampleUnit || batch.unit || '盒',
    deadline: data.deadline,
    status: INSPECTION_STATUS.PENDING,
    createdBy: operatorId,
    createdByName: operator.name,
    createdAt: now,
    updatedAt: now,
    submittedBy: null,
    submittedByName: null,
    submittedAt: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    returnedBy: null,
    returnedByName: null,
    returnedAt: null,
    returnReason: '',
    overallPassed: null,
    conclusion: '',
    version: 1
  };

  storage.saveInspection(inspection);
  storage.addInspectionAuditLog(inspection.id, {
    action: 'inspection_create',
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: '创建抽检任务',
    timestamp: now,
    detail: {
      batchNo: inspection.batchNo,
      sampleQuantity: inspection.sampleQuantity,
      deadline: inspection.deadline,
      itemCount: inspection.inspectionItems.length,
      version: inspection.version
    }
  });

  return { success: true, inspection };
}

function getInspectionDetail(inspectionId) {
  const inspection = storage.getInspection(inspectionId);
  if (!inspection) {
    return null;
  }
  const auditLogs = storage.getInspectionAuditLogs(inspectionId);
  return { inspection, auditLogs };
}

function listAllInspections(filters, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasInspectionPermission(operator.role, 'view')) {
    return { success: false, error: '无权限查看抽检任务' };
  }

  let records = storage.listInspections();
  if (filters) {
    if (filters.batchNo) {
      records = records.filter(i => i.batchNo === filters.batchNo);
    }
    if (filters.status) {
      records = records.filter(i => i.status === filters.status);
    }
  }
  return { success: true, inspections: records };
}

function getInspectionsByBatch(batchNo, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasInspectionPermission(operator.role, 'view')) {
    return { success: false, error: '无权限查看抽检任务' };
  }

  const records = storage.getInspectionsByBatch(batchNo);
  return { success: true, inspections: records };
}

function submitInspectionResult(inspectionId, resultData, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasInspectionPermission(operator.role, 'submit_result')) {
    return { success: false, error: '无权限提交检测结果' };
  }

  const inspection = storage.getInspection(inspectionId);
  if (!inspection) {
    return { success: false, error: '抽检任务不存在' };
  }

  if (inspection.status !== INSPECTION_STATUS.PENDING && inspection.status !== INSPECTION_STATUS.RETURNED) {
    return {
      success: false,
      error: `当前状态为 ${inspection.status}，不允许提交检测结果`,
      invalidStatus: true
    };
  }

  const resultValidation = validateInspectionResults(resultData.items || []);
  if (!resultValidation.valid) {
    return { success: false, error: '检测结果校验失败', errors: resultValidation.errors };
  }

  if (resultData.expectedVersion !== undefined && inspection.version !== resultData.expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${inspection.version}，预期版本: ${resultData.expectedVersion}`,
      conflict: true,
      currentVersion: inspection.version
    };
  }

  const now = new Date().toISOString();
  const beforeSnapshot = JSON.parse(JSON.stringify(inspection));

  const resultMap = new Map();
  (resultData.items || []).forEach(item => {
    resultMap.set(item.name, item);
  });

  inspection.inspectionItems = inspection.inspectionItems.map(item => {
    const result = resultMap.get(item.name);
    if (result) {
      return {
        ...item,
        result: String(result.result),
        passed: result.passed,
        remark: result.remark || item.remark || ''
      };
    }
    return item;
  });

  const allPassed = inspection.inspectionItems.every(item => item.passed === true);
  inspection.overallPassed = allPassed;
  inspection.conclusion = resultData.conclusion || (allPassed ? '全部合格' : '存在不合格项');

  const fromStatus = inspection.status;
  inspection.status = INSPECTION_STATUS.SUBMITTED;
  inspection.submittedBy = operatorId;
  inspection.submittedByName = operator.name;
  inspection.submittedAt = now;
  inspection.updatedAt = now;
  inspection.version += 1;

  storage.saveInspection(inspection);
  storage.addInspectionAuditLog(inspectionId, {
    action: 'inspection_submit',
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: '提交检测结果',
    timestamp: now,
    detail: {
      fromStatus,
      toStatus: INSPECTION_STATUS.SUBMITTED,
      overallPassed: inspection.overallPassed,
      version: inspection.version,
      before: { status: beforeSnapshot.status, version: beforeSnapshot.version },
      after: { status: inspection.status, version: inspection.version }
    }
  });

  return { success: true, inspection };
}

function approveInspection(inspectionId, approvalData, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasInspectionPermission(operator.role, 'approve')) {
    return { success: false, error: '无权限确认抽检结果' };
  }

  const inspection = storage.getInspection(inspectionId);
  if (!inspection) {
    return { success: false, error: '抽检任务不存在' };
  }

  if (inspection.status !== INSPECTION_STATUS.SUBMITTED) {
    return {
      success: false,
      error: `当前状态为 ${inspection.status}，不允许确认`,
      invalidStatus: true
    };
  }

  if (approvalData?.expectedVersion !== undefined && inspection.version !== approvalData.expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${inspection.version}，预期版本: ${approvalData.expectedVersion}`,
      conflict: true,
      currentVersion: inspection.version
    };
  }

  const now = new Date().toISOString();
  const fromStatus = inspection.status;

  inspection.status = INSPECTION_STATUS.APPROVED;
  inspection.approvedBy = operatorId;
  inspection.approvedByName = operator.name;
  inspection.approvedAt = now;
  inspection.updatedAt = now;
  inspection.version += 1;
  if (approvalData?.conclusion) {
    inspection.conclusion = approvalData.conclusion;
  }

  storage.saveInspection(inspection);
  storage.addInspectionAuditLog(inspectionId, {
    action: 'inspection_approve',
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: (approvalData?.reason || '确认抽检通过').trim(),
    timestamp: now,
    detail: {
      fromStatus,
      toStatus: INSPECTION_STATUS.APPROVED,
      version: inspection.version
    }
  });

  return { success: true, inspection };
}

function returnInspection(inspectionId, returnData, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasInspectionPermission(operator.role, 'return')) {
    return { success: false, error: '无权限退回抽检任务' };
  }

  const inspection = storage.getInspection(inspectionId);
  if (!inspection) {
    return { success: false, error: '抽检任务不存在' };
  }

  if (inspection.status !== INSPECTION_STATUS.SUBMITTED) {
    return {
      success: false,
      error: `当前状态为 ${inspection.status}，不允许退回`,
      invalidStatus: true
    };
  }

  if (!returnData?.reason || returnData.reason.trim() === '') {
    return { success: false, error: '退回必须填写原因' };
  }

  if (returnData.expectedVersion !== undefined && inspection.version !== returnData.expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${inspection.version}，预期版本: ${returnData.expectedVersion}`,
      conflict: true,
      currentVersion: inspection.version
    };
  }

  const now = new Date().toISOString();
  const fromStatus = inspection.status;

  inspection.status = INSPECTION_STATUS.RETURNED;
  inspection.returnedBy = operatorId;
  inspection.returnedByName = operator.name;
  inspection.returnedAt = now;
  inspection.returnReason = returnData.reason.trim();
  inspection.updatedAt = now;
  inspection.version += 1;

  storage.saveInspection(inspection);
  storage.addInspectionAuditLog(inspectionId, {
    action: 'inspection_return',
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: returnData.reason.trim(),
    timestamp: now,
    detail: {
      fromStatus,
      toStatus: INSPECTION_STATUS.RETURNED,
      version: inspection.version
    }
  });

  return { success: true, inspection };
}

module.exports = {
  createInspection,
  getInspectionDetail,
  listAllInspections,
  getInspectionsByBatch,
  submitInspectionResult,
  approveInspection,
  returnInspection,
  findUser,
  hasInspectionPermission,
  INSPECTION_STATUS,
  canTransition,
  validateInspectionData,
  validateInspectionResults
};

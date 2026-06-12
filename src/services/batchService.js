const storage = require('../storage');
const config = require('../config');
const { validateTemperatureLogs } = require('./temperatureService');

const STATUS = config.status;
const ROLES = config.roles;

const STATUS_TRANSITIONS = {
  [STATUS.PENDING_REVIEW]: [STATUS.QUARANTINED, STATUS.VOIDED],
  [STATUS.QUARANTINED]: [STATUS.RELEASED, STATUS.REJECTED, STATUS.PENDING_REVIEW],
  [STATUS.RELEASED]: [STATUS.VOIDED],
  [STATUS.REJECTED]: [STATUS.VOIDED],
  [STATUS.VOIDED]: []
};

const ROLE_PERMISSIONS = {
  [ROLES.RECEIVER]: ['import', 'view'],
  [ROLES.PHARMACIST]: ['review', 'quarantine', 'view'],
  [ROLES.QUALITY_MANAGER]: ['release', 'reject', 'void', 'view']
};

function hasPermission(userRole, action) {
  const permissions = ROLE_PERMISSIONS[userRole] || [];
  return permissions.includes(action);
}

function canTransition(currentStatus, targetStatus) {
  const allowed = STATUS_TRANSITIONS[currentStatus] || [];
  return allowed.includes(targetStatus);
}

function findUser(userId) {
  return config.users.find(u => u.id === userId) || null;
}

function createBatch(batchData, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'import')) {
    return { success: false, error: '无权限导入批次' };
  }

  const existing = storage.getBatch(batchData.batchNo);
  if (existing) {
    return { success: false, error: `批号 ${batchData.batchNo} 已存在` };
  }

  const batch = {
    batchNo: batchData.batchNo,
    drugName: batchData.drugName,
    manufacturer: batchData.manufacturer,
    quantity: batchData.quantity,
    unit: batchData.unit || '盒',
    productionDate: batchData.productionDate,
    expiryDate: batchData.expiryDate,
    arrivalDate: batchData.arrivalDate || new Date().toISOString(),
    status: STATUS.PENDING_REVIEW,
    createdAt: new Date().toISOString(),
    createdBy: operatorId,
    temperatureValid: null,
    overTempRanges: [],
    temperatureErrors: [],
    temperatureWarnings: []
  };

  storage.saveBatch(batch);
  storage.addAuditLog(batchData.batchNo, {
    action: 'import',
    fromStatus: null,
    toStatus: STATUS.PENDING_REVIEW,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: '收货员导入到货记录',
    timestamp: new Date().toISOString()
  });

  return { success: true, batch };
}

function importTemperatureLogs(batchNo, logs, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'import')) {
    return { success: false, error: '无权限导入温度日志' };
  }

  const batch = storage.getBatch(batchNo);
  if (!batch) {
    return { success: false, error: `批号 ${batchNo} 不存在` };
  }

  const validation = validateTemperatureLogs(logs, batchNo);

  if (!validation.valid) {
    return {
      success: false,
      error: '温度日志校验失败',
      errors: validation.errors,
      warnings: validation.warnings
    };
  }

  storage.saveTemperatureLogs(batchNo, logs);

  batch.temperatureValid = true;
  batch.overTempRanges = validation.overTempRanges;
  batch.temperatureErrors = validation.errors;
  batch.temperatureWarnings = validation.warnings;
  storage.saveBatch(batch);

  storage.addAuditLog(batchNo, {
    action: 'import_temperature',
    fromStatus: batch.status,
    toStatus: batch.status,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: `导入温度日志 ${logs.length} 条`,
    timestamp: new Date().toISOString(),
    detail: {
      logCount: logs.length,
      overTempCount: validation.overTempRanges.length
    }
  });

  return {
    success: true,
    batch,
    overTempRanges: validation.overTempRanges
  };
}

function reviewBatch(batchNo, operatorId, decision, reason) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'review') && !hasPermission(operator.role, 'quarantine')) {
    return { success: false, error: '无权限复核批次' };
  }

  const batch = storage.getBatch(batchNo);
  if (!batch) {
    return { success: false, error: `批号 ${batchNo} 不存在` };
  }

  let targetStatus;
  let action;

  if (decision === 'quarantine') {
    targetStatus = STATUS.QUARANTINED;
    action = 'quarantine';
    if (!hasPermission(operator.role, 'quarantine')) {
      return { success: false, error: '无权限隔离批次' };
    }
  } else if (decision === 'pass') {
    targetStatus = STATUS.QUARANTINED;
    action = 'review_pass';
  } else {
    return { success: false, error: '无效的复核决定' };
  }

  if (!canTransition(batch.status, targetStatus)) {
    return { success: false, error: `不能从 ${batch.status} 状态转换到 ${targetStatus}` };
  }

  const fromStatus = batch.status;
  batch.status = targetStatus;
  batch.reviewedBy = operatorId;
  batch.reviewedAt = new Date().toISOString();
  storage.saveBatch(batch);

  storage.addAuditLog(batchNo, {
    action,
    fromStatus,
    toStatus: targetStatus,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: reason || '药师复核完成',
    timestamp: new Date().toISOString()
  });

  return { success: true, batch };
}

function finalizeBatch(batchNo, operatorId, decision, reason) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }

  const batch = storage.getBatch(batchNo);
  if (!batch) {
    return { success: false, error: `批号 ${batchNo} 不存在` };
  }

  let targetStatus;
  let action;

  if (decision === 'release') {
    targetStatus = STATUS.RELEASED;
    action = 'release';
    if (!hasPermission(operator.role, 'release')) {
      return { success: false, error: '无权限放行批次' };
    }
  } else if (decision === 'reject') {
    targetStatus = STATUS.REJECTED;
    action = 'reject';
    if (!hasPermission(operator.role, 'reject')) {
      return { success: false, error: '无权限拒收批次' };
    }
  } else if (decision === 'void') {
    targetStatus = STATUS.VOIDED;
    action = 'void';
    if (!hasPermission(operator.role, 'void')) {
      return { success: false, error: '无权限作废批次' };
    }
  } else {
    return { success: false, error: '无效的决定' };
  }

  if (!canTransition(batch.status, targetStatus)) {
    return { success: false, error: `不能从 ${batch.status} 状态转换到 ${targetStatus}` };
  }

  const fromStatus = batch.status;
  batch.status = targetStatus;
  batch.finalizedBy = operatorId;
  batch.finalizedAt = new Date().toISOString();
  batch.finalReason = reason || '';
  storage.saveBatch(batch);

  storage.addAuditLog(batchNo, {
    action,
    fromStatus,
    toStatus: targetStatus,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: reason || (decision === 'release' ? '质管负责人放行' : '质管负责人拒收'),
    timestamp: new Date().toISOString()
  });

  return { success: true, batch };
}

function getBatchDetail(batchNo) {
  const batch = storage.getBatch(batchNo);
  if (!batch) {
    return null;
  }
  const temperatureLogs = storage.getTemperatureLogs(batchNo);
  const auditLogs = storage.getAuditLogs(batchNo);
  return {
    batch,
    temperatureLogs,
    auditLogs: auditLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
  };
}

function listAllBatches() {
  return storage.listBatches();
}

module.exports = {
  createBatch,
  importTemperatureLogs,
  reviewBatch,
  finalizeBatch,
  getBatchDetail,
  listAllBatches,
  hasPermission,
  findUser,
  STATUS,
  ROLES
};

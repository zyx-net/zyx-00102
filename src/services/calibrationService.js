const storage = require('../storage');
const config = require('../config');

const CAL_STATUS = config.calibrationStatus;
const DEV_TYPES = config.deviceType;
const CAL_PERMS = config.calibrationPermissions;
const ROLES = config.roles;

function findUser(userId) {
  return config.users.find(u => u.id === userId) || null;
}

function hasCalibrationPermission(userRole, action) {
  const perms = CAL_PERMS[userRole.toUpperCase()] || [];
  return perms.includes(action);
}

function generateCalibrationId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `CAL-${dateStr}-${rand}`;
}

function validateCalibrationData(data) {
  const errors = [];
  if (!data.deviceNo || typeof data.deviceNo !== 'string' || data.deviceNo.trim() === '') {
    errors.push('缺少设备编号');
  }
  if (!data.deviceType || ![DEV_TYPES.THERMOMETER, DEV_TYPES.DATA_LOGGER].includes(data.deviceType)) {
    errors.push('设备类型必须是 thermometer 或 data_logger');
  }
  if (!data.certificateNo || typeof data.certificateNo !== 'string' || data.certificateNo.trim() === '') {
    errors.push('缺少校准证书编号');
  }
  if (!data.calibratedAt) {
    errors.push('缺少校准日期');
  } else if (isNaN(new Date(data.calibratedAt).getTime())) {
    errors.push('校准日期格式无效');
  }
  if (!data.validUntil) {
    errors.push('缺少有效期至');
  } else if (isNaN(new Date(data.validUntil).getTime())) {
    errors.push('有效期至格式无效');
  }
  if (data.calibratedAt && data.validUntil) {
    if (new Date(data.validUntil) <= new Date(data.calibratedAt)) {
      errors.push('有效期至必须晚于校准日期');
    }
  }
  return { valid: errors.length === 0, errors };
}

function checkDuplicateDeviceValidPeriod(deviceNo, validUntil, excludeId) {
  const existing = storage.getCalibrationsByDevice(deviceNo);
  const conflict = existing.find(c =>
    c.status === CAL_STATUS.ACTIVE &&
    c.validUntil === validUntil &&
    c.id !== excludeId
  );
  return conflict || null;
}

function createCalibration(data, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasCalibrationPermission(operator.role, 'create')) {
    return { success: false, error: '无权限创建校准记录' };
  }

  const validation = validateCalibrationData(data);
  if (!validation.valid) {
    return { success: false, error: '校准记录校验失败', errors: validation.errors };
  }

  const duplicate = checkDuplicateDeviceValidPeriod(data.deviceNo, data.validUntil, null);
  if (duplicate) {
    return {
      success: false,
      error: `设备 ${data.deviceNo} 已存在有效期至 ${data.validUntil} 的校准记录`,
      conflict: true,
      conflictId: duplicate.id
    };
  }

  const now = new Date().toISOString();
  const calibration = {
    id: generateCalibrationId(),
    deviceNo: data.deviceNo.trim(),
    deviceType: data.deviceType,
    certificateNo: data.certificateNo.trim(),
    calibratedAt: data.calibratedAt,
    validUntil: data.validUntil,
    calibrationUnit: data.calibrationUnit || '℃',
    remark: data.remark || '',
    status: CAL_STATUS.ACTIVE,
    createdBy: operatorId,
    createdByName: operator.name,
    createdAt: now,
    updatedAt: now,
    version: 1
  };

  storage.saveCalibration(calibration);
  storage.addCalibrationAuditLog(calibration.id, {
    action: 'calibration_create',
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: '创建校准记录',
    timestamp: now,
    detail: {
      deviceNo: calibration.deviceNo,
      certificateNo: calibration.certificateNo,
      validUntil: calibration.validUntil
    }
  });

  return { success: true, calibration };
}

function getCalibrationDetail(calibrationId) {
  const calibration = storage.getCalibration(calibrationId);
  if (!calibration) {
    return null;
  }
  const auditLogs = storage.getCalibrationAuditLogs(calibrationId);
  return { calibration, auditLogs };
}

function listAllCalibrations(filters) {
  let records = storage.listCalibrations();
  if (filters) {
    if (filters.deviceNo) {
      records = records.filter(c => c.deviceNo === filters.deviceNo);
    }
    if (filters.deviceType) {
      records = records.filter(c => c.deviceType === filters.deviceType);
    }
    if (filters.status) {
      records = records.filter(c => c.status === filters.status);
    }
  }
  return records;
}

function updateCalibration(calibrationId, updateData, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasCalibrationPermission(operator.role, 'update')) {
    return { success: false, error: '无权限更新校准记录' };
  }

  const calibration = storage.getCalibration(calibrationId);
  if (!calibration) {
    return { success: false, error: '校准记录不存在' };
  }
  if (calibration.status === CAL_STATUS.VOIDED) {
    return { success: false, error: '已作废的校准记录不能更新' };
  }

  if (expectedVersion !== undefined && calibration.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${calibration.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: calibration.version
    };
  }

  const newValidUntil = updateData.validUntil || calibration.validUntil;
  const newDeviceNo = updateData.deviceNo || calibration.deviceNo;
  const duplicate = checkDuplicateDeviceValidPeriod(newDeviceNo, newValidUntil, calibrationId);
  if (duplicate) {
    return {
      success: false,
      error: `设备 ${newDeviceNo} 已存在有效期至 ${newValidUntil} 的校准记录`,
      conflict: true,
      conflictId: duplicate.id
    };
  }

  const now = new Date().toISOString();
  const beforeSnapshot = { ...calibration };

  if (updateData.certificateNo) calibration.certificateNo = updateData.certificateNo.trim();
  if (updateData.calibratedAt) calibration.calibratedAt = updateData.calibratedAt;
  if (updateData.validUntil) calibration.validUntil = updateData.validUntil;
  if (updateData.calibrationUnit) calibration.calibrationUnit = updateData.calibrationUnit;
  if (updateData.remark !== undefined) calibration.remark = updateData.remark;
  calibration.updatedAt = now;
  calibration.version += 1;

  storage.saveCalibration(calibration);
  storage.addCalibrationAuditLog(calibrationId, {
    action: 'calibration_update',
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: '更新校准记录',
    timestamp: now,
    detail: {
      before: { certificateNo: beforeSnapshot.certificateNo, validUntil: beforeSnapshot.validUntil },
      after: { certificateNo: calibration.certificateNo, validUntil: calibration.validUntil },
      version: calibration.version
    }
  });

  return { success: true, calibration };
}

function changeCalibrationExpiry(calibrationId, newValidUntil, operatorId, reason, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasCalibrationPermission(operator.role, 'change_expiry')) {
    return { success: false, error: '无权限更改校准有效期，仅质管负责人可操作' };
  }

  const calibration = storage.getCalibration(calibrationId);
  if (!calibration) {
    return { success: false, error: '校准记录不存在' };
  }
  if (calibration.status === CAL_STATUS.VOIDED) {
    return { success: false, error: '已作废的校准记录不能更改有效期' };
  }

  if (!newValidUntil || isNaN(new Date(newValidUntil).getTime())) {
    return { success: false, error: '有效期至格式无效' };
  }
  if (new Date(newValidUntil) <= new Date(calibration.calibratedAt)) {
    return { success: false, error: '有效期至必须晚于校准日期' };
  }
  if (!reason || reason.trim() === '') {
    return { success: false, error: '更改有效期必须填写原因' };
  }

  if (expectedVersion !== undefined && calibration.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${calibration.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: calibration.version
    };
  }

  const duplicate = checkDuplicateDeviceValidPeriod(calibration.deviceNo, newValidUntil, calibrationId);
  if (duplicate) {
    return {
      success: false,
      error: `设备 ${calibration.deviceNo} 已存在有效期至 ${newValidUntil} 的校准记录`,
      conflict: true,
      conflictId: duplicate.id
    };
  }

  const oldValidUntil = calibration.validUntil;
  const now = new Date().toISOString();
  calibration.validUntil = newValidUntil;
  calibration.updatedAt = now;
  calibration.version += 1;

  storage.saveCalibration(calibration);
  storage.addCalibrationAuditLog(calibrationId, {
    action: 'calibration_change_expiry',
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: reason.trim(),
    timestamp: now,
    detail: {
      oldValidUntil,
      newValidUntil,
      version: calibration.version
    }
  });

  return { success: true, calibration };
}

function voidCalibration(calibrationId, operatorId, reason) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasCalibrationPermission(operator.role, 'void')) {
    return { success: false, error: '无权限作废校准记录，仅质管负责人可操作' };
  }

  const calibration = storage.getCalibration(calibrationId);
  if (!calibration) {
    return { success: false, error: '校准记录不存在' };
  }
  if (calibration.status === CAL_STATUS.VOIDED) {
    return { success: false, error: '校准记录已被作废' };
  }
  if (!reason || reason.trim() === '') {
    return { success: false, error: '作废校准记录必须填写原因' };
  }

  const now = new Date().toISOString();
  const fromStatus = calibration.status;
  calibration.status = CAL_STATUS.VOIDED;
  calibration.voidedBy = operatorId;
  calibration.voidedByName = operator.name;
  calibration.voidedAt = now;
  calibration.voidReason = reason.trim();
  calibration.updatedAt = now;
  calibration.version += 1;

  storage.saveCalibration(calibration);
  storage.addCalibrationAuditLog(calibrationId, {
    action: 'calibration_void',
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: reason.trim(),
    timestamp: now,
    detail: {
      fromStatus,
      toStatus: CAL_STATUS.VOIDED,
      version: calibration.version
    }
  });

  return { success: true, calibration };
}

function validateDevice(deviceNo) {
  if (!deviceNo) {
    return { valid: false, error: '缺少设备编号' };
  }

  const allRecords = storage.getCalibrationsByDevice(deviceNo);

  if (allRecords.length === 0) {
    return { valid: false, error: `设备 ${deviceNo} 无校准记录`, errorType: 'no_record' };
  }

  const voidedRecords = allRecords.filter(c => c.status === CAL_STATUS.VOIDED);
  const activeRecords = allRecords.filter(c => c.status === CAL_STATUS.ACTIVE);

  if (activeRecords.length === 0 && voidedRecords.length > 0) {
    return { valid: false, error: `设备 ${deviceNo} 的校准记录已全部作废`, errorType: 'all_voided' };
  }

  const now = new Date();
  const validRecords = activeRecords.filter(c => new Date(c.validUntil) > now);
  const expiredRecords = activeRecords.filter(c => new Date(c.validUntil) <= now);

  if (validRecords.length === 0 && expiredRecords.length > 0) {
    return { valid: false, error: `设备 ${deviceNo} 的校准证书已过期`, errorType: 'expired' };
  }

  return { valid: true, calibration: validRecords[0] };
}

function validateDevicesForReference(deviceNos) {
  if (!deviceNos || deviceNos.length === 0) {
    return { valid: true, warnings: [] };
  }

  const errors = [];
  const warnings = [];
  const seen = new Set();

  for (const deviceNo of deviceNos) {
    if (seen.has(deviceNo)) continue;
    seen.add(deviceNo);

    const result = validateDevice(deviceNo);
    if (!result.valid) {
      errors.push({ deviceNo, error: result.error, errorType: result.errorType });
    } else {
      const cal = result.calibration;
      const daysLeft = Math.ceil((new Date(cal.validUntil) - new Date()) / (1000 * 60 * 60 * 24));
      if (daysLeft <= 30) {
        warnings.push({ deviceNo, warning: `设备 ${deviceNo} 的校准证书将于 ${daysLeft} 天后过期`, daysLeft });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function importCalibrations(records, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在', results: [] };
  }
  if (!hasCalibrationPermission(operator.role, 'create')) {
    return { success: false, error: '无权限导入校准记录', results: [] };
  }

  const results = [];
  for (let i = 0; i < records.length; i++) {
    const data = records[i];
    const result = createCalibration(data, operatorId);
    results.push({
      index: i + 1,
      deviceNo: data.deviceNo || '',
      success: result.success,
      error: result.error || null,
      conflict: result.conflict || false,
      conflictId: result.conflictId || null,
      calibrationId: result.success ? result.calibration.id : null
    });
  }

  const allSuccess = results.every(r => r.success);
  return { success: true, results, allSuccess };
}

module.exports = {
  createCalibration,
  getCalibrationDetail,
  listAllCalibrations,
  updateCalibration,
  changeCalibrationExpiry,
  voidCalibration,
  validateDevice,
  validateDevicesForReference,
  importCalibrations,
  findUser,
  hasCalibrationPermission,
  CAL_STATUS,
  DEV_TYPES
};

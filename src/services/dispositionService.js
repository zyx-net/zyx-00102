const storage = require('../storage');
const config = require('../config');

const DISP_STATUS = config.dispositionStatus;
const DEVIATION_LEVEL = config.deviationLevel;
const DISP_DECISION = config.dispositionDecision;
const BATCH_STATUS = config.status;
const ROLES = config.roles;

const ROLE_PERMISSIONS = {
  [ROLES.RECEIVER]: ['view'],
  [ROLES.PHARMACIST]: ['create', 'update', 'submit', 'view'],
  [ROLES.QUALITY_MANAGER]: ['approve', 'return_supplement', 'view']
};

const DISP_STATUS_TRANSITIONS = {
  [DISP_STATUS.DRAFT]: [DISP_STATUS.PENDING_APPROVAL],
  [DISP_STATUS.PENDING_APPROVAL]: [DISP_STATUS.APPROVED, DISP_STATUS.RETURNED_FOR_SUPPLEMENT, DISP_STATUS.CLOSED],
  [DISP_STATUS.RETURNED_FOR_SUPPLEMENT]: [DISP_STATUS.PENDING_APPROVAL, DISP_STATUS.CLOSED],
  [DISP_STATUS.APPROVED]: [DISP_STATUS.CLOSED],
  [DISP_STATUS.CLOSED]: []
};

const VALID_DEVIATION_LEVELS = Object.values(DEVIATION_LEVEL);

function genDispositionId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `DISP-${dateStr}-${rand}`;
}

function hasPermission(userRole, action) {
  const permissions = ROLE_PERMISSIONS[userRole] || [];
  return permissions.includes(action);
}

function canTransition(currentStatus, targetStatus) {
  const allowed = DISP_STATUS_TRANSITIONS[currentStatus] || [];
  return allowed.includes(targetStatus);
}

function findUser(userId) {
  return config.users.find(u => u.id === userId) || null;
}

function validateDispositionData(data, forUpdate = false) {
  const errors = [];

  if (!forUpdate) {
    if (!data.batchNo) {
      errors.push('缺少批号');
    }
  }

  if (data.deviationLevel !== undefined && !VALID_DEVIATION_LEVELS.includes(data.deviationLevel)) {
    errors.push(`偏差等级必须是: ${VALID_DEVIATION_LEVELS.join(', ')}`);
  }

  if (data.overTempRangeIndices !== undefined) {
    if (!Array.isArray(data.overTempRangeIndices)) {
      errors.push('超温区间索引必须是数组');
    } else if (data.overTempRangeIndices.length === 0) {
      errors.push('至少选择一个超温区间');
    }
  }

  if (data.cause !== undefined && typeof data.cause !== 'string') {
    errors.push('偏差原因必须是字符串');
  }

  if (data.suggestedAction !== undefined && typeof data.suggestedAction !== 'string') {
    errors.push('建议动作必须是字符串');
  }

  if (data.attachmentSummary !== undefined && typeof data.attachmentSummary !== 'string') {
    errors.push('附件摘要必须是字符串');
  }

  return { valid: errors.length === 0, errors };
}

function createDisposition(data, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'create')) {
    storage.addAuditLog(data.batchNo || 'unknown', {
      action: 'disposition_create_denied',
      fromStatus: null,
      toStatus: null,
      operatorId,
      operatorName: operator.name,
      operatorRole: operator.role,
      reason: '越权创建处置单',
      timestamp: new Date().toISOString()
    });
    return { success: false, error: '无权限创建处置单' };
  }

  const batch = storage.getBatch(data.batchNo);
  if (!batch) {
    return { success: false, error: `批号 ${data.batchNo} 不存在` };
  }

  if (batch.status !== BATCH_STATUS.QUARANTINED) {
    return { success: false, error: `只有隔离状态的批次才能创建处置单，当前状态: ${batch.status}` };
  }

  const existingActive = storage.getActiveDisposition(data.batchNo);
  if (existingActive) {
    return {
      success: false,
      error: `该批次已有进行中的处置单: ${existingActive.id}`,
      conflict: true,
      existingDispositionId: existingActive.id
    };
  }

  const overTempRanges = batch.overTempRanges || [];
  if (overTempRanges.length === 0) {
    return { success: false, error: '该批次没有超温区间记录，无法创建处置单' };
  }

  const validation = validateDispositionData(data, false);
  if (!validation.valid) {
    return { success: false, error: '数据校验失败', errors: validation.errors };
  }

  let selectedRanges = [];
  if (data.overTempRangeIndices && Array.isArray(data.overTempRangeIndices)) {
    selectedRanges = data.overTempRangeIndices
      .filter(i => i >= 0 && i < overTempRanges.length)
      .map(i => overTempRanges[i]);
  }
  if (selectedRanges.length === 0) {
    selectedRanges = overTempRanges;
  }

  const now = new Date().toISOString();
  const disposition = {
    id: genDispositionId(),
    batchNo: data.batchNo,
    status: DISP_STATUS.DRAFT,
    deviationLevel: data.deviationLevel || null,
    overTempRanges: selectedRanges,
    overTempRangeIndices: data.overTempRangeIndices || overTempRanges.map((_, i) => i),
    cause: data.cause || '',
    suggestedAction: data.suggestedAction || '',
    attachmentSummary: data.attachmentSummary || '',
    createdBy: operatorId,
    createdByName: operator.name,
    createdAt: now,
    updatedAt: now,
    submittedAt: null,
    approvedAt: null,
    approvedBy: null,
    approvedByName: null,
    finalDecision: null,
    approvalReason: null,
    returnReason: null,
    returnedAt: null,
    returnedBy: null,
    returnedByName: null,
    closedAt: null,
    version: 1
  };

  storage.saveDisposition(disposition);

  storage.addAuditLog(data.batchNo, {
    action: 'disposition_create',
    fromStatus: null,
    toStatus: DISP_STATUS.DRAFT,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: `药师创建温控偏差处置单 ${disposition.id}`,
    timestamp: now,
    detail: {
      dispositionId: disposition.id,
      selectedOverTempRanges: selectedRanges.length
    }
  });

  return { success: true, disposition };
}

function updateDisposition(dispositionId, data, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'update')) {
    return { success: false, error: '无权限更新处置单' };
  }

  const disposition = storage.getDisposition(dispositionId);
  if (!disposition) {
    return { success: false, error: `处置单 ${dispositionId} 不存在` };
  }

  if (disposition.createdBy !== operatorId) {
    storage.addAuditLog(disposition.batchNo, {
      action: 'disposition_update_denied',
      fromStatus: disposition.status,
      toStatus: disposition.status,
      operatorId,
      operatorName: operator.name,
      operatorRole: operator.role,
      reason: `非创建者尝试更新处置单 ${dispositionId}`,
      timestamp: new Date().toISOString(),
      detail: { dispositionId }
    });
    return { success: false, error: '只有处置单创建者才能更新' };
  }

  if (![DISP_STATUS.DRAFT, DISP_STATUS.RETURNED_FOR_SUPPLEMENT].includes(disposition.status)) {
    return { success: false, error: `当前状态 ${disposition.status} 不允许更新，只有草稿或退回补充状态可以修改` };
  }

  if (expectedVersion !== undefined && disposition.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${disposition.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: disposition.version
    };
  }

  const validation = validateDispositionData(data, true);
  if (!validation.valid) {
    return { success: false, error: '数据校验失败', errors: validation.errors };
  }

  const batch = storage.getBatch(disposition.batchNo);
  const overTempRanges = batch ? (batch.overTempRanges || []) : [];

  const now = new Date().toISOString();
  const updated = { ...disposition };

  if (data.deviationLevel !== undefined) updated.deviationLevel = data.deviationLevel;
  if (data.cause !== undefined) updated.cause = data.cause;
  if (data.suggestedAction !== undefined) updated.suggestedAction = data.suggestedAction;
  if (data.attachmentSummary !== undefined) updated.attachmentSummary = data.attachmentSummary;

  if (data.overTempRangeIndices !== undefined && Array.isArray(data.overTempRangeIndices)) {
    updated.overTempRangeIndices = data.overTempRangeIndices;
    updated.overTempRanges = data.overTempRangeIndices
      .filter(i => i >= 0 && i < overTempRanges.length)
      .map(i => overTempRanges[i]);
  }

  updated.updatedAt = now;
  updated.version = disposition.version + 1;

  storage.saveDisposition(updated);

  storage.addAuditLog(disposition.batchNo, {
    action: 'disposition_update',
    fromStatus: disposition.status,
    toStatus: updated.status,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: `药师更新处置单 ${dispositionId}`,
    timestamp: now,
    detail: { dispositionId, version: updated.version }
  });

  return { success: true, disposition: updated };
}

function submitForApproval(dispositionId, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'submit')) {
    return { success: false, error: '无权限提交处置单' };
  }

  const disposition = storage.getDisposition(dispositionId);
  if (!disposition) {
    return { success: false, error: `处置单 ${dispositionId} 不存在` };
  }

  if (disposition.createdBy !== operatorId) {
    return { success: false, error: '只有处置单创建者才能提交' };
  }

  if (![DISP_STATUS.DRAFT, DISP_STATUS.RETURNED_FOR_SUPPLEMENT].includes(disposition.status)) {
    return { success: false, error: `当前状态 ${disposition.status} 不允许提交` };
  }

  if (disposition.status === DISP_STATUS.RETURNED_FOR_SUPPLEMENT) {
    const supplementService = require('./supplementService');
    const pendingSupp = supplementService.getPendingSupplementForDisposition(dispositionId);
    if (pendingSupp) {
      return {
        success: false,
        error: `当前为退回补充状态，存在未提交的补证包 ${pendingSupp.id}，请先提交补证包`,
        conflict: true,
        pendingSupplementId: pendingSupp.id
      };
    }
  }

  if (expectedVersion !== undefined && disposition.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${disposition.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: disposition.version
    };
  }

  if (!disposition.deviationLevel) {
    return { success: false, error: '提交前必须填写偏差等级' };
  }
  if (!disposition.cause || disposition.cause.trim() === '') {
    return { success: false, error: '提交前必须填写偏差原因' };
  }
  if (!disposition.suggestedAction || disposition.suggestedAction.trim() === '') {
    return { success: false, error: '提交前必须填写建议动作' };
  }

  const now = new Date().toISOString();
  const updated = {
    ...disposition,
    status: DISP_STATUS.PENDING_APPROVAL,
    submittedAt: now,
    updatedAt: now,
    version: disposition.version + 1
  };

  storage.saveDisposition(updated);

  storage.addAuditLog(disposition.batchNo, {
    action: 'disposition_submit',
    fromStatus: disposition.status,
    toStatus: DISP_STATUS.PENDING_APPROVAL,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: `药师提交处置单 ${dispositionId} 等待审批`,
    timestamp: now,
    detail: { dispositionId, version: updated.version }
  });

  return { success: true, disposition: updated };
}

function approveDisposition(dispositionId, decision, reason, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'approve')) {
    storage.addAuditLog('unknown', {
      action: 'disposition_approve_denied',
      fromStatus: null,
      toStatus: null,
      operatorId,
      operatorName: operator ? operator.name : 'unknown',
      operatorRole: operator ? operator.role : 'unknown',
      reason: `越权审批处置单 ${dispositionId}`,
      timestamp: new Date().toISOString(),
      detail: { dispositionId }
    });
    return { success: false, error: '无权限审批处置单' };
  }

  const disposition = storage.getDisposition(dispositionId);
  if (!disposition) {
    return { success: false, error: `处置单 ${dispositionId} 不存在` };
  }

  if (disposition.status !== DISP_STATUS.PENDING_APPROVAL) {
    return { success: false, error: `当前状态 ${disposition.status} 不允许审批，只有待审批状态可以操作` };
  }

  if (expectedVersion !== undefined && disposition.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${disposition.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: disposition.version
    };
  }

  if (decision !== DISP_DECISION.RELEASE && decision !== DISP_DECISION.REJECT) {
    return { success: false, error: `审批决定必须是 release 或 reject` };
  }

  const batch = storage.getBatch(disposition.batchNo);
  if (!batch) {
    return { success: false, error: `关联批次 ${disposition.batchNo} 不存在` };
  }

  const now = new Date().toISOString();
  const targetBatchStatus = decision === DISP_DECISION.RELEASE ? BATCH_STATUS.RELEASED : BATCH_STATUS.REJECTED;

  const batchService = require('./batchService');
  if (!batchService.canTransition(batch.status, targetBatchStatus)) {
    return { success: false, error: `批次状态 ${batch.status} 无法转换到 ${targetBatchStatus}，处置单审批失败` };
  }

  const updatedDisp = {
    ...disposition,
    status: DISP_STATUS.CLOSED,
    finalDecision: decision,
    approvedAt: now,
    approvedBy: operatorId,
    approvedByName: operator.name,
    approvalReason: reason || '',
    closedAt: now,
    updatedAt: now,
    version: disposition.version + 1
  };

  const updatedBatch = {
    ...batch,
    status: targetBatchStatus,
    dispositionId: dispositionId,
    dispositionDecision: decision,
    finalizedBy: operatorId,
    finalizedAt: now,
    finalReason: reason || ''
  };

  storage.saveDisposition(updatedDisp);
  storage.saveBatch(updatedBatch);

  storage.addAuditLog(disposition.batchNo, {
    action: `disposition_approve_${decision}`,
    fromStatus: disposition.status,
    toStatus: DISP_STATUS.CLOSED,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: `质管审批处置单 ${dispositionId}，结论: ${decision === DISP_DECISION.RELEASE ? '放行' : '拒收'}${reason ? ' - ' + reason : ''}`,
    timestamp: now,
    detail: {
      dispositionId,
      batchStatusFrom: batch.status,
      batchStatusTo: targetBatchStatus,
      finalDecision: decision
    }
  });

  storage.addAuditLog(disposition.batchNo, {
    action: decision,
    fromStatus: batch.status,
    toStatus: targetBatchStatus,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: reason || `处置单 ${dispositionId} 审批结论: ${decision === DISP_DECISION.RELEASE ? '放行' : '拒收'}`,
    timestamp: now,
    detail: { dispositionId }
  });

  return { success: true, disposition: updatedDisp, batch: updatedBatch };
}

function returnForSupplement(dispositionId, returnReason, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'return_supplement')) {
    storage.addAuditLog('unknown', {
      action: 'disposition_return_denied',
      fromStatus: null,
      toStatus: null,
      operatorId,
      operatorName: operator ? operator.name : 'unknown',
      operatorRole: operator ? operator.role : 'unknown',
      reason: `越权退回处置单 ${dispositionId}`,
      timestamp: new Date().toISOString(),
      detail: { dispositionId }
    });
    return { success: false, error: '无权限退回处置单' };
  }

  const disposition = storage.getDisposition(dispositionId);
  if (!disposition) {
    return { success: false, error: `处置单 ${dispositionId} 不存在` };
  }

  if (disposition.status === DISP_STATUS.RETURNED_FOR_SUPPLEMENT) {
    const supplementService = require('./supplementService');
    const existingPending = supplementService.getPendingSupplementForDisposition(dispositionId);
    if (existingPending) {
      return {
        success: false,
        error: `该处置单已有未完成的补证包: ${existingPending.id}，请先完成当前补证`,
        conflict: true,
        existingSupplementId: existingPending.id
      };
    }
    return { success: false, error: `当前状态 ${disposition.status} 不允许退回，只有待审批状态可以操作` };
  }

  if (disposition.status !== DISP_STATUS.PENDING_APPROVAL) {
    return { success: false, error: `当前状态 ${disposition.status} 不允许退回，只有待审批状态可以操作` };
  }

  if (expectedVersion !== undefined && disposition.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${disposition.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: disposition.version
    };
  }

  if (!returnReason || returnReason.trim() === '') {
    return { success: false, error: '退回时必须说明需要补充的内容' };
  }

  const now = new Date().toISOString();
  const updated = {
    ...disposition,
    status: DISP_STATUS.RETURNED_FOR_SUPPLEMENT,
    returnReason: returnReason,
    returnedAt: now,
    returnedBy: operatorId,
    returnedByName: operator.name,
    updatedAt: now,
    version: disposition.version + 1
  };

  storage.saveDisposition(updated);

  storage.addAuditLog(disposition.batchNo, {
    action: 'disposition_return_supplement',
    fromStatus: disposition.status,
    toStatus: DISP_STATUS.RETURNED_FOR_SUPPLEMENT,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: `质管退回处置单 ${dispositionId} 补充材料: ${returnReason}`,
    timestamp: now,
    detail: { dispositionId, returnReason }
  });

  const supplementService = require('./supplementService');
  const suppResult = supplementService.createSupplementPackage(dispositionId, returnReason, operatorId);

  const result = { success: true, disposition: updated };
  if (suppResult.success) {
    result.supplement = suppResult.supplement;
  }

  return result;
}

function getDispositionDetail(dispositionId) {
  const disposition = storage.getDisposition(dispositionId);
  if (!disposition) return null;
  return disposition;
}

function getBatchDispositions(batchNo) {
  return storage.getBatchDispositions(batchNo);
}

function getActiveDisposition(batchNo) {
  return storage.getActiveDisposition(batchNo);
}

function listAllDispositions() {
  const all = storage.getDispositions();
  return Object.values(all).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = {
  createDisposition,
  updateDisposition,
  submitForApproval,
  approveDisposition,
  returnForSupplement,
  getDispositionDetail,
  getBatchDispositions,
  getActiveDisposition,
  listAllDispositions,
  hasPermission,
  findUser,
  DISP_STATUS,
  DEVIATION_LEVEL,
  DISP_DECISION
};

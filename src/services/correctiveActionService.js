const storage = require('../storage');
const config = require('../config');

const STATUS = config.correctiveActionStatus;
const SOURCE = config.correctiveActionSource;
const SEVERITY = config.correctiveActionSeverity;
const ROLES = config.roles;

const STATUS_TRANSITIONS = {
  [STATUS.DRAFT]: [STATUS.PENDING_ASSIGN],
  [STATUS.PENDING_ASSIGN]: [STATUS.ASSIGNED],
  [STATUS.ASSIGNED]: [STATUS.PENDING_VERIFICATION],
  [STATUS.PENDING_VERIFICATION]: [STATUS.APPROVED, STATUS.RETURNED],
  [STATUS.APPROVED]: [STATUS.CLOSED],
  [STATUS.RETURNED]: [STATUS.PENDING_VERIFICATION],
  [STATUS.CLOSED]: []
};

function findUser(userId) {
  return config.users.find(u => u.id === userId) || null;
}

function hasPermission(userRole, action) {
  const roleKey = userRole.toUpperCase();
  const permissions = config.correctiveActionPermissions[roleKey] || [];
  return permissions.includes(action);
}

function canTransition(currentStatus, targetStatus) {
  const allowed = STATUS_TRANSITIONS[currentStatus] || [];
  return allowed.includes(targetStatus);
}

function validateCorrectiveAction(data, isUpdate = false) {
  const errors = [];
  
  if (!isUpdate && !data.batchNo) {
    errors.push('缺少批号');
  }
  if (!data.source) {
    errors.push('缺少问题来源');
  } else if (!Object.values(SOURCE).includes(data.source)) {
    errors.push(`无效的问题来源: ${data.source}，有效值: ${Object.values(SOURCE).join(', ')}`);
  }
  if (!data.severity) {
    errors.push('缺少严重级别');
  } else if (!Object.values(SEVERITY).includes(data.severity)) {
    errors.push(`无效的严重级别: ${data.severity}，有效值: ${Object.values(SEVERITY).join(', ')}`);
  }
  if (!data.supplierId) {
    errors.push('缺少责任供应商');
  }
  if (!data.description) {
    errors.push('缺少问题描述');
  }
  if (data.dueDate && isNaN(Date.parse(data.dueDate))) {
    errors.push('无效的限期日期格式');
  }
  
  return { valid: errors.length === 0, errors };
}

function generateActionId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substr(2, 4).toUpperCase();
  return `CA-${timestamp}-${random}`;
}

function createCorrectiveAction(data, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'create')) {
    return { success: false, error: '无权限创建整改单' };
  }

  const validation = validateCorrectiveAction(data);
  if (!validation.valid) {
    return { success: false, error: '校验失败', errors: validation.errors };
  }

  const activeActions = storage.getActiveCorrectiveActionsByBatch(data.batchNo);
  if (activeActions.length > 0) {
    return {
      success: false,
      error: `该批次已有未关闭的整改单，ID: ${activeActions.map(a => a.id).join(', ')}`,
      conflict: true
    };
  }

  const now = new Date().toISOString();
  const action = {
    id: generateActionId(),
    batchNo: data.batchNo,
    source: data.source,
    severity: data.severity,
    supplierId: data.supplierId,
    supplierName: data.supplierName || '',
    description: data.description,
    attachmentSummary: data.attachmentSummary || '',
    dueDate: data.dueDate,
    status: STATUS.DRAFT,
    version: 1,
    createdAt: now,
    createdBy: operatorId,
    createdByName: operator.name,
    assignedTo: null,
    assignedByName: null,
    assignedAt: null,
    response: null,
    responseEvidence: null,
    responseSubmittedAt: null,
    responseSubmittedBy: null,
    responseSubmittedByName: null,
    approvedAt: null,
    approvedBy: null,
    approvedByName: null,
    approvedNote: null,
    closedAt: null,
    closedBy: null,
    closedByName: null,
    closedNote: null,
    returnedAt: null,
    returnedBy: null,
    returnedByName: null,
    returnedReason: null
  };

  storage.saveCorrectiveAction(action);
  
  storage.addCorrectiveActionAuditLog(action.id, {
    action: 'create',
    fromStatus: null,
    toStatus: STATUS.DRAFT,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: '创建整改单',
    timestamp: now
  });

  return { success: true, action };
}

function submitForAssign(actionId, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'create')) {
    return { success: false, error: '无权限提交整改单' };
  }

  const action = storage.getCorrectiveAction(actionId);
  if (!action) {
    return { success: false, error: `整改单 ${actionId} 不存在` };
  }

  if (expectedVersion !== undefined && action.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${action.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: action.version
    };
  }

  if (!canTransition(action.status, STATUS.PENDING_ASSIGN)) {
    return {
      success: false,
      error: `不能从 ${action.status} 状态提交分派，当前状态只允许: ${STATUS_TRANSITIONS[action.status].join(', ')}`
    };
  }

  const fromStatus = action.status;
  action.status = STATUS.PENDING_ASSIGN;
  action.version += 1;
  
  storage.saveCorrectiveAction(action);
  
  storage.addCorrectiveActionAuditLog(actionId, {
    action: 'submit_for_assign',
    fromStatus,
    toStatus: STATUS.PENDING_ASSIGN,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: '提交整改单等待分派',
    timestamp: new Date().toISOString()
  });

  return { success: true, action };
}

function assignAction(actionId, assigneeId, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'assign')) {
    return { success: false, error: '无权限分派整改单' };
  }

  const action = storage.getCorrectiveAction(actionId);
  if (!action) {
    return { success: false, error: `整改单 ${actionId} 不存在` };
  }

  if (expectedVersion !== undefined && action.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${action.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: action.version
    };
  }

  if (!canTransition(action.status, STATUS.ASSIGNED)) {
    return {
      success: false,
      error: `不能从 ${action.status} 状态分派，当前状态只允许: ${STATUS_TRANSITIONS[action.status].join(', ')}`
    };
  }

  const assignee = findUser(assigneeId);
  if (!assignee) {
    return { success: false, error: `被分派人 ${assigneeId} 不存在` };
  }
  if (assignee.role !== ROLES.SUPPLIER_CONTACT) {
    return { success: false, error: '只能分派给供应商联系人角色' };
  }

  const fromStatus = action.status;
  action.status = STATUS.ASSIGNED;
  action.assignedTo = assigneeId;
  action.assignedByName = assignee.name;
  action.assignedAt = new Date().toISOString();
  action.version += 1;
  
  storage.saveCorrectiveAction(action);
  
  storage.addCorrectiveActionAuditLog(actionId, {
    action: 'assign',
    fromStatus,
    toStatus: STATUS.ASSIGNED,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: `分派给 ${assignee.name}`,
    timestamp: new Date().toISOString(),
    detail: { assigneeId, assigneeName: assignee.name }
  });

  return { success: true, action };
}

function submitResponse(actionId, responseData, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'submit_response')) {
    return { success: false, error: '无权限提交整改说明' };
  }

  const action = storage.getCorrectiveAction(actionId);
  if (!action) {
    return { success: false, error: `整改单 ${actionId} 不存在` };
  }

  if (operator.role === ROLES.SUPPLIER_CONTACT) {
    if (action.assignedTo !== operatorId) {
      return { success: false, error: '只能提交分派给自己的整改单' };
    }
  }

  if (expectedVersion !== undefined && action.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${action.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: action.version
    };
  }

  if (!canTransition(action.status, STATUS.PENDING_VERIFICATION)) {
    return {
      success: false,
      error: `不能从 ${action.status} 状态提交整改说明，当前状态只允许: ${STATUS_TRANSITIONS[action.status].join(', ')}`
    };
  }

  if (!responseData.response) {
    return { success: false, error: '整改说明不能为空' };
  }

  const fromStatus = action.status;
  action.status = STATUS.PENDING_VERIFICATION;
  action.response = responseData.response;
  action.responseEvidence = responseData.responseEvidence || '';
  action.responseSubmittedAt = new Date().toISOString();
  action.responseSubmittedBy = operatorId;
  action.responseSubmittedByName = operator.name;
  action.version += 1;
  
  storage.saveCorrectiveAction(action);
  
  storage.addCorrectiveActionAuditLog(actionId, {
    action: 'submit_response',
    fromStatus,
    toStatus: STATUS.PENDING_VERIFICATION,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: '提交整改说明和证据',
    timestamp: new Date().toISOString(),
    detail: {
      responseLength: responseData.response.length,
      hasEvidence: !!responseData.responseEvidence
    }
  });

  return { success: true, action };
}

function approveAction(actionId, note, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'approve')) {
    return { success: false, error: '无权限验收整改单' };
  }

  const action = storage.getCorrectiveAction(actionId);
  if (!action) {
    return { success: false, error: `整改单 ${actionId} 不存在` };
  }

  if (expectedVersion !== undefined && action.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${action.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: action.version
    };
  }

  if (!canTransition(action.status, STATUS.APPROVED)) {
    return {
      success: false,
      error: `不能从 ${action.status} 状态验收通过，当前状态只允许: ${STATUS_TRANSITIONS[action.status].join(', ')}`
    };
  }

  const fromStatus = action.status;
  action.status = STATUS.APPROVED;
  action.approvedAt = new Date().toISOString();
  action.approvedBy = operatorId;
  action.approvedByName = operator.name;
  action.approvedNote = note || '';
  action.version += 1;
  
  storage.saveCorrectiveAction(action);
  
  storage.addCorrectiveActionAuditLog(actionId, {
    action: 'approve',
    fromStatus,
    toStatus: STATUS.APPROVED,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: note || '验收通过',
    timestamp: new Date().toISOString()
  });

  return { success: true, action };
}

function closeAction(actionId, note, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'close')) {
    return { success: false, error: '无权限关闭整改单' };
  }

  const action = storage.getCorrectiveAction(actionId);
  if (!action) {
    return { success: false, error: `整改单 ${actionId} 不存在` };
  }

  if (expectedVersion !== undefined && action.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${action.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: action.version
    };
  }

  if (!canTransition(action.status, STATUS.CLOSED)) {
    return {
      success: false,
      error: `不能从 ${action.status} 状态关闭，当前状态只允许: ${STATUS_TRANSITIONS[action.status].join(', ')}`
    };
  }

  const fromStatus = action.status;
  action.status = STATUS.CLOSED;
  action.closedAt = new Date().toISOString();
  action.closedBy = operatorId;
  action.closedByName = operator.name;
  action.closedNote = note || '';
  action.version += 1;
  
  storage.saveCorrectiveAction(action);
  
  storage.addCorrectiveActionAuditLog(actionId, {
    action: 'close',
    fromStatus,
    toStatus: STATUS.CLOSED,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: note || '关闭整改单',
    timestamp: new Date().toISOString()
  });

  return { success: true, action };
}

function returnAction(actionId, reason, operatorId, expectedVersion) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'return')) {
    return { success: false, error: '无权限退回整改单' };
  }

  const action = storage.getCorrectiveAction(actionId);
  if (!action) {
    return { success: false, error: `整改单 ${actionId} 不存在` };
  }

  if (expectedVersion !== undefined && action.version !== expectedVersion) {
    return {
      success: false,
      error: `版本冲突，当前版本: ${action.version}，预期版本: ${expectedVersion}`,
      conflict: true,
      currentVersion: action.version
    };
  }

  if (!canTransition(action.status, STATUS.RETURNED)) {
    return {
      success: false,
      error: `不能从 ${action.status} 状态退回，当前状态只允许: ${STATUS_TRANSITIONS[action.status].join(', ')}`
    };
  }

  if (!reason) {
    return { success: false, error: '退回原因不能为空' };
  }

  const fromStatus = action.status;
  action.status = STATUS.RETURNED;
  action.returnedAt = new Date().toISOString();
  action.returnedBy = operatorId;
  action.returnedByName = operator.name;
  action.returnedReason = reason;
  action.version += 1;
  
  storage.saveCorrectiveAction(action);
  
  storage.addCorrectiveActionAuditLog(actionId, {
    action: 'return',
    fromStatus,
    toStatus: STATUS.RETURNED,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: `退回重改: ${reason}`,
    timestamp: new Date().toISOString()
  });

  return { success: true, action };
}

function getActionDetail(actionId) {
  const action = storage.getCorrectiveAction(actionId);
  if (!action) {
    return null;
  }
  const auditLogs = storage.getCorrectiveActionAuditLogs(actionId);
  return {
    ...action,
    auditLogs
  };
}

function listActions(filters = {}) {
  let actions = storage.listCorrectiveActions();
  
  if (filters.batchNo) {
    actions = actions.filter(a => a.batchNo === filters.batchNo);
  }
  if (filters.supplierId) {
    actions = actions.filter(a => a.supplierId === filters.supplierId);
  }
  if (filters.status) {
    actions = actions.filter(a => a.status === filters.status);
  }
  
  return actions;
}

module.exports = {
  createCorrectiveAction,
  submitForAssign,
  assignAction,
  submitResponse,
  approveAction,
  closeAction,
  returnAction,
  getActionDetail,
  listActions,
  findUser,
  hasPermission,
  canTransition,
  STATUS,
  SOURCE,
  SEVERITY,
  ROLES
};
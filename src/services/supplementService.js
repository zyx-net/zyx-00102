const storage = require('../storage');
const config = require('../config');

const SUPP_STATUS = config.supplementStatus;
const ROLES = config.roles;
const DISP_STATUS = config.dispositionStatus;

const ROLE_PERMISSIONS = {
  [ROLES.RECEIVER]: ['view'],
  [ROLES.PHARMACIST]: ['submit', 'view'],
  [ROLES.QUALITY_MANAGER]: ['view']
};

function genSupplementId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SUPP-${dateStr}-${rand}`;
}

function hasPermission(userRole, action) {
  const permissions = ROLE_PERMISSIONS[userRole] || [];
  return permissions.includes(action);
}

function findUser(userId) {
  return config.users.find(u => u.id === userId) || null;
}

function createSupplementPackage(dispositionId, returnReason, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }

  const disposition = storage.getDisposition(dispositionId);
  if (!disposition) {
    return { success: false, error: `处置单 ${dispositionId} 不存在` };
  }

  const existingPending = storage.getPendingSupplementForDisposition(dispositionId);
  if (existingPending) {
    return {
      success: false,
      error: `该处置单已有未完成的补证包: ${existingPending.id}，请先完成当前补证`,
      conflict: true,
      existingSupplementId: existingPending.id
    };
  }

  const now = new Date().toISOString();
  const supplement = {
    id: genSupplementId(),
    dispositionId: dispositionId,
    batchNo: disposition.batchNo,
    status: SUPP_STATUS.PENDING,
    returnReason: returnReason,
    returnedBy: operatorId,
    returnedByName: operator.name,
    returnedAt: now,
    supplementDescription: null,
    relatedTempRangeIndices: null,
    relatedTempRanges: null,
    attachmentList: null,
    submittedBy: null,
    submittedByName: null,
    submittedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1
  };

  storage.saveSupplement(supplement);

  storage.addAuditLog(disposition.batchNo, {
    action: 'supplement_create',
    fromStatus: null,
    toStatus: SUPP_STATUS.PENDING,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: `质管退回处置单 ${dispositionId}，创建补证包 ${supplement.id}`,
    timestamp: now,
    detail: {
      supplementId: supplement.id,
      dispositionId,
      returnReason
    }
  });

  return { success: true, supplement };
}

function submitSupplementPackage(dispositionId, supplementData, operatorId) {
  const operator = findUser(operatorId);
  if (!operator) {
    return { success: false, error: '操作员不存在' };
  }
  if (!hasPermission(operator.role, 'submit')) {
    storage.addAuditLog('unknown', {
      action: 'supplement_submit_denied',
      fromStatus: null,
      toStatus: null,
      operatorId,
      operatorName: operator.name,
      operatorRole: operator.role,
      reason: `越权提交补证包，处置单 ${dispositionId}`,
      timestamp: new Date().toISOString(),
      detail: { dispositionId }
    });
    return { success: false, error: '无权限提交补证包，只有药师可以提交' };
  }

  const supplements = storage.getSupplementsForDisposition(dispositionId);
  const pendingSupp = supplements.find(s => s.status === SUPP_STATUS.PENDING) || null;

  if (!pendingSupp) {
    const latestSupp = supplements[0];
    if (latestSupp && latestSupp.status === SUPP_STATUS.SUBMITTED) {
      return {
        success: false,
        error: `补证包 ${latestSupp.id} 已提交，不允许重复提交`,
        conflict: true,
        currentStatus: latestSupp.status,
        supplementId: latestSupp.id
      };
    }
    return { success: false, error: '该处置单没有待提交的补证包' };
  }

  if (!supplementData.supplementDescription || supplementData.supplementDescription.trim() === '') {
    return { success: false, error: '补充说明不能为空' };
  }

  if (!supplementData.attachmentList || supplementData.attachmentList.trim() === '') {
    return { success: false, error: '附件清单不能为空' };
  }

  const now = new Date().toISOString();
  const batch = storage.getBatch(pendingSupp.batchNo);
  let relatedTempRanges = null;
  if (supplementData.relatedTempRangeIndices && Array.isArray(supplementData.relatedTempRangeIndices) && batch) {
    const overTempRanges = batch.overTempRanges || [];
    relatedTempRanges = supplementData.relatedTempRangeIndices
      .filter(i => i >= 0 && i < overTempRanges.length)
      .map(i => overTempRanges[i]);
  }

  const updated = {
    ...pendingSupp,
    status: SUPP_STATUS.SUBMITTED,
    supplementDescription: supplementData.supplementDescription.trim(),
    relatedTempRangeIndices: supplementData.relatedTempRangeIndices || null,
    relatedTempRanges: relatedTempRanges,
    attachmentList: supplementData.attachmentList.trim(),
    submittedBy: operatorId,
    submittedByName: operator.name,
    submittedAt: now,
    updatedAt: now,
    version: pendingSupp.version + 1
  };

  storage.saveSupplement(updated);

  const disposition = storage.getDisposition(dispositionId);
  if (disposition && disposition.status === DISP_STATUS.RETURNED_FOR_SUPPLEMENT) {
    const updatedDisp = {
      ...disposition,
      status: DISP_STATUS.PENDING_APPROVAL,
      submittedAt: now,
      updatedAt: now,
      version: disposition.version + 1
    };
    storage.saveDisposition(updatedDisp);

    storage.addAuditLog(pendingSupp.batchNo, {
      action: 'disposition_resubmit_after_supplement',
      fromStatus: DISP_STATUS.RETURNED_FOR_SUPPLEMENT,
      toStatus: DISP_STATUS.PENDING_APPROVAL,
      operatorId,
      operatorName: operator.name,
      operatorRole: operator.role,
      reason: `药师提交补证包 ${pendingSupp.id} 后处置单 ${dispositionId} 自动重新提交审批`,
      timestamp: now,
      detail: {
        dispositionId,
        supplementId: pendingSupp.id,
        dispositionVersion: updatedDisp.version
      }
    });
  }

  storage.addAuditLog(pendingSupp.batchNo, {
    action: 'supplement_submit',
    fromStatus: SUPP_STATUS.PENDING,
    toStatus: SUPP_STATUS.SUBMITTED,
    operatorId,
    operatorName: operator.name,
    operatorRole: operator.role,
    reason: `药师提交补证包 ${pendingSupp.id}`,
    timestamp: now,
    detail: {
      supplementId: pendingSupp.id,
      dispositionId,
      supplementDescription: updated.supplementDescription,
      attachmentList: updated.attachmentList
    }
  });

  return { success: true, supplement: updated };
}

function getSupplementsForDisposition(dispositionId) {
  return storage.getSupplementsForDisposition(dispositionId);
}

function getSupplementPackageById(suppId) {
  return storage.getSupplement(suppId);
}

function listBatchSupplements(batchNo) {
  return storage.getSupplementsForBatch(batchNo);
}

function getPendingSupplementForDisposition(dispositionId) {
  return storage.getPendingSupplementForDisposition(dispositionId);
}

module.exports = {
  createSupplementPackage,
  submitSupplementPackage,
  getSupplementsForDisposition,
  getSupplementPackageById,
  listBatchSupplements,
  getPendingSupplementForDisposition,
  hasPermission,
  findUser,
  SUPP_STATUS
};

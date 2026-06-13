function parseCSV(csvContent) {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());
  const result = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(',').map(v => v.trim());
    const obj = {};

    headers.forEach((header, idx) => {
      obj[header] = values[idx] || '';
    });

    result.push(obj);
  }

  return result;
}

function toCSV(data, columns) {
  const header = columns.join(',');
  const rows = data.map(item =>
    columns.map(col => {
      let val = item[col] !== undefined ? item[col] : '';
      if (typeof val === 'string' && val.includes(',')) {
        val = `"${val}"`;
      }
      return val;
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

function parseBatchImport(data, format) {
  let records;
  if (format === 'csv') {
    records = parseCSV(data);
  } else {
    records = typeof data === 'string' ? JSON.parse(data) : data;
    if (!Array.isArray(records)) {
      records = [records];
    }
  }

  return records.map(r => ({
    batchNo: r.batchNo || r.batch_no || r['批号'],
    drugName: r.drugName || r.drug_name || r['药品名称'],
    manufacturer: r.manufacturer || r['生产厂家'],
    quantity: r.quantity ? parseInt(r.quantity, 10) : undefined,
    unit: r.unit || r['单位'],
    productionDate: r.productionDate || r.production_date || r['生产日期'],
    expiryDate: r.expiryDate || r.expiry_date || r['有效期至'],
    arrivalDate: r.arrivalDate || r.arrival_date || r['到货日期']
  }));
}

function parseTemperatureImport(data, format) {
  let records;
  if (format === 'csv') {
    records = parseCSV(data);
  } else {
    records = typeof data === 'string' ? JSON.parse(data) : data;
    if (!Array.isArray(records)) {
      records = [records];
    }
  }

  return records.map((r, idx) => ({
    index: idx + 1,
    batchNo: r.batchNo || r.batch_no || r['批号'] || '',
    timestamp: r.timestamp || r.time || r['时间'] || '',
    temperature: r.temperature !== undefined ? r.temperature : (r['温度'] !== undefined ? r['温度'] : ''),
    deviceNo: r.deviceNo || r.device_no || r['设备编号'] || r['设备号'] || ''
  }));
}

function exportBatchToJSON(batchDetail) {
  return JSON.stringify(batchDetail, null, 2);
}

function exportBatchToCSV(batchDetail) {
  const batch = batchDetail.batch;
  const logs = batchDetail.temperatureLogs || [];
  const audits = batchDetail.auditLogs || [];
  const dispositions = batchDetail.dispositions || [];
  const supplements = batchDetail.supplements || [];

  const batchCSV = toCSV([{
    batchNo: batch.batchNo,
    drugName: batch.drugName,
    manufacturer: batch.manufacturer,
    quantity: batch.quantity,
    unit: batch.unit,
    productionDate: batch.productionDate,
    expiryDate: batch.expiryDate,
    arrivalDate: batch.arrivalDate,
    status: batch.status,
    temperatureValid: batch.temperatureValid,
    overTempCount: (batch.overTempRanges || []).length,
    dispositionId: batch.dispositionId || '',
    dispositionDecision: batch.dispositionDecision || '',
    finalReason: batch.finalReason || '',
    qualityRemarkContent: batch.qualityRemark?.content || '',
    qualityRemarkBy: batch.qualityRemark?.updatedByName || batch.qualityRemark?.updatedBy || '',
    qualityRemarkAt: batch.qualityRemark?.updatedAt || '',
    qualityRemarkVersion: batch.qualityRemark?.version || ''
  }], ['batchNo', 'drugName', 'manufacturer', 'quantity', 'unit', 'productionDate', 'expiryDate', 'arrivalDate', 'status', 'temperatureValid', 'overTempCount', 'dispositionId', 'dispositionDecision', 'finalReason', 'qualityRemarkContent', 'qualityRemarkBy', 'qualityRemarkAt', 'qualityRemarkVersion']);

  const tempCSV = toCSV(logs, ['batchNo', 'timestamp', 'temperature']);
  const auditCSV = toCSV(audits, ['action', 'fromStatus', 'toStatus', 'operatorId', 'operatorName', 'operatorRole', 'reason', 'timestamp']);

  let dispCSV = '';
  if (dispositions.length > 0) {
    const dispRows = dispositions.map(d => ({
      id: d.id,
      status: d.status,
      deviationLevel: d.deviationLevel || '',
      cause: d.cause || '',
      suggestedAction: d.suggestedAction || '',
      attachmentSummary: d.attachmentSummary || '',
      createdBy: d.createdByName || d.createdBy || '',
      createdAt: d.createdAt || '',
      finalDecision: d.finalDecision || '',
      approvedBy: d.approvedByName || d.approvedBy || '',
      approvedAt: d.approvedAt || '',
      approvalReason: d.approvalReason || '',
      returnReason: d.returnReason || ''
    }));
    dispCSV = toCSV(dispRows, ['id', 'status', 'deviationLevel', 'cause', 'suggestedAction', 'attachmentSummary', 'createdBy', 'createdAt', 'finalDecision', 'approvedBy', 'approvedAt', 'approvalReason', 'returnReason']);
  }

  let suppCSV = '';
  if (supplements.length > 0) {
    const suppRows = supplements.map(s => ({
      id: s.id,
      dispositionId: s.dispositionId,
      status: s.status,
      returnReason: s.returnReason || '',
      supplementDescription: s.supplementDescription || '',
      attachmentList: s.attachmentList || '',
      submittedBy: s.submittedByName || s.submittedBy || '',
      submittedAt: s.submittedAt || '',
      returnedBy: s.returnedByName || s.returnedBy || '',
      returnedAt: s.returnedAt || ''
    }));
    suppCSV = toCSV(suppRows, ['id', 'dispositionId', 'status', 'returnReason', 'supplementDescription', 'attachmentList', 'submittedBy', 'submittedAt', 'returnedBy', 'returnedAt']);
  }

  let result = `# 批次信息\n${batchCSV}\n\n# 温度日志\n${tempCSV}\n\n# 审计历史\n${auditCSV}`;
  if (dispCSV) {
    result += `\n\n# 温控偏差处置单\n${dispCSV}`;
  }
  if (suppCSV) {
    result += `\n\n# 补证包\n${suppCSV}`;
  }
  const deviceNos = batch.deviceNos || [];
  if (deviceNos.length > 0) {
    result += `\n\n# 关联设备\n${deviceNos.join(',')}`;
  }
  return result;
}

function exportCalibrationsToCSV(calibrations) {
  const rows = calibrations.map(c => ({
    id: c.id,
    deviceNo: c.deviceNo,
    deviceType: c.deviceType,
    certificateNo: c.certificateNo,
    calibratedAt: c.calibratedAt,
    validUntil: c.validUntil,
    calibrationUnit: c.calibrationUnit || '',
    remark: c.remark || '',
    status: c.status,
    createdBy: c.createdByName || c.createdBy || '',
    createdAt: c.createdAt || ''
  }));
  return toCSV(rows, ['id', 'deviceNo', 'deviceType', 'certificateNo', 'calibratedAt', 'validUntil', 'calibrationUnit', 'remark', 'status', 'createdBy', 'createdAt']);
}

function exportInspectionsToCSV(inspections) {
  const rows = inspections.map(i => ({
    id: i.id,
    batchNo: i.batchNo,
    drugName: i.drugName || '',
    status: i.status,
    sampleQuantity: i.sampleQuantity,
    sampleUnit: i.sampleUnit || '',
    deadline: i.deadline,
    itemCount: (i.inspectionItems || []).length,
    overallPassed: i.overallPassed !== null ? (i.overallPassed ? '是' : '否') : '',
    conclusion: i.conclusion || '',
    createdBy: i.createdByName || i.createdBy || '',
    createdAt: i.createdAt || '',
    submittedBy: i.submittedByName || i.submittedBy || '',
    submittedAt: i.submittedAt || '',
    approvedBy: i.approvedByName || i.approvedBy || '',
    approvedAt: i.approvedAt || '',
    returnedBy: i.returnedByName || i.returnedBy || '',
    returnedAt: i.returnedAt || '',
    version: i.version
  }));
  return toCSV(rows, ['id', 'batchNo', 'drugName', 'status', 'sampleQuantity', 'sampleUnit', 'deadline', 'itemCount', 'overallPassed', 'conclusion', 'createdBy', 'createdAt', 'submittedBy', 'submittedAt', 'approvedBy', 'approvedAt', 'returnedBy', 'returnedAt', 'version']);
}

function exportInspectionDetailToCSV(detail) {
  const inspection = detail.inspection;
  const auditLogs = detail.auditLogs || [];
  const items = inspection.inspectionItems || [];

  const mainCSV = toCSV([{
    id: inspection.id,
    batchNo: inspection.batchNo,
    drugName: inspection.drugName || '',
    status: inspection.status,
    sampleQuantity: inspection.sampleQuantity,
    sampleUnit: inspection.sampleUnit || '',
    deadline: inspection.deadline,
    overallPassed: inspection.overallPassed !== null ? (inspection.overallPassed ? '是' : '否') : '',
    conclusion: inspection.conclusion || '',
    returnReason: inspection.returnReason || '',
    createdBy: inspection.createdByName || inspection.createdBy || '',
    createdAt: inspection.createdAt || '',
    submittedBy: inspection.submittedByName || inspection.submittedBy || '',
    submittedAt: inspection.submittedAt || '',
    approvedBy: inspection.approvedByName || inspection.approvedBy || '',
    approvedAt: inspection.approvedAt || '',
    returnedBy: inspection.returnedByName || inspection.returnedBy || '',
    returnedAt: inspection.returnedAt || '',
    version: inspection.version
  }], ['id', 'batchNo', 'drugName', 'status', 'sampleQuantity', 'sampleUnit', 'deadline', 'overallPassed', 'conclusion', 'returnReason', 'createdBy', 'createdAt', 'submittedBy', 'submittedAt', 'approvedBy', 'approvedAt', 'returnedBy', 'returnedAt', 'version']);

  const itemRows = items.map((item, idx) => ({
    index: idx + 1,
    name: item.name,
    criteria: item.criteria,
    method: item.method || '',
    result: item.result || '',
    passed: item.passed !== null ? (item.passed ? '合格' : '不合格') : '',
    remark: item.remark || ''
  }));
  const itemsCSV = toCSV(itemRows, ['index', 'name', 'criteria', 'method', 'result', 'passed', 'remark']);

  const auditRows = auditLogs.map(log => ({
    action: log.action,
    operatorId: log.operatorId,
    operatorName: log.operatorName,
    operatorRole: log.operatorRole,
    reason: log.reason || '',
    timestamp: log.timestamp
  }));
  const auditCSV = toCSV(auditRows, ['action', 'operatorId', 'operatorName', 'operatorRole', 'reason', 'timestamp']);

  return `# 抽检任务基本信息\n${mainCSV}\n\n# 抽检项目明细\n${itemsCSV}\n\n# 审计记录\n${auditCSV}`;
}

function exportCorrectiveActionsToCSV(actions) {
  const rows = actions.map(a => ({
    id: a.id,
    batchNo: a.batchNo,
    source: a.source,
    severity: a.severity,
    supplierId: a.supplierId,
    supplierName: a.supplierName || '',
    description: a.description || '',
    attachmentSummary: a.attachmentSummary || '',
    dueDate: a.dueDate || '',
    status: a.status,
    version: a.version,
    createdAt: a.createdAt || '',
    createdBy: a.createdByName || a.createdBy || '',
    assignedTo: a.assignedByName || a.assignedTo || '',
    assignedAt: a.assignedAt || '',
    responseSubmittedBy: a.responseSubmittedByName || a.responseSubmittedBy || '',
    responseSubmittedAt: a.responseSubmittedAt || '',
    approvedBy: a.approvedByName || a.approvedBy || '',
    approvedAt: a.approvedAt || '',
    closedBy: a.closedByName || a.closedBy || '',
    closedAt: a.closedAt || '',
    returnedBy: a.returnedByName || a.returnedBy || '',
    returnedAt: a.returnedAt || '',
    returnedReason: a.returnedReason || ''
  }));
  return toCSV(rows, ['id', 'batchNo', 'source', 'severity', 'supplierId', 'supplierName', 'description', 'attachmentSummary', 'dueDate', 'status', 'version', 'createdAt', 'createdBy', 'assignedTo', 'assignedAt', 'responseSubmittedBy', 'responseSubmittedAt', 'approvedBy', 'approvedAt', 'closedBy', 'closedAt', 'returnedBy', 'returnedAt', 'returnedReason']);
}

function exportCorrectiveActionDetailToCSV(detail) {
  const action = detail;
  const auditLogs = detail.auditLogs || [];

  const mainCSV = toCSV([{
    id: action.id,
    batchNo: action.batchNo,
    source: action.source,
    severity: action.severity,
    supplierId: action.supplierId,
    supplierName: action.supplierName || '',
    description: action.description || '',
    attachmentSummary: action.attachmentSummary || '',
    dueDate: action.dueDate || '',
    status: action.status,
    version: action.version,
    createdAt: action.createdAt || '',
    createdBy: action.createdByName || action.createdBy || '',
    assignedTo: action.assignedByName || action.assignedTo || '',
    assignedAt: action.assignedAt || '',
    response: action.response || '',
    responseEvidence: action.responseEvidence || '',
    responseSubmittedBy: action.responseSubmittedByName || action.responseSubmittedBy || '',
    responseSubmittedAt: action.responseSubmittedAt || '',
    approvedBy: action.approvedByName || action.approvedBy || '',
    approvedAt: action.approvedAt || '',
    approvedNote: action.approvedNote || '',
    closedBy: action.closedByName || action.closedBy || '',
    closedAt: action.closedAt || '',
    closedNote: action.closedNote || '',
    returnedBy: action.returnedByName || action.returnedBy || '',
    returnedAt: action.returnedAt || '',
    returnedReason: action.returnedReason || ''
  }], ['id', 'batchNo', 'source', 'severity', 'supplierId', 'supplierName', 'description', 'attachmentSummary', 'dueDate', 'status', 'version', 'createdAt', 'createdBy', 'assignedTo', 'assignedAt', 'response', 'responseEvidence', 'responseSubmittedBy', 'responseSubmittedAt', 'approvedBy', 'approvedAt', 'approvedNote', 'closedBy', 'closedAt', 'closedNote', 'returnedBy', 'returnedAt', 'returnedReason']);

  const auditRows = auditLogs.map(log => ({
    action: log.action,
    fromStatus: log.fromStatus || '',
    toStatus: log.toStatus || '',
    operatorId: log.operatorId,
    operatorName: log.operatorName,
    operatorRole: log.operatorRole,
    reason: log.reason || '',
    timestamp: log.timestamp,
    detail: JSON.stringify(log.detail || {})
  }));
  const auditCSV = toCSV(auditRows, ['action', 'fromStatus', 'toStatus', 'operatorId', 'operatorName', 'operatorRole', 'reason', 'timestamp', 'detail']);

  return `# 整改单基本信息\n${mainCSV}\n\n# 审计记录\n${auditCSV}`;
}

module.exports = {
  parseCSV,
  toCSV,
  parseBatchImport,
  parseTemperatureImport,
  exportBatchToJSON,
  exportBatchToCSV,
  exportCalibrationsToCSV,
  exportInspectionsToCSV,
  exportInspectionDetailToCSV,
  exportCorrectiveActionsToCSV,
  exportCorrectiveActionDetailToCSV
};

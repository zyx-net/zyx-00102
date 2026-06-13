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

module.exports = {
  parseCSV,
  toCSV,
  parseBatchImport,
  parseTemperatureImport,
  exportBatchToJSON,
  exportBatchToCSV,
  exportCalibrationsToCSV
};

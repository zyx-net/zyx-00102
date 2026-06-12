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
    temperature: r.temperature !== undefined ? r.temperature : (r['温度'] !== undefined ? r['温度'] : '')
  }));
}

function exportBatchToJSON(batchDetail) {
  return JSON.stringify(batchDetail, null, 2);
}

function exportBatchToCSV(batchDetail) {
  const batch = batchDetail.batch;
  const logs = batchDetail.temperatureLogs || [];
  const audits = batchDetail.auditLogs || [];

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
    overTempCount: (batch.overTempRanges || []).length
  }], ['batchNo', 'drugName', 'manufacturer', 'quantity', 'unit', 'productionDate', 'expiryDate', 'arrivalDate', 'status', 'temperatureValid', 'overTempCount']);

  const tempCSV = toCSV(logs, ['batchNo', 'timestamp', 'temperature']);
  const auditCSV = toCSV(audits, ['action', 'fromStatus', 'toStatus', 'operatorId', 'operatorName', 'operatorRole', 'reason', 'timestamp']);

  return `# 批次信息\n${batchCSV}\n\n# 温度日志\n${tempCSV}\n\n# 审计历史\n${auditCSV}`;
}

module.exports = {
  parseCSV,
  toCSV,
  parseBatchImport,
  parseTemperatureImport,
  exportBatchToJSON,
  exportBatchToCSV
};

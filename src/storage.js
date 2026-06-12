const fs = require('fs');
const path = require('path');
const config = require('./config');

const dataFiles = {
  batches: 'batches.json',
  temperatureLogs: 'temperature-logs.json',
  auditLogs: 'audit-logs.json',
  dispositions: 'dispositions.json'
};

function ensureDataDir() {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
}

function getFilePath(filename) {
  return path.join(config.dataDir, filename);
}

function readData(filename, defaultValue) {
  ensureDataDir();
  const filePath = getFilePath(filename);
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    return defaultValue;
  }
}

function writeDataAtomic(filename, data) {
  ensureDataDir();
  const filePath = getFilePath(filename);
  const tempPath = filePath + '.tmp';
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, filePath);
}

function getBatches() {
  return readData(dataFiles.batches, {});
}

function saveBatches(batches) {
  writeDataAtomic(dataFiles.batches, batches);
}

function getBatch(batchNo) {
  const batches = getBatches();
  return batches[batchNo] || null;
}

function saveBatch(batch) {
  const batches = getBatches();
  batches[batch.batchNo] = batch;
  saveBatches(batches);
}

function getTemperatureLogs(batchNo) {
  const allLogs = readData(dataFiles.temperatureLogs, {});
  return allLogs[batchNo] || [];
}

function saveTemperatureLogs(batchNo, logs) {
  const allLogs = readData(dataFiles.temperatureLogs, {});
  allLogs[batchNo] = logs;
  writeDataAtomic(dataFiles.temperatureLogs, allLogs);
}

function getAuditLogs(batchNo) {
  const allLogs = readData(dataFiles.auditLogs, {});
  return allLogs[batchNo] || [];
}

function addAuditLog(batchNo, entry) {
  const allLogs = readData(dataFiles.auditLogs, {});
  if (!allLogs[batchNo]) {
    allLogs[batchNo] = [];
  }
  allLogs[batchNo].push(entry);
  writeDataAtomic(dataFiles.auditLogs, allLogs);
}

function getBatchAuditLogs(batchNo) {
  return getAuditLogs(batchNo);
}

function listBatches() {
  const batches = getBatches();
  return Object.values(batches).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getDispositions() {
  return readData(dataFiles.dispositions, {});
}

function saveDispositions(dispositions) {
  writeDataAtomic(dataFiles.dispositions, dispositions);
}

function getDisposition(dispositionId) {
  const dispositions = getDispositions();
  return dispositions[dispositionId] || null;
}

function saveDisposition(disposition) {
  const dispositions = getDispositions();
  dispositions[disposition.id] = disposition;
  saveDispositions(dispositions);
}

function getBatchDispositions(batchNo) {
  const dispositions = getDispositions();
  return Object.values(dispositions)
    .filter(d => d.batchNo === batchNo)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getActiveDisposition(batchNo) {
  const dispositions = getBatchDispositions(batchNo);
  const closedStatuses = ['closed'];
  return dispositions.find(d => !closedStatuses.includes(d.status)) || null;
}

module.exports = {
  getBatches,
  saveBatches,
  getBatch,
  saveBatch,
  getTemperatureLogs,
  saveTemperatureLogs,
  getAuditLogs: getBatchAuditLogs,
  addAuditLog,
  listBatches,
  getDispositions,
  saveDispositions,
  getDisposition,
  saveDisposition,
  getBatchDispositions,
  getActiveDisposition
};

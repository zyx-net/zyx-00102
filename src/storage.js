const fs = require('fs');
const path = require('path');
const config = require('./config');

const dataFiles = {
  batches: 'batches.json',
  temperatureLogs: 'temperature-logs.json',
  auditLogs: 'audit-logs.json',
  dispositions: 'dispositions.json',
  supplements: 'supplements.json',
  calibrations: 'calibrations.json',
  calibrationAuditLogs: 'calibration-audit-logs.json',
  inspections: 'inspections.json',
  inspectionAuditLogs: 'inspection-audit-logs.json'
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

function getSupplements() {
  return readData(dataFiles.supplements, {});
}

function saveSupplements(supplements) {
  writeDataAtomic(dataFiles.supplements, supplements);
}

function getSupplement(suppId) {
  const supplements = getSupplements();
  return supplements[suppId] || null;
}

function saveSupplement(supplement) {
  const supplements = getSupplements();
  supplements[supplement.id] = supplement;
  saveSupplements(supplements);
}

function getSupplementsForDisposition(dispositionId) {
  const supplements = getSupplements();
  return Object.values(supplements)
    .filter(s => s.dispositionId === dispositionId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getSupplementsForBatch(batchNo) {
  const supplements = getSupplements();
  return Object.values(supplements)
    .filter(s => s.batchNo === batchNo)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getPendingSupplementForDisposition(dispositionId) {
  const supplements = getSupplementsForDisposition(dispositionId);
  return supplements.find(s => s.status === 'pending') || null;
}

function getCalibrations() {
  return readData(dataFiles.calibrations, {});
}

function saveCalibrations(calibrations) {
  writeDataAtomic(dataFiles.calibrations, calibrations);
}

function getCalibration(calibrationId) {
  const calibrations = getCalibrations();
  return calibrations[calibrationId] || null;
}

function saveCalibration(calibration) {
  const calibrations = getCalibrations();
  calibrations[calibration.id] = calibration;
  saveCalibrations(calibrations);
}

function listCalibrations() {
  const calibrations = getCalibrations();
  return Object.values(calibrations).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getCalibrationsByDevice(deviceNo) {
  return listCalibrations().filter(c => c.deviceNo === deviceNo);
}

function getActiveCalibrationForDevice(deviceNo) {
  const records = getCalibrationsByDevice(deviceNo);
  const now = new Date();
  return records.find(c =>
    c.status === config.calibrationStatus.ACTIVE &&
    new Date(c.validUntil) > now
  ) || null;
}

function getCalibrationAuditLogs(calibrationId) {
  const allLogs = readData(dataFiles.calibrationAuditLogs, {});
  return (allLogs[calibrationId] || []).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function addCalibrationAuditLog(calibrationId, entry) {
  const allLogs = readData(dataFiles.calibrationAuditLogs, {});
  if (!allLogs[calibrationId]) {
    allLogs[calibrationId] = [];
  }
  allLogs[calibrationId].push(entry);
  writeDataAtomic(dataFiles.calibrationAuditLogs, allLogs);
}

function getInspections() {
  return readData(dataFiles.inspections, {});
}

function saveInspections(inspections) {
  writeDataAtomic(dataFiles.inspections, inspections);
}

function getInspection(inspectionId) {
  const inspections = getInspections();
  return inspections[inspectionId] || null;
}

function saveInspection(inspection) {
  const inspections = getInspections();
  inspections[inspection.id] = inspection;
  saveInspections(inspections);
}

function listInspections() {
  const inspections = getInspections();
  return Object.values(inspections).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getInspectionsByBatch(batchNo) {
  return listInspections().filter(i => i.batchNo === batchNo);
}

function getActiveInspectionForBatch(batchNo) {
  const config = require('./config');
  const openStatuses = [config.inspectionStatus.PENDING, config.inspectionStatus.SUBMITTED, config.inspectionStatus.RETURNED];
  const batchInspections = getInspectionsByBatch(batchNo);
  return batchInspections.find(i => openStatuses.includes(i.status)) || null;
}

function getInspectionAuditLogs(inspectionId) {
  const allLogs = readData(dataFiles.inspectionAuditLogs, {});
  return (allLogs[inspectionId] || []).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function addInspectionAuditLog(inspectionId, entry) {
  const allLogs = readData(dataFiles.inspectionAuditLogs, {});
  if (!allLogs[inspectionId]) {
    allLogs[inspectionId] = [];
  }
  allLogs[inspectionId].push(entry);
  writeDataAtomic(dataFiles.inspectionAuditLogs, allLogs);
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
  getActiveDisposition,
  getSupplements,
  saveSupplements,
  getSupplement,
  saveSupplement,
  getSupplementsForDisposition,
  getSupplementsForBatch,
  getPendingSupplementForDisposition,
  getCalibrations,
  saveCalibrations,
  getCalibration,
  saveCalibration,
  listCalibrations,
  getCalibrationsByDevice,
  getActiveCalibrationForDevice,
  getCalibrationAuditLogs,
  addCalibrationAuditLog,
  getInspections,
  saveInspections,
  getInspection,
  saveInspection,
  listInspections,
  getInspectionsByBatch,
  getActiveInspectionForBatch,
  getInspectionAuditLogs,
  addInspectionAuditLog
};

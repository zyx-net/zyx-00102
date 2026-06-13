const express = require('express');
const router = express.Router();
const calibrationService = require('../services/calibrationService');

function requireOperator(req, res, next) {
  const operatorId = req.headers['x-operator-id'];
  if (!operatorId) {
    return res.status(400).json({ error: '缺少 X-Operator-Id 头' });
  }
  const user = calibrationService.findUser(operatorId);
  if (!user) {
    return res.status(404).json({ error: '操作员不存在' });
  }
  req.operator = user;
  next();
}

router.get('/', requireOperator, (req, res) => {
  const filters = {};
  if (req.query.deviceNo) filters.deviceNo = req.query.deviceNo;
  if (req.query.deviceType) filters.deviceType = req.query.deviceType;
  if (req.query.status) filters.status = req.query.status;
  const records = calibrationService.listAllCalibrations(filters);
  res.json({ calibrations: records });
});

router.get('/validate', requireOperator, (req, res) => {
  const deviceNo = req.query.deviceNo;
  if (!deviceNo) {
    return res.status(400).json({ error: '缺少 deviceNo 参数' });
  }
  const result = calibrationService.validateDevice(deviceNo);
  if (!result.valid) {
    return res.status(200).json({ valid: false, error: result.error, errorType: result.errorType });
  }
  res.json({ valid: true, calibration: result.calibration });
});

router.get('/validate-batch', requireOperator, (req, res) => {
  const deviceNos = req.query.deviceNos ? req.query.deviceNos.split(',').map(s => s.trim()) : [];
  const result = calibrationService.validateDevicesForReference(deviceNos);
  if (!result.valid) {
    return res.status(200).json({ valid: false, errors: result.errors, warnings: result.warnings });
  }
  res.json({ valid: true, warnings: result.warnings });
});

router.post('/', requireOperator, (req, res) => {
  const result = calibrationService.createCalibration(req.body, req.operator.id);
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.status(201).json({ success: true, calibration: result.calibration });
});

router.get('/:calibrationId', requireOperator, (req, res) => {
  const detail = calibrationService.getCalibrationDetail(req.params.calibrationId);
  if (!detail) {
    return res.status(404).json({ error: '校准记录不存在' });
  }
  res.json(detail);
});

router.put('/:calibrationId', requireOperator, (req, res) => {
  const { expectedVersion, ...updateData } = req.body;
  const result = calibrationService.updateCalibration(
    req.params.calibrationId,
    updateData,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, calibration: result.calibration });
});

router.put('/:calibrationId/expiry', requireOperator, (req, res) => {
  const { validUntil, reason, expectedVersion } = req.body;
  const result = calibrationService.changeCalibrationExpiry(
    req.params.calibrationId,
    validUntil,
    req.operator.id,
    reason,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, calibration: result.calibration });
});

router.post('/:calibrationId/void', requireOperator, (req, res) => {
  const { reason } = req.body;
  const result = calibrationService.voidCalibration(
    req.params.calibrationId,
    req.operator.id,
    reason
  );
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, calibration: result.calibration });
});

router.get('/:calibrationId/audit', requireOperator, (req, res) => {
  const detail = calibrationService.getCalibrationDetail(req.params.calibrationId);
  if (!detail) {
    return res.status(404).json({ error: '校准记录不存在' });
  }
  res.json({ auditLogs: detail.auditLogs });
});

router.post('/import', requireOperator, (req, res) => {
  const format = req.query.format || 'json';
  let records;
  try {
    if (format === 'csv') {
      const importExportService = require('../services/importExportService');
      records = importExportService.parseCSV(req.body);
    } else {
      const data = req.body;
      records = Array.isArray(data) ? data : [data];
    }
  } catch (err) {
    return res.status(400).json({ error: '解析失败: ' + err.message });
  }

  const result = calibrationService.importCalibrations(records, req.operator.id);
  if (!result.success) {
    return res.status(400).json({
      success: false,
      error: result.error,
      results: result.results || [],
      allSuccess: false
    });
  }
  res.json({ success: true, results: result.results, allSuccess: result.allSuccess });
});

router.get('/export/all', requireOperator, (req, res) => {
  const format = req.query.format || 'json';
  const records = calibrationService.listAllCalibrations();

  if (format === 'csv') {
    const importExportService = require('../services/importExportService');
    const csv = importExportService.exportCalibrationsToCSV(records);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="calibrations.csv"');
    res.send('\uFEFF' + csv);
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="calibrations.json"');
    res.send(JSON.stringify({ calibrations: records }, null, 2));
  }
});

module.exports = router;

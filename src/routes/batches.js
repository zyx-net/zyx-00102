const express = require('express');
const router = express.Router();
const batchService = require('../services/batchService');
const dispositionService = require('../services/dispositionService');
const importExportService = require('../services/importExportService');

function requireOperator(req, res, next) {
  const operatorId = req.headers['x-operator-id'];
  if (!operatorId) {
    return res.status(400).json({ error: '缺少 X-Operator-Id 头' });
  }
  const user = batchService.findUser(operatorId);
  if (!user) {
    return res.status(404).json({ error: '操作员不存在' });
  }
  req.operator = user;
  next();
}

router.get('/', requireOperator, (req, res) => {
  const batches = batchService.listAllBatches();
  res.json({ batches });
});

router.post('/import', requireOperator, (req, res) => {
  const format = req.query.format || 'json';
  const data = req.body;

  try {
    const batches = importExportService.parseBatchImport(data, format);
    const result = batchService.createBatches(batches, req.operator.id);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        results: result.results,
        allSuccess: false
      });
    }

    res.json({
      success: true,
      results: result.results,
      allSuccess: true,
      batches: result.batches
    });
  } catch (err) {
    res.status(400).json({ error: '解析失败: ' + err.message });
  }
});

router.get('/dispositions', requireOperator, (req, res) => {
  const dispositions = dispositionService.listAllDispositions();
  res.json({ dispositions });
});

router.get('/dispositions/:dispositionId', requireOperator, (req, res) => {
  const disposition = dispositionService.getDispositionDetail(req.params.dispositionId);
  if (!disposition) {
    return res.status(404).json({ error: '处置单不存在' });
  }
  res.json({ disposition });
});

router.put('/dispositions/:dispositionId', requireOperator, (req, res) => {
  const expectedVersion = req.body.expectedVersion;
  const updateData = { ...req.body };
  delete updateData.expectedVersion;
  const result = dispositionService.updateDisposition(
    req.params.dispositionId,
    updateData,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, disposition: result.disposition });
});

router.post('/dispositions/:dispositionId/submit', requireOperator, (req, res) => {
  const expectedVersion = req.body?.expectedVersion;
  const result = dispositionService.submitForApproval(
    req.params.dispositionId,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, disposition: result.disposition });
});

router.post('/dispositions/:dispositionId/approve', requireOperator, (req, res) => {
  const { decision, reason, expectedVersion } = req.body || {};
  const result = dispositionService.approveDisposition(
    req.params.dispositionId,
    decision,
    reason,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, disposition: result.disposition, batch: result.batch });
});

router.post('/dispositions/:dispositionId/return', requireOperator, (req, res) => {
  const { returnReason, expectedVersion } = req.body || {};
  const result = dispositionService.returnForSupplement(
    req.params.dispositionId,
    returnReason,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, disposition: result.disposition });
});

router.get('/:batchNo', requireOperator, (req, res) => {
  const detail = batchService.getBatchDetail(req.params.batchNo);
  if (!detail) {
    return res.status(404).json({ error: '批次不存在' });
  }
  res.json(detail);
});

router.get('/:batchNo/audit', requireOperator, (req, res) => {
  const detail = batchService.getBatchDetail(req.params.batchNo);
  if (!detail) {
    return res.status(404).json({ error: '批次不存在' });
  }
  res.json({ auditLogs: detail.auditLogs });
});

router.post('/:batchNo/temperature/import', requireOperator, (req, res) => {
  const format = req.query.format || 'json';
  const data = req.body;

  try {
    const logs = importExportService.parseTemperatureImport(data, format);
    const result = batchService.importTemperatureLogs(req.params.batchNo, logs, req.operator.id);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        errors: result.errors || [],
        warnings: result.warnings || []
      });
    }

    res.json({
      success: true,
      batch: result.batch,
      overTempRanges: result.overTempRanges,
      autoQuarantined: result.autoQuarantined
    });
  } catch (err) {
    res.status(400).json({ error: '解析失败: ' + err.message });
  }
});

router.post('/:batchNo/review', requireOperator, (req, res) => {
  const { decision, reason } = req.body;
  const result = batchService.reviewBatch(req.params.batchNo, req.operator.id, decision, reason);
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, batch: result.batch });
});

router.post('/:batchNo/finalize', requireOperator, (req, res) => {
  const { decision, reason } = req.body;
  const result = batchService.finalizeBatch(req.params.batchNo, req.operator.id, decision, reason);
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, batch: result.batch });
});

router.get('/:batchNo/export', requireOperator, (req, res) => {
  const format = req.query.format || 'json';
  const detail = batchService.getBatchDetail(req.params.batchNo);
  if (!detail) {
    return res.status(404).json({ error: '批次不存在' });
  }

  if (format === 'csv') {
    const csv = importExportService.exportBatchToCSV(detail);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.batchNo}.csv"`);
    res.send('\uFEFF' + csv);
  } else {
    const json = importExportService.exportBatchToJSON(detail);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.batchNo}.json"`);
    res.send(json);
  }
});

router.get('/:batchNo/dispositions', requireOperator, (req, res) => {
  const dispositions = dispositionService.getBatchDispositions(req.params.batchNo);
  res.json({ dispositions });
});

router.get('/:batchNo/dispositions/active', requireOperator, (req, res) => {
  const disposition = dispositionService.getActiveDisposition(req.params.batchNo);
  if (!disposition) {
    return res.status(404).json({ error: '该批次没有进行中的处置单' });
  }
  res.json({ disposition });
});

router.post('/:batchNo/dispositions', requireOperator, (req, res) => {
  const result = dispositionService.createDisposition(
    { ...req.body, batchNo: req.params.batchNo },
    req.operator.id
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.status(201).json({ success: true, disposition: result.disposition });
});

module.exports = router;

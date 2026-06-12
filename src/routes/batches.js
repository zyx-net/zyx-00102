const express = require('express');
const router = express.Router();
const batchService = require('../services/batchService');
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

module.exports = router;

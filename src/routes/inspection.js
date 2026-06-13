const express = require('express');
const router = express.Router();
const inspectionService = require('../services/inspectionService');
const importExportService = require('../services/importExportService');

function requireOperator(req, res, next) {
  const operatorId = req.headers['x-operator-id'];
  if (!operatorId) {
    return res.status(400).json({ error: '缺少 X-Operator-Id 头' });
  }
  const user = inspectionService.findUser(operatorId);
  if (!user) {
    return res.status(404).json({ error: '操作员不存在' });
  }
  req.operator = user;
  next();
}

router.get('/', requireOperator, (req, res) => {
  const filters = {};
  if (req.query.batchNo) filters.batchNo = req.query.batchNo;
  if (req.query.status) filters.status = req.query.status;
  const result = inspectionService.listAllInspections(filters, req.operator.id);
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ inspections: result.inspections });
});

router.get('/batch/:batchNo', requireOperator, (req, res) => {
  const result = inspectionService.getInspectionsByBatch(req.params.batchNo, req.operator.id);
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ inspections: result.inspections });
});

router.post('/', requireOperator, (req, res) => {
  const result = inspectionService.createInspection(req.body, req.operator.id);
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.status(201).json({ success: true, inspection: result.inspection });
});

router.get('/:inspectionId', requireOperator, (req, res) => {
  if (!inspectionService.hasInspectionPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限查看抽检任务' });
  }
  const detail = inspectionService.getInspectionDetail(req.params.inspectionId);
  if (!detail) {
    return res.status(404).json({ error: '抽检任务不存在' });
  }
  res.json(detail);
});

router.get('/:inspectionId/audit', requireOperator, (req, res) => {
  if (!inspectionService.hasInspectionPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限查看审计记录' });
  }
  const detail = inspectionService.getInspectionDetail(req.params.inspectionId);
  if (!detail) {
    return res.status(404).json({ error: '抽检任务不存在' });
  }
  res.json({ auditLogs: detail.auditLogs });
});

router.put('/:inspectionId/submit', requireOperator, (req, res) => {
  const result = inspectionService.submitInspectionResult(
    req.params.inspectionId,
    req.body,
    req.operator.id
  );
  if (!result.success) {
    let status = 400;
    if (result.conflict) status = 409;
    if (result.invalidStatus) status = 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, inspection: result.inspection });
});

router.post('/:inspectionId/approve', requireOperator, (req, res) => {
  const result = inspectionService.approveInspection(
    req.params.inspectionId,
    req.body,
    req.operator.id
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, inspection: result.inspection });
});

router.post('/:inspectionId/return', requireOperator, (req, res) => {
  const result = inspectionService.returnInspection(
    req.params.inspectionId,
    req.body,
    req.operator.id
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, inspection: result.inspection });
});

router.get('/export/all', requireOperator, (req, res) => {
  if (!inspectionService.hasInspectionPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限导出抽检任务' });
  }
  const format = req.query.format || 'json';
  const result = inspectionService.listAllInspections({}, req.operator.id);
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  const records = result.inspections;

  if (format === 'csv') {
    const csv = importExportService.exportInspectionsToCSV(records);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inspections.csv"');
    res.send('\uFEFF' + csv);
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inspections.json"');
    res.send(JSON.stringify({ inspections: records }, null, 2));
  }
});

router.get('/export/:inspectionId', requireOperator, (req, res) => {
  if (!inspectionService.hasInspectionPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限导出抽检任务' });
  }
  const format = req.query.format || 'json';
  const detail = inspectionService.getInspectionDetail(req.params.inspectionId);
  if (!detail) {
    return res.status(404).json({ error: '抽检任务不存在' });
  }

  if (format === 'csv') {
    const csv = importExportService.exportInspectionDetailToCSV(detail);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inspection-${req.params.inspectionId}.csv"`);
    res.send('\uFEFF' + csv);
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inspection-${req.params.inspectionId}.json"`);
    res.send(JSON.stringify(detail, null, 2));
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const correctiveActionService = require('../services/correctiveActionService');
const importExportService = require('../services/importExportService');

function requireOperator(req, res, next) {
  const operatorId = req.headers['x-operator-id'];
  if (!operatorId) {
    return res.status(400).json({ error: '缺少 X-Operator-Id 头' });
  }
  const user = correctiveActionService.findUser(operatorId);
  if (!user) {
    return res.status(404).json({ error: '操作员不存在' });
  }
  req.operator = user;
  next();
}

router.get('/', requireOperator, (req, res) => {
  if (!correctiveActionService.hasPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限查看整改单' });
  }
  
  const filters = {};
  if (req.query.batchNo) filters.batchNo = req.query.batchNo;
  if (req.query.supplierId) filters.supplierId = req.query.supplierId;
  if (req.query.status) filters.status = req.query.status;
  
  const actions = correctiveActionService.listActions(filters);
  res.json({ correctiveActions: actions });
});

router.get('/batch/:batchNo', requireOperator, (req, res) => {
  if (!correctiveActionService.hasPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限查看整改单' });
  }
  
  const actions = correctiveActionService.listActions({ batchNo: req.params.batchNo });
  res.json({ correctiveActions: actions });
});

router.get('/supplier/:supplierId', requireOperator, (req, res) => {
  if (!correctiveActionService.hasPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限查看整改单' });
  }
  
  const actions = correctiveActionService.listActions({ supplierId: req.params.supplierId });
  res.json({ correctiveActions: actions });
});

router.post('/', requireOperator, (req, res) => {
  const result = correctiveActionService.createCorrectiveAction(req.body, req.operator.id);
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.status(201).json({ success: true, correctiveAction: result.action });
});

router.get('/:actionId', requireOperator, (req, res) => {
  if (!correctiveActionService.hasPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限查看整改单' });
  }
  
  const detail = correctiveActionService.getActionDetail(req.params.actionId);
  if (!detail) {
    return res.status(404).json({ error: '整改单不存在' });
  }
  res.json({ correctiveAction: detail });
});

router.get('/:actionId/audit', requireOperator, (req, res) => {
  if (!correctiveActionService.hasPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限查看审计记录' });
  }
  
  const detail = correctiveActionService.getActionDetail(req.params.actionId);
  if (!detail) {
    return res.status(404).json({ error: '整改单不存在' });
  }
  res.json({ auditLogs: detail.auditLogs });
});

router.post('/:actionId/submit', requireOperator, (req, res) => {
  const expectedVersion = req.body?.expectedVersion;
  const result = correctiveActionService.submitForAssign(
    req.params.actionId,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, correctiveAction: result.action });
});

router.post('/:actionId/assign', requireOperator, (req, res) => {
  const { assigneeId, expectedVersion } = req.body;
  const result = correctiveActionService.assignAction(
    req.params.actionId,
    assigneeId,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, correctiveAction: result.action });
});

router.post('/:actionId/response', requireOperator, (req, res) => {
  const { expectedVersion, ...responseData } = req.body;
  const result = correctiveActionService.submitResponse(
    req.params.actionId,
    responseData,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, correctiveAction: result.action });
});

router.post('/:actionId/approve', requireOperator, (req, res) => {
  const { note, expectedVersion } = req.body;
  const result = correctiveActionService.approveAction(
    req.params.actionId,
    note,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, correctiveAction: result.action });
});

router.post('/:actionId/close', requireOperator, (req, res) => {
  const { note, expectedVersion } = req.body;
  const result = correctiveActionService.closeAction(
    req.params.actionId,
    note,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, correctiveAction: result.action });
});

router.post('/:actionId/return', requireOperator, (req, res) => {
  const { reason, expectedVersion } = req.body;
  const result = correctiveActionService.returnAction(
    req.params.actionId,
    reason,
    req.operator.id,
    expectedVersion
  );
  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    return res.status(status).json({ success: false, error: result.error, ...result });
  }
  res.json({ success: true, correctiveAction: result.action });
});

router.get('/export/all', requireOperator, (req, res) => {
  if (!correctiveActionService.hasPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限导出整改单' });
  }
  
  const format = req.query.format || 'json';
  const filters = {};
  if (req.query.batchNo) filters.batchNo = req.query.batchNo;
  if (req.query.supplierId) filters.supplierId = req.query.supplierId;
  
  const actions = correctiveActionService.listActions(filters);
  
  if (format === 'csv') {
    const csv = importExportService.exportCorrectiveActionsToCSV(actions);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="corrective-actions.csv"');
    res.send('\uFEFF' + csv);
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="corrective-actions.json"');
    res.send(JSON.stringify({ correctiveActions: actions }, null, 2));
  }
});

router.get('/export/:actionId', requireOperator, (req, res) => {
  if (!correctiveActionService.hasPermission(req.operator.role, 'view')) {
    return res.status(403).json({ error: '无权限导出整改单' });
  }
  
  const format = req.query.format || 'json';
  const detail = correctiveActionService.getActionDetail(req.params.actionId);
  if (!detail) {
    return res.status(404).json({ error: '整改单不存在' });
  }
  
  if (format === 'csv') {
    const csv = importExportService.exportCorrectiveActionDetailToCSV(detail);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="corrective-action-${req.params.actionId}.csv"`);
    res.send('\uFEFF' + csv);
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="corrective-action-${req.params.actionId}.json"`);
    res.send(JSON.stringify({ correctiveAction: detail }, null, 2));
  }
});

module.exports = router;
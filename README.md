# 药品冷链到货放行 API 服务

本地药品冷链到货放行 JSON API 服务，用于导入到货记录和温度日志，判断批次是否可放行。

## 功能特性

- 多角色权限控制：收货员、药师、质管负责人
- 批次状态管理：待复核、隔离、已放行、已拒收、已作废
- 温控偏差处置单：药师创建 → 提交审批 → 质管审批/退回补证
- 退回补证包：质管退回 → 药师补证 → 自动重新提交审批
- 温度日志校验：时间倒序检测、缺失温度段检测、超温区间识别
- 完整审计历史：记录每次判定依据和操作者
- 数据持久化：JSON 文件存储，服务重启后数据一致
- 支持 CSV/JSON 格式导入导出
- 到货抽检任务：质管创建 → 药师录入结果 → 质管确认/退回，带版本号和审计

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
npm start
```

服务默认运行在 `http://localhost:3000`

## 角色说明

| 用户 ID | 姓名 | 角色 | 权限 |
|---------|------|------|------|
| receiver01 | 张收货 | 收货员 | 导入到货记录、导入温度日志、查看批次和处置单 |
| pharmacist01 | 李药师 | 药师 | 创建/更新/提交处置单、提交补证包、查看 |
| quality01 | 王质管 | 质管负责人 | 审批处置单、退回补证、放行、拒收、备注、查看 |

## 状态流转

```
待复核 (pending_review)
    ↓ （超温自动隔离）
 隔离 (quarantined)  ←─────┐
    ↓    ↑                 │
 ┌──┴────┴──┐              │
 ↓          ↓              │
已放行    已拒收           │
(released) (rejected)      │
    ↓          ↓           │
    └──────┬───┘           │
           ↓               │
         已作废 ───────────┘
         (voided)
```

**处置单状态流转（隔离批次专用）：**

```
草稿 (draft)
    ↓ 药师提交
待审批 (pending_approval)
    ↓              ↓ 质管退回
质管审批         退回补证 (returned_for_supplement)
    ↓              ↓ 药师提交补证包
 放行/拒收       自动回到待审批 (pending_approval)
    ↓
 关闭 (closed)
```

**重要说明：**
- **整批回滚**：批次导入采用预校验机制，所有记录全部通过校验才会写入。只要有一条记录不合法（缺失批号、重复批号等），整批全部回滚，不产生任何半截数据。
- **超温自动隔离**：导入温度日志时如果检测到超温区间，批次自动从 `pending_review` 进入 `quarantined` 状态，并记录审计日志。后续必须由药师复核、质管负责人决定放行或拒收。
- **失败无残留**：温度日志导入失败时（时间倒序、缺失温度段、批号不匹配），不会写入任何数据，批次状态保持不变。
- **退回补证闭环**：质管退回处置单时自动创建补证包（状态 pending），药师必须通过补证包提交路由提交补充材料，提交后处置单自动回到待审批状态，不允许绕过补证流程直接重新提交。同一处置单存在未完成补证包时，重复退回或重复提交均返回 409 冲突。

## API 接口

所有接口需要在请求头中携带 `X-Operator-Id` 标识操作员。

### 健康检查

```bash
curl http://localhost:3000/health
```

### 获取用户列表

```bash
curl http://localhost:3000/users
```

### 1. 收货员导入批次

**JSON 格式：**

```bash
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  -d '[{"batchNo":"BATCH-2024-001","drugName":"胰岛素注射液","manufacturer":"某制药有限公司","quantity":500,"unit":"盒","productionDate":"2024-01-15","expiryDate":"2026-01-14"}]'
```

**CSV 格式：**

```bash
curl -X POST "http://localhost:3000/api/batches/import?format=csv" \
  -H "Content-Type: text/plain" \
  -H "X-Operator-Id: receiver01" \
  -d $'batchNo,drugName,manufacturer,quantity,unit,productionDate,expiryDate\nBATCH-2024-001,胰岛素注射液,某制药有限公司,500,盒,2024-01-15,2026-01-14'
```

**使用样例文件：**

```bash
# JSON 格式
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  --data-binary @samples/batches.json

# CSV 格式
curl -X POST "http://localhost:3000/api/batches/import?format=csv" \
  -H "Content-Type: text/plain" \
  -H "X-Operator-Id: receiver01" \
  --data-binary @samples/batches.csv
```

### 2. 收货员导入温度日志

**正常温度：**

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/temperature/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  --data-binary @samples/temperature-normal.json
```

**超温温度（有警告但可导入）：**

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/temperature/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  --data-binary @samples/temperature-overtemp.json
```

**时间倒序（导入失败）：**

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/temperature/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  --data-binary @samples/temperature-outoforder.json
```

**缺失温度段（导入失败）：**

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/temperature/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  --data-binary @samples/temperature-gap.json
```

### 3. 查看批次列表

```bash
curl http://localhost:3000/api/batches \
  -H "X-Operator-Id: pharmacist01"
```

### 4. 查看批次详情

```bash
curl http://localhost:3000/api/batches/BATCH-2024-001 \
  -H "X-Operator-Id: pharmacist01"
```

### 5. 查看审计历史

```bash
curl http://localhost:3000/api/batches/BATCH-2024-001/audit \
  -H "X-Operator-Id: pharmacist01"
```

### 6. 药师复核（置为隔离）

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/review \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: pharmacist01" \
  -d '{"decision":"quarantine","reason":"温度日志存在超温，需进一步评估"}'
```

### 7. 质管负责人放行

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/finalize \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"decision":"release","reason":"超温时间短，经评估不影响药品质量，同意放行"}'
```

### 8. 质管负责人拒收

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-002/finalize \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"decision":"reject","reason":"温度严重超标，拒收"}'
```

### 9. 导出批次数据

**JSON 格式：**

```bash
curl http://localhost:3000/api/batches/BATCH-2024-001/export?format=json \
  -H "X-Operator-Id: quality01"
```

**CSV 格式：**

```bash
curl http://localhost:3000/api/batches/BATCH-2024-001/export?format=csv \
  -H "X-Operator-Id: quality01"
```

### 10. 温控偏差处置单

隔离状态批次可创建处置单，完整走 药师创建 → 提交审批 → 质管审批/退回 流程。

**药师创建处置单：**

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/dispositions \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: pharmacist01" \
  -d '{
    "deviationLevel": "moderate",
    "cause": "冷链箱中途断电10分钟导致温度超标",
    "suggestedAction": "评估影响范围后可放行",
    "attachmentSummary": "冷链箱断电记录.pdf、温度曲线截图.png"
  }'
```

**药师提交审批：**

```bash
curl -X POST http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/submit \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: pharmacist01"
```

**质管审批放行：**

```bash
curl -X POST http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/approve \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"decision":"release","reason":"超温时间短，同意放行"}'
```

**质管审批拒收：**

```bash
curl -X POST http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/approve \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"decision":"reject","reason":"全程超标，予以拒收"}'
```

**查看处置单列表：**

```bash
# 全部处置单
curl http://localhost:3000/api/batches/dispositions \
  -H "X-Operator-Id: quality01"

# 某批次的处置单
curl http://localhost:3000/api/batches/BATCH-2024-001/dispositions \
  -H "X-Operator-Id: pharmacist01"

# 单个处置单详情
curl http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX \
  -H "X-Operator-Id: receiver01"
```

### 11. 退回补证包

质管在审批处置单时如果认为材料不足，可以退回给药师补充证据。

**质管退回处置单（自动创建补证包）：**

```bash
curl -X POST http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/return \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"returnReason":"请补充断电时间段的仓库环境温度记录和同批次其他箱子温度数据"}'
```

返回值包含 `disposition`（状态变为 `returned_for_supplement`）和 `supplement`（补证包，初始状态 `pending`）。

**药师提交补证包：**

```bash
curl -X POST http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/supplement/submit \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: pharmacist01" \
  -d '{
    "supplementDescription": "已补充断电时间段的仓库环境温度记录，同批次其他箱子温度均在正常范围内",
    "relatedTempRangeIndices": [0],
    "attachmentList": "仓库环境温度记录.xlsx、同批次其他箱子温度监测报告.pdf"
  }'

```

提交后补证包状态变为 `submitted`，处置单自动回到 `pending_approval` 待质管再次审批。

**查看补证包：**

```bash
# 按处置单查询补证包
curl http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/supplement \
  -H "X-Operator-Id: receiver01"

# 按批次查询补证包
curl http://localhost:3000/api/batches/BATCH-2024-001/supplements \
  -H "X-Operator-Id: pharmacist01"
```

**权限说明：**

| 操作 | 收货员 | 药师 | 质管 |
|------|--------|------|------|
| 退回处置单（创建补证包） | ✗ | ✗ | ✓ |
| 提交补证包 | ✗ | ✓ | ✗ |
| 查看补证包 | ✓ | ✓ | ✓ |

**冲突处理：**
- 同一处置单存在 `pending` 补证包时，再次退回返回 **409 Conflict**
- 补证包已 `submitted` 后再次提交返回 **409 Conflict**
- 处置单处于 `returned_for_supplement` 且存在 `pending` 补证包时，旧提交路由（`/dispositions/:id/submit`）被阻断，返回 **409 Conflict**

**补证包字段示例：**

```json
{
  "id": "SUPP-20260613-A1B2",
  "dispositionId": "DISP-20260613-C3D4",
  "batchNo": "BATCH-2024-001",
  "status": "submitted",
  "returnReason": "请补充仓库环境温度记录",
  "returnedBy": "quality01",
  "returnedByName": "王质管",
  "returnedAt": "2026-06-13T08:30:00.000Z",
  "supplementDescription": "已补充仓库环境温度记录",
  "relatedTempRangeIndices": [0],
  "relatedTempRanges": [{ "startTime": "...", "endTime": "...", "maxTemp": 10.2 }],
  "attachmentList": "仓库环境温度记录.xlsx",
  "submittedBy": "pharmacist01",
  "submittedByName": "李药师",
  "submittedAt": "2026-06-13T09:00:00.000Z",
  "createdAt": "2026-06-13T08:30:00.000Z",
  "updatedAt": "2026-06-13T09:00:00.000Z",
  "version": 2
}
```

### 12. 质管导出备注

已终态（放行/拒收）批次可由质管添加备注，支持乐观并发控制。

```bash
# 新增备注
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/quality-remark \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"content":"风险说明：超温时间短，后续加严抽检。"}'

# 更新备注（带版本控制）
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/quality-remark \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"content":"更新内容...","expectedVersion":1}'
```

## 完整主链路示例

```bash
# 1. 收货员导入批次
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  -d '[{"batchNo":"BATCH-TEST-001","drugName":"测试药品","manufacturer":"测试药厂","quantity":100,"unit":"盒","productionDate":"2024-01-01","expiryDate":"2025-12-31"}]'

# 2. 收货员导入温度日志（超温自动隔离）
curl -X POST http://localhost:3000/api/batches/BATCH-TEST-001/temperature/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  -d '[{"batchNo":"BATCH-TEST-001","timestamp":"2024-06-01T08:00:00.000Z","temperature":4.5},{"batchNo":"BATCH-TEST-001","timestamp":"2024-06-01T08:05:00.000Z","temperature":9.5},{"batchNo":"BATCH-TEST-001","timestamp":"2024-06-01T08:10:00.000Z","temperature":5.0}]'

# 3. 药师创建处置单
curl -X POST http://localhost:3000/api/batches/BATCH-TEST-001/dispositions \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: pharmacist01" \
  -d '{"deviationLevel":"moderate","cause":"中途断电10分钟","suggestedAction":"评估后可放行","attachmentSummary":"断电记录.pdf"}'

# 4. 药师提交审批
curl -X POST http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/submit \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: pharmacist01"

# 5a. 质管审批放行（材料充足时）
curl -X POST http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/approve \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"decision":"release","reason":"超温时间短，同意放行"}'

# --- 或 ---

# 5b. 质管退回补证（材料不足时）
curl -X POST http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/return \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"returnReason":"请补充仓库环境温度记录"}'

# 6. 药师提交补证包
curl -X POST http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/supplement/submit \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: pharmacist01" \
  -d '{"supplementDescription":"已补充仓库环境温度记录","relatedTempRangeIndices":[0],"attachmentList":"仓库温度记录.xlsx"}'

# 7. 补证后处置单自动回到待审批，质管再次审批放行
curl -X POST http://localhost:3000/api/batches/dispositions/DISP-XXXXXXXX-XXXX/approve \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"decision":"release","reason":"补证材料齐全，同意放行"}'

# 8. 查看审计历史（验证操作记录）
curl http://localhost:3000/api/batches/BATCH-TEST-001/audit \
  -H "X-Operator-Id: quality01"

# 9. 导出数据（包含处置单和补证包）
curl http://localhost:3000/api/batches/BATCH-TEST-001/export?format=json \
  -H "X-Operator-Id: quality01"
```

## 失败场景测试

### 收货员越权放行（应失败）

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/finalize \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  -d '{"decision":"release","reason":"越权操作"}'
```

### 批号不匹配（应失败）

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/temperature/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  -d '[{"batchNo":"WRONG-BATCH","timestamp":"2024-06-01T08:00:00.000Z","temperature":4.5}]'
```

### 时间倒序（应失败）

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/temperature/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  --data-binary @samples/temperature-outoforder.json
```

### 缺失温度段（应失败）

```bash
curl -X POST http://localhost:3000/api/batches/BATCH-2024-001/temperature/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  --data-binary @samples/temperature-gap.json
```

## 数据存储

所有数据存储在 `data/` 目录下的 JSON 文件中：

| 文件 | 内容 |
|------|------|
| `batches.json` | 批次信息（含质管备注 `qualityRemark`、关联设备 `deviceNos`） |
| `temperature-logs.json` | 温度日志 |
| `audit-logs.json` | 审计历史（含补证包审计动作） |
| `dispositions.json` | 处置单（含退回原因、退回人） |
| `supplements.json` | 补证包（含提交人、提交时间、关联温度区间、附件清单） |
| `calibrations.json` | 校准记录（含设备编号、证书编号、有效期） |
| `calibration-audit-logs.json` | 校准记录审计日志 |
| `inspections.json` | 到货抽检任务（含抽检项目、检测结果、版本号） |
| `inspection-audit-logs.json` | 抽检任务审计日志 |

服务重启后数据保持一致。

### 补证包审计动作

| 动作 | 触发时机 |
|------|---------|
| `supplement_create` | 质管退回处置单，自动创建补证包 |
| `supplement_submit` | 药师提交补证包 |
| `supplement_submit_denied` | 越权提交补证包被拒 |
| `disposition_return_supplement` | 质管退回处置单 |
| `disposition_resubmit_after_supplement` | 补证提交后处置单自动回到待审批 |

### 补证包导出字段

**JSON 导出**：`supplements` 数组，每个元素包含完整补证包对象。

**CSV 导出**：`# 补证包` 段，列包含 `id, dispositionId, status, returnReason, supplementDescription, attachmentList, submittedBy, submittedAt, returnedBy, returnedAt`。

## 13. 冷链温度设备校准记录

收货前对温度计、记录仪的校准证书和有效期进行管理，确保引用的设备处于有效校准状态。

**创建校准记录：**

```bash
curl -X POST http://localhost:3000/api/calibrations \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{
    "deviceNo": "TEMP-001",
    "deviceType": "thermometer",
    "certificateNo": "CERT-2026-001",
    "calibratedAt": "2026-01-15",
    "validUntil": "2027-01-15",
    "calibrationUnit": "℃",
    "remark": "年度校准"
  }'
```

**查询校准记录：**

```bash
# 全部校准记录
curl http://localhost:3000/api/calibrations \
  -H "X-Operator-Id: receiver01"

# 按设备编号过滤
curl "http://localhost:3000/api/calibrations?deviceNo=TEMP-001" \
  -H "X-Operator-Id: receiver01"

# 按状态过滤
curl "http://localhost:3000/api/calibrations?status=active" \
  -H "X-Operator-Id: receiver01"

# 单条详情
curl http://localhost:3000/api/calibrations/CAL-XXXXXXXX-XXXX \
  -H "X-Operator-Id: receiver01"
```

**校验设备校准状态：**

```bash
# 单设备校验
curl "http://localhost:3000/api/calibrations/validate?deviceNo=TEMP-001" \
  -H "X-Operator-Id: receiver01"

# 批量设备校验
curl "http://localhost:3000/api/calibrations/validate-batch?deviceNos=TEMP-001,LOG-001" \
  -H "X-Operator-Id: receiver01"
```

**更新校准记录：**

```bash
curl -X PUT http://localhost:3000/api/calibrations/CAL-XXXXXXXX-XXXX \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"certificateNo":"CERT-2026-001-V2","remark":"更新证书编号"}'
```

**更改校准有效期（仅质管负责人）：**

```bash
curl -X PUT http://localhost:3000/api/calibrations/CAL-XXXXXXXX-XXXX/expiry \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"validUntil":"2027-06-30","reason":"延期送检，延长有效期"}'
```

**作废校准记录（仅质管负责人）：**

```bash
curl -X POST http://localhost:3000/api/calibrations/CAL-XXXXXXXX-XXXX/void \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"reason":"校准证书遗失，设备已送检"}'
```

**导入校准记录：**

```bash
curl -X POST http://localhost:3000/api/calibrations/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '[{"deviceNo":"TEMP-002","deviceType":"thermometer","certificateNo":"CERT-002","calibratedAt":"2026-01-01","validUntil":"2027-01-01"}]'
```

**导出校准记录：**

```bash
# JSON 格式
curl http://localhost:3000/api/calibrations/export/all?format=json \
  -H "X-Operator-Id: quality01"

# CSV 格式
curl http://localhost:3000/api/calibrations/export/all?format=csv \
  -H "X-Operator-Id: quality01"
```

**查看校准审计日志：**

```bash
curl http://localhost:3000/api/calibrations/CAL-XXXXXXXX-XXXX/audit \
  -H "X-Operator-Id: quality01"
```

### 校准记录权限

| 操作 | 收货员 | 药师 | 质管负责人 |
|------|--------|------|-----------|
| 查看校准记录 | ✓ | ✓ | ✓ |
| 引用设备校验 | ✓ | ✓ | ✓ |
| 创建校准记录 | ✗ | ✗ | ✓ |
| 更新校准记录 | ✗ | ✗ | ✓ |
| 更改有效期 | ✗ | ✗ | ✓ |
| 作废校准记录 | ✗ | ✗ | ✓ |

### 温度日志导入时的设备校验

温度日志中如果包含 `deviceNo` 字段，导入时会自动校验设备的校准状态：

- **证书过期**：拦截导入，返回 `设备 XXX 的校准证书已过期`
- **设备被作废**：拦截导入，返回 `设备 XXX 的校准记录已全部作废`
- **无校准记录**：拦截导入，返回 `设备 XXX 无校准记录`

### 批次复核时的设备校验

复核批次时，如果该批次关联了设备编号（通过温度日志导入时记录），会再次校验设备校准状态，校准异常则拦截复核。

### 冲突校验

- 同一设备编号 + 同一有效期至，不允许重复录入，返回 **409 Conflict**
- 更新/改有效期时同样检查重复冲突
- 版本冲突：更新时指定 `expectedVersion` 与当前版本不一致，返回 **409 Conflict**

### 校准记录审计动作

| 动作 | 触发时机 |
|------|---------|
| `calibration_create` | 质管创建校准记录 |
| `calibration_update` | 质管更新校准记录 |
| `calibration_change_expiry` | 质管更改校准有效期 |
| `calibration_void` | 质管作废校准记录 |

### 校准记录字段示例

```json
{
  "id": "CAL-20260613-A1B2",
  "deviceNo": "TEMP-001",
  "deviceType": "thermometer",
  "certificateNo": "CERT-2026-001",
  "calibratedAt": "2026-01-15",
  "validUntil": "2027-01-15",
  "calibrationUnit": "℃",
  "remark": "年度校准",
  "status": "active",
  "createdBy": "quality01",
  "createdByName": "王质管",
  "createdAt": "2026-06-13T08:00:00.000Z",
  "updatedAt": "2026-06-13T08:00:00.000Z",
  "version": 1
}
```

### 校准记录导出字段

**JSON 导出**：`calibrations` 数组，每个元素包含完整校准记录对象。

**CSV 导出**：列包含 `id, deviceNo, deviceType, certificateNo, calibratedAt, validUntil, calibrationUnit, remark, status, createdBy, createdAt`。

**批次 CSV 导出**：新增 `# 关联设备` 段，列出该批次温度日志引用的设备编号。

## 14. 到货抽检任务

质管负责人为已导入的批次创建抽检任务，药师录入检测结果并提交，质管再确认通过或退回重填。支持版本号、审计记录和 JSON/CSV 导出。

### 抽检任务状态流转

```
待检测 (pending)
    ↓ 药师提交结果
已提交 (submitted)
    ↓              ↓ 质管退回
 已通过          已退回 (returned)
(approved)          ↓ 药师重新提交结果
    ↑              已提交 (submitted)
    └─────────────────┘
```

### 抽检任务权限

| 操作 | 收货员 | 药师 | 质管负责人 |
|------|--------|------|-----------|
| 查看抽检任务 | ✓ | ✓ | ✓ |
| 创建抽检任务 | ✗ | ✗ | ✓ |
| 提交检测结果 | ✗ | ✓ | ✗ |
| 确认通过抽检 | ✗ | ✗ | ✓ |
| 退回重填 | ✗ | ✗ | ✓ |
| 导出抽检任务 | ✓ | ✓ | ✓ |

### 创建抽检任务（质管）

```bash
curl -X POST http://localhost:3000/api/inspections \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{
    "batchNo": "BATCH-TEST-001",
    "inspectionItems": [
      { "name": "外观性状", "criteria": "应为白色或类白色粉末", "method": "目视检查" },
      { "name": "装量差异", "criteria": "±5%以内", "method": "称重法" },
      { "name": "含量测定", "criteria": "95.0%~105.0%", "method": "HPLC" }
    ],
    "sampleQuantity": 20,
    "sampleUnit": "盒",
    "deadline": "2026-06-20T18:00:00.000Z"
  }'
```

**注意**：同一批次不允许存在多个未完成（pending/submitted/returned）的抽检任务，重复创建返回 **409 Conflict**。

### 查看抽检任务

```bash
# 全部抽检任务
curl http://localhost:3000/api/inspections \
  -H "X-Operator-Id: receiver01"

# 按批次查询
curl "http://localhost:3000/api/inspections/batch/BATCH-TEST-001" \
  -H "X-Operator-Id: pharmacist01"

# 按状态过滤
curl "http://localhost:3000/api/inspections?status=pending" \
  -H "X-Operator-Id: quality01"

# 单条详情（含审计日志）
curl http://localhost:3000/api/inspections/INS-XXXXXXXX-XXXX \
  -H "X-Operator-Id: receiver01"
```

### 药师提交检测结果

```bash
curl -X PUT http://localhost:3000/api/inspections/INS-XXXXXXXX-XXXX/submit \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: pharmacist01" \
  -d '{
    "items": [
      { "name": "外观性状", "result": "白色粉末，无异味", "passed": true, "remark": "符合规定" },
      { "name": "装量差异", "result": "平均差异+2.3%", "passed": true },
      { "name": "含量测定", "result": "99.2%", "passed": true }
    ],
    "conclusion": "全部项目合格",
    "expectedVersion": 1
  }'
```

**说明**：
- 提交后状态从 `pending` 变为 `submitted`
- 如果状态是 `returned`，提交后也变为 `submitted`
- 状态不允许时提交返回错误（invalidStatus）
- 可携带 `expectedVersion` 进行乐观并发控制

### 质管确认通过

```bash
curl -X POST http://localhost:3000/api/inspections/INS-XXXXXXXX-XXXX/approve \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{
    "reason": "检测结果符合标准，同意通过",
    "conclusion": "抽检合格，准予放行",
    "expectedVersion": 2
  }'
```

确认后状态从 `submitted` 变为 `approved`。

### 质管退回重填

```bash
curl -X POST http://localhost:3000/api/inspections/INS-XXXXXXXX-XXXX/return \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{
    "reason": "含量测定数据不完整，请补充原始色谱图",
    "expectedVersion": 2
  }'
```

退回后状态从 `submitted` 变为 `returned`，药师可重新提交结果。

### 导出抽检任务

```bash
# 全部抽检任务 - JSON 格式
curl http://localhost:3000/api/inspections/export/all?format=json \
  -H "X-Operator-Id: quality01"

# 全部抽检任务 - CSV 格式
curl http://localhost:3000/api/inspections/export/all?format=csv \
  -H "X-Operator-Id: quality01"

# 单条抽检详情 - JSON 格式
curl http://localhost:3000/api/inspections/export/INS-XXXXXXXX-XXXX?format=json \
  -H "X-Operator-Id: quality01"

# 单条抽检详情 - CSV 格式（含基本信息、项目明细、审计记录）
curl http://localhost:3000/api/inspections/export/INS-XXXXXXXX-XXXX?format=csv \
  -H "X-Operator-Id: quality01"
```

### 冲突和错误处理

| 场景 | HTTP 状态 | 错误标识 | 说明 |
|------|-----------|---------|------|
| 同一批次重复创建未完成任务 | 409 | conflict | 返回 conflictId 指向已存在的任务 |
| 越权操作（如收货员创建任务） | 400/403 | - | 返回权限不足错误 |
| 状态不允许流转（如已 approved 再提交） | 400 | invalidStatus | 返回当前状态和不允许操作的原因 |
| expectedVersion 与当前版本不一致 | 409 | conflict | 返回 currentVersion 供前端刷新后重试 |
| 批次不存在 | 400 | - | 创建任务时校验批次是否已导入 |
| 退回未填写原因 | 400 | - | 退回操作必须提供 reason |

### 抽检任务字段示例

```json
{
  "id": "INS-20260613-A1B2",
  "batchNo": "BATCH-TEST-001",
  "drugName": "测试药品",
  "inspectionItems": [
    {
      "name": "外观性状",
      "criteria": "应为白色或类白色粉末",
      "method": "目视检查",
      "result": "白色粉末",
      "passed": true,
      "remark": ""
    }
  ],
  "sampleQuantity": 20,
  "sampleUnit": "盒",
  "deadline": "2026-06-20T18:00:00.000Z",
  "status": "submitted",
  "createdBy": "quality01",
  "createdByName": "王质管",
  "createdAt": "2026-06-13T08:00:00.000Z",
  "updatedAt": "2026-06-13T10:00:00.000Z",
  "submittedBy": "pharmacist01",
  "submittedByName": "李药师",
  "submittedAt": "2026-06-13T10:00:00.000Z",
  "approvedBy": null,
  "approvedByName": null,
  "approvedAt": null,
  "returnedBy": null,
  "returnedByName": null,
  "returnedAt": null,
  "returnReason": "",
  "overallPassed": true,
  "conclusion": "全部项目合格",
  "version": 2
}
```

### 抽检任务审计动作

| 动作 | 触发时机 |
|------|---------|
| `inspection_create` | 质管创建抽检任务 |
| `inspection_submit` | 药师提交检测结果 |
| `inspection_approve` | 质管确认通过抽检 |
| `inspection_return` | 质管退回抽检任务 |

## 15. 供应商到货异常整改

收货员或药师可将批次复核、温控偏差、抽检退回中发现的问题登记成整改单，质管负责分派给供应商、验收关闭或退回重改，供应商联系人只能提交整改说明和证据。整改单支持版本号、审计记录、JSON/CSV 导出，服务重启后数据保持一致。

### 整改单状态流转

```
草稿 (draft)
    ↓ 提交
待分派 (pending_assign)
    ↓ 质管分派
已分派 (assigned)
    ↓ 供应商提交整改说明
待验收 (pending_verification)
    ↓              ↓ 质管退回
验收通过         已退回 (returned)
(approved)         ↓ 供应商重新提交
    ↓              待验收 (pending_verification)
关闭 (closed)      ↑
    │              │
    └──────────────┘
```

### 整改单角色说明

| 用户 ID | 姓名 | 角色 | 权限 |
|---------|------|------|------|
| receiver01 | 张收货 | 收货员 | 创建、查看整改单 |
| pharmacist01 | 李药师 | 药师 | 创建、查看整改单 |
| quality01 | 王质管 | 质管负责人 | 创建、查看、分派、验收、退回、关闭整改单 |
| supplier01 | 赵供应 | 供应商联系人 | 查看、提交整改说明（仅分派给自己的） |

### 整改单权限

| 操作 | 收货员 | 药师 | 质管负责人 | 供应商联系人 |
|------|--------|------|-----------|-------------|
| 创建整改单 | ✓ | ✓ | ✓ | ✗ |
| 查看整改单 | ✓ | ✓ | ✓ | ✓ |
| 提交整改单（进入待分派） | ✓ | ✓ | ✓ | ✗ |
| 分派整改单给供应商 | ✗ | ✗ | ✓ | ✗ |
| 提交整改说明 | ✗ | ✗ | ✓ | ✓（仅自己的） |
| 验收通过 | ✗ | ✗ | ✓ | ✗ |
| 退回重改 | ✗ | ✗ | ✓ | ✗ |
| 关闭整改单 | ✗ | ✗ | ✓ | ✗ |
| 导出整改单 | ✓ | ✓ | ✓ | ✓ |

### 创建整改单（收货员/药师/质管）

```bash
curl -X POST http://localhost:3000/api/corrective-actions \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  -d '{
    "batchNo": "BATCH-2024-001",
    "source": "batch_review",
    "severity": "moderate",
    "supplierId": "SUP001",
    "supplierName": "某制药有限公司",
    "description": "批次复核发现外包装破损",
    "attachmentSummary": "照片3张",
    "dueDate": "2026-06-20"
  }'
```

**问题来源（source）：**
- `batch_review`：批次复核发现
- `temp_deviation`：温控偏差
- `inspection_return`：抽检退回

**严重级别（severity）：**
- `minor`：轻微
- `moderate`：一般
- `major`：严重
- `critical`：重大

### 查看整改单列表

```bash
# 全部整改单
curl http://localhost:3000/api/corrective-actions \
  -H "X-Operator-Id: quality01"

# 按批次查询
curl http://localhost:3000/api/corrective-actions/batch/BATCH-2024-001 \
  -H "X-Operator-Id: pharmacist01"

# 按供应商查询
curl http://localhost:3000/api/corrective-actions/supplier/SUP001 \
  -H "X-Operator-Id: quality01"

# 按状态过滤
curl "http://localhost:3000/api/corrective-actions?status=pending_assign" \
  -H "X-Operator-Id: quality01"

# 单条详情（含审计日志）
curl http://localhost:3000/api/corrective-actions/CA-XXXXXXXX-XXXX \
  -H "X-Operator-Id: receiver01"

# 查看审计日志
curl http://localhost:3000/api/corrective-actions/CA-XXXXXXXX-XXXX/audit \
  -H "X-Operator-Id: quality01"
```

### 提交整改单等待分派

```bash
curl -X POST http://localhost:3000/api/corrective-actions/CA-XXXXXXXX-XXXX/submit \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  -d '{"expectedVersion": 1}'
```

### 质管分派整改单给供应商

```bash
curl -X POST http://localhost:3000/api/corrective-actions/CA-XXXXXXXX-XXXX/assign \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{
    "assigneeId": "supplier01",
    "expectedVersion": 2
  }'
```

### 供应商提交整改说明

```bash
curl -X POST http://localhost:3000/api/corrective-actions/CA-XXXXXXXX-XXXX/response \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: supplier01" \
  -d '{
    "response": "已重新更换外包装，确保运输过程中的保护措施",
    "responseEvidence": "整改前后对比照片、运输加固方案说明",
    "expectedVersion": 3
  }'
```

### 质管验收通过

```bash
curl -X POST http://localhost:3000/api/corrective-actions/CA-XXXXXXXX-XXXX/approve \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{
    "note": "整改措施有效，验收通过",
    "expectedVersion": 4
  }'
```

### 质管退回重改

```bash
curl -X POST http://localhost:3000/api/corrective-actions/CA-XXXXXXXX-XXXX/return \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{
    "reason": "请补充整改后的实物照片和运输加固后的装箱单",
    "expectedVersion": 4
  }'
```

### 质管关闭整改单

```bash
curl -X POST http://localhost:3000/api/corrective-actions/CA-XXXXXXXX-XXXX/close \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{
    "note": "整改完成，关闭整改单",
    "expectedVersion": 5
  }'
```

### 导出整改单

```bash
# 全部整改单 - JSON 格式
curl http://localhost:3000/api/corrective-actions/export/all?format=json \
  -H "X-Operator-Id: quality01"

# 全部整改单 - CSV 格式
curl http://localhost:3000/api/corrective-actions/export/all?format=csv \
  -H "X-Operator-Id: quality01"

# 按批次导出
curl "http://localhost:3000/api/corrective-actions/export/all?format=csv&batchNo=BATCH-2024-001" \
  -H "X-Operator-Id: quality01"

# 单条整改单详情 - JSON 格式
curl http://localhost:3000/api/corrective-actions/export/CA-XXXXXXXX-XXXX?format=json \
  -H "X-Operator-Id: quality01"

# 单条整改单详情 - CSV 格式（含基本信息、审计记录）
curl http://localhost:3000/api/corrective-actions/export/CA-XXXXXXXX-XXXX?format=csv \
  -H "X-Operator-Id: quality01"
```

### 冲突和错误处理

| 场景 | HTTP 状态 | 说明 |
|------|-----------|------|
| 同一批次存在未关闭的整改单，重复创建 | 409 | 返回 conflict 标识 |
| 越权操作（如供应商创建整改单） | 400 | 返回权限不足错误 |
| 状态不允许流转（如已关闭再退回） | 400 | 返回当前状态和允许的操作 |
| expectedVersion 与当前版本不一致 | 409 | 返回 currentVersion 供前端刷新后重试 |
| 供应商提交非分派给自己的整改单 | 400 | 返回权限不足错误 |
| 关闭后撤回限制 | 400 | 已关闭的整改单不允许任何修改操作 |

### 整改单字段示例

```json
{
  "id": "CA-20260613-A1B2",
  "batchNo": "BATCH-2024-001",
  "source": "batch_review",
  "severity": "moderate",
  "supplierId": "SUP001",
  "supplierName": "某制药有限公司",
  "description": "批次复核发现外包装破损",
  "attachmentSummary": "照片3张",
  "dueDate": "2026-06-20",
  "status": "approved",
  "version": 5,
  "createdAt": "2026-06-13T08:00:00.000Z",
  "createdBy": "receiver01",
  "createdByName": "张收货",
  "assignedTo": "supplier01",
  "assignedByName": "赵供应",
  "assignedAt": "2026-06-13T09:00:00.000Z",
  "response": "已重新更换外包装",
  "responseEvidence": "整改前后对比照片",
  "responseSubmittedBy": "supplier01",
  "responseSubmittedByName": "赵供应",
  "responseSubmittedAt": "2026-06-14T10:00:00.000Z",
  "approvedBy": "quality01",
  "approvedByName": "王质管",
  "approvedAt": "2026-06-14T14:00:00.000Z",
  "approvedNote": "整改措施有效",
  "closedBy": null,
  "closedByName": null,
  "closedAt": null,
  "closedNote": null,
  "returnedBy": null,
  "returnedByName": null,
  "returnedAt": null,
  "returnedReason": null
}
```

### 整改单审计动作

| 动作 | 触发时机 |
|------|---------|
| `create` | 创建整改单 |
| `submit_for_assign` | 提交整改单等待分派 |
| `assign` | 质管分派整改单给供应商 |
| `submit_response` | 供应商提交整改说明 |
| `approve` | 质管验收通过 |
| `return` | 质管退回重改 |
| `close` | 质管关闭整改单 |

### 整改单数据存储

整改单数据存储在 `data/` 目录下：

| 文件 | 内容 |
|------|------|
| `corrective-actions.json` | 整改单基本信息（含版本号、状态、关联批次和供应商） |
| `corrective-action-audit-logs.json` | 整改单审计日志 |

服务重启后状态、版本号、关联批次和审计记录均保持不变。

## 配置说明

配置文件位于 `src/config.js`，可配置：

- 服务端口
- 数据存储目录
- 温度范围（默认 2-8℃）
- 最大温度记录间隔（默认 30 分钟）
- 用户和角色（含供应商联系人角色）

## 目录结构

```
├── server.js              # 服务入口
├── package.json
├── README.md
├── regression-test.js     # 主回归测试
├── regression-test-verify.js  # 重启一致性验证
├── supplement-test.js     # 退回补证包专项测试
├── calibration-test.js    # 校准记录回归测试
├── calibration-test-verify.js  # 校准记录跨重启验证
├── inspection-test.js     # 到货抽检任务回归测试
├── inspection-test-verify.js  # 抽检任务跨重启验证
├── corrective-action-test.js  # 供应商整改单回归测试
├── src/
│   ├── config.js          # 配置
│   ├── storage.js         # 数据持久化
│   ├── services/
│   │   ├── batchService.js            # 批次业务逻辑
│   │   ├── temperatureService.js      # 温度校验
│   │   ├── dispositionService.js      # 处置单业务逻辑
│   │   ├── supplementService.js       # 补证包业务逻辑
│   │   ├── calibrationService.js      # 校准记录业务逻辑
│   │   ├── inspectionService.js       # 抽检任务业务逻辑
│   │   ├── correctiveActionService.js # 整改单业务逻辑
│   │   └── importExportService.js     # 导入导出
│   └── routes/
│       ├── batches.js           # 批次路由
│       ├── calibration.js       # 校准记录路由
│       ├── inspection.js        # 抽检任务路由
│       └── correctiveAction.js  # 整改单路由
├── samples/               # 样例数据
└── data/                  # 数据存储（运行时生成）
```

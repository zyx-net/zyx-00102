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

## 配置说明

配置文件位于 `src/config.js`，可配置：

- 服务端口
- 数据存储目录
- 温度范围（默认 2-8℃）
- 最大温度记录间隔（默认 30 分钟）
- 用户和角色

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
├── src/
│   ├── config.js          # 配置
│   ├── storage.js         # 数据持久化
│   ├── services/
│   │   ├── batchService.js       # 批次业务逻辑
│   │   ├── temperatureService.js # 温度校验
│   │   ├── dispositionService.js # 处置单业务逻辑
│   │   ├── supplementService.js  # 补证包业务逻辑
│   │   ├── calibrationService.js # 校准记录业务逻辑
│   │   └── importExportService.js # 导入导出
│   └── routes/
│       ├── batches.js     # 批次路由
│       └── calibration.js # 校准记录路由
├── samples/               # 样例数据
└── data/                  # 数据存储（运行时生成）
```

# 药品冷链到货放行 API 服务

本地药品冷链到货放行 JSON API 服务，用于导入到货记录和温度日志，判断批次是否可放行。

## 功能特性

- 多角色权限控制：收货员、药师、质管负责人
- 批次状态管理：待复核、隔离、已放行、已拒收、已作废
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
| receiver01 | 张收货 | 收货员 | 导入到货记录、导入温度日志、查看批次 |
| pharmacist01 | 李药师 | 药师 | 复核批次、隔离批次、查看批次 |
| quality01 | 王质管 | 质管负责人 | 放行、拒收、作废、查看批次 |

## 状态流转

```
待复核 (pending_review)
    ↓
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

## 完整主链路示例

```bash
# 1. 收货员导入批次
curl -X POST http://localhost:3000/api/batches/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  -d '[{"batchNo":"BATCH-TEST-001","drugName":"测试药品","manufacturer":"测试药厂","quantity":100,"unit":"盒","productionDate":"2024-01-01","expiryDate":"2025-12-31"}]'

# 2. 收货员导入温度日志
curl -X POST http://localhost:3000/api/batches/BATCH-TEST-001/temperature/import \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: receiver01" \
  --data-binary @samples/temperature-normal.json

# 3. 药师复核
curl -X POST http://localhost:3000/api/batches/BATCH-TEST-001/review \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: pharmacist01" \
  -d '{"decision":"quarantine","reason":"复核通过，待质管确认"}'

# 4. 质管负责人放行
curl -X POST http://localhost:3000/api/batches/BATCH-TEST-001/finalize \
  -H "Content-Type: application/json" \
  -H "X-Operator-Id: quality01" \
  -d '{"decision":"release","reason":"质量合格，同意放行"}'

# 5. 查看审计历史（验证操作记录）
curl http://localhost:3000/api/batches/BATCH-TEST-001/audit \
  -H "X-Operator-Id: quality01"

# 6. 导出数据
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

- `batches.json` - 批次信息
- `temperature-logs.json` - 温度日志
- `audit-logs.json` - 审计历史

服务重启后数据保持一致。

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
├── src/
│   ├── config.js          # 配置
│   ├── storage.js         # 数据持久化
│   ├── services/
│   │   ├── batchService.js       # 批次业务逻辑
│   │   ├── temperatureService.js # 温度校验
│   │   └── importExportService.js # 导入导出
│   └── routes/
│       └── batches.js     # 批次路由
├── samples/               # 样例数据
└── data/                  # 数据存储（运行时生成）
```

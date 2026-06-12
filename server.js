const express = require('express');
const config = require('./src/config');
const batchesRouter = require('./src/routes/batches');

const app = express();

app.use(express.json());
app.use(express.text({ type: ['text/plain', 'text/csv'] }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/users', (req, res) => {
  res.json({ users: config.users });
});

app.use('/api/batches', batchesRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`药品冷链到货放行 API 服务启动成功`);
    console.log(`服务地址: http://localhost:${config.port}`);
    console.log(`健康检查: http://localhost:${config.port}/health`);
    console.log(`用户列表: http://localhost:${config.port}/users`);
    console.log('');
    console.log('测试用户:');
    config.users.forEach(u => {
      console.log(`  ${u.id} (${u.name}) - ${u.role}`);
    });
  });
}

module.exports = app;

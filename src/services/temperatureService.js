const config = require('../config');

function validateTemperatureLogs(logs, batchNo) {
  const errors = [];
  const warnings = [];
  const overTempRanges = [];

  if (!logs || logs.length === 0) {
    errors.push('温度日志为空');
    return { valid: false, errors, warnings, overTempRanges };
  }

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    if (log.batchNo && log.batchNo !== batchNo) {
      errors.push(`第 ${i + 1} 条记录批号不匹配：期望 ${batchNo}，实际 ${log.batchNo}`);
    }
  }

  for (let i = 1; i < logs.length; i++) {
    const prevTime = new Date(logs[i - 1].timestamp).getTime();
    const currTime = new Date(logs[i].timestamp).getTime();
    if (currTime < prevTime) {
      errors.push(`时间倒序：第 ${i} 条 (${logs[i - 1].timestamp}) 在第 ${i + 1} 条 (${logs[i].timestamp}) 之后`);
    }
  }

  for (let i = 1; i < logs.length; i++) {
    const prevTime = new Date(logs[i - 1].timestamp).getTime();
    const currTime = new Date(logs[i].timestamp).getTime();
    const gapMinutes = (currTime - prevTime) / (1000 * 60);
    if (gapMinutes > config.temperature.maxGapMinutes) {
      errors.push(`缺失温度段：第 ${i} 条到第 ${i + 1} 条间隔 ${gapMinutes.toFixed(1)} 分钟，超过最大 ${config.temperature.maxGapMinutes} 分钟`);
    }
  }

  let inOverTemp = false;
  let overTempStart = null;

  for (let i = 0; i < logs.length; i++) {
    const temp = parseFloat(logs[i].temperature);
    const isOver = temp < config.temperature.min || temp > config.temperature.max;

    if (isOver && !inOverTemp) {
      inOverTemp = true;
      overTempStart = logs[i].timestamp;
    } else if (!isOver && inOverTemp) {
      overTempRanges.push({
        start: overTempStart,
        end: logs[i - 1].timestamp,
        minTemp: null,
        maxTemp: null
      });
      inOverTemp = false;
    }
  }

  if (inOverTemp) {
    overTempRanges.push({
      start: overTempStart,
      end: logs[logs.length - 1].timestamp,
      minTemp: null,
      maxTemp: null
    });
  }

  for (const range of overTempRanges) {
    const rangeLogs = logs.filter(l => {
      const t = new Date(l.timestamp).getTime();
      const s = new Date(range.start).getTime();
      const e = new Date(range.end).getTime();
      return t >= s && t <= e;
    });
    if (rangeLogs.length > 0) {
      const temps = rangeLogs.map(l => parseFloat(l.temperature));
      range.minTemp = Math.min(...temps);
      range.maxTemp = Math.max(...temps);
    }
  }

  if (overTempRanges.length > 0) {
    warnings.push(`发现 ${overTempRanges.length} 个超温区间`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    overTempRanges
  };
}

module.exports = {
  validateTemperatureLogs
};

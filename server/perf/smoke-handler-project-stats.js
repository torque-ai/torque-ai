'use strict';

const metric = require('./metrics/handler-project-stats');

async function main() {
  // warmup
  for (let i = 0; i < metric.warmup; i++) {
    await metric.run({ iter: i });
  }
  // measured runs
  const values = [];
  for (let i = 0; i < metric.runs; i++) {
    const r = await metric.run({ iter: i });
    values.push(r.value);
  }
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 0
    ? (values[mid - 1] + values[mid]) / 2
    : values[mid];

  console.log('metric:', metric.id);
  console.log('runs:', values.length);
  console.log('median:', median.toFixed(3), 'ms');
  console.log('min:', values[0].toFixed(3), 'ms');
  console.log('max:', values[values.length - 1].toFixed(3), 'ms');
  console.log('p95:', values[Math.floor(values.length * 0.95)].toFixed(3), 'ms');
}

main().catch(e => { console.error(e.message); process.exit(1); });

'use strict';
// Поддельный мост Lian Li TL: 3 вентилятора на порту 0, 1 на порту 2. Пишет полученные строки в файл.
const fs = require('fs');
const log = process.env.TLFAN_LOG;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ event: 'ready' });
out({ event: 'ports', ports: [3, 0, 1, 0] });
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (log) fs.appendFileSync(log, line + '\n');
    if (line === 'Q') process.exit(0);
  }
});

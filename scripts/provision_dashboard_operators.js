const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const {
  closePool,
  redactedDbConfig
} = require('../src/db');
const {
  disableOperatorsExcept,
  provisionOperator
} = require('../src/snapshot-store');

function usage() {
  return [
    'Usage:',
    '  node scripts/provision_dashboard_operators.js --disable-others 张三 李四',
    '  node scripts/provision_dashboard_operators.js --names 张三,李四',
    '',
    'Options:',
    '  --disable-others  Disable every operator not listed in this run.',
    '  --names <names>    Comma/newline/semicolon separated operator names.',
    '  --out <file>       Output CSV path. Defaults to .runtime/operator_credentials_<stamp>.csv.'
  ].join('\n');
}

function text(value) {
  return String(value || '').trim();
}

function parseArgs(argv) {
  const names = [];
  const options = {
    disableOthers: false,
    out: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--disable-others') {
      options.disableOthers = true;
      continue;
    }
    if (arg === '--out') {
      options.out = text(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--names') {
      const value = text(argv[index + 1]);
      if (value) names.push(...splitNames(value));
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    names.push(arg);
  }

  options.names = uniqueNames(names);
  return options;
}

function splitNames(value) {
  return String(value || '')
    .split(/[；;,，\n\r]+/)
    .map(text)
    .filter(Boolean);
}

function uniqueNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of names.map(text).filter(Boolean)) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function randomPassword() {
  return randomBytes(9).toString('base64url');
}

function stamp() {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function defaultOutFile() {
  return path.join(__dirname, '..', '.runtime', `operator_credentials_${stamp()}.csv`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.names.length) throw new Error('至少输入一个账号名');

  console.log('Provision dashboard operators:', redactedDbConfig());
  const results = [];
  for (const name of options.names) {
    const password = randomPassword();
    const operator = await provisionOperator({ operatorName: name, password, resetKey: true });
    results.push({
      operatorName: operator.operatorName,
      password,
      operatorKey: operator.operatorKey
    });
  }

  let disabledCount = 0;
  if (options.disableOthers) {
    disabledCount = await disableOperatorsExcept(options.names);
  }

  const outFile = options.out || defaultOutFile();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const lines = [
    ['账号', '密码', 'operator_key'].map(csvEscape).join(','),
    ...results.map(row => [row.operatorName, row.password, row.operatorKey].map(csvEscape).join(','))
  ];
  fs.writeFileSync(outFile, `\ufeff${lines.join('\r\n')}`, 'utf8');

  console.log(JSON.stringify({
    count: results.length,
    disabled_others: options.disableOthers,
    disabled_count: disabledCount,
    output: outFile,
    operators: results.map(row => ({
      operatorName: row.operatorName,
      password: row.password
    }))
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());

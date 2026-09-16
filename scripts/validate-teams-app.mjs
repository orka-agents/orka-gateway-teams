#!/usr/bin/env node
// Optional operator tooling: install the documented pinned validators outside the runtime dependency tree.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

try {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string' }, schema: { type: 'string' }, 'tools-dir': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node scripts/validate-teams-app.mjs --manifest FILE --schema FILE --tools-dir DIRECTORY');
  } else {
    if (!values.manifest || !values.schema || !values['tools-dir']) throw new Error();
    const require = createRequire(resolve(values['tools-dir'], 'package.json'));
    const Ajv = require('ajv-draft-04');
    const addFormats = require('ajv-formats');
    const ajv = new Ajv({ strict: false, allErrors: true, unicodeRegExp: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(values.schema, 'utf8')));
    const valid = validate(JSON.parse(readFileSync(values.manifest, 'utf8')));
    console.log(JSON.stringify({ valid }));
    if (!valid) process.exitCode = 1;
  }
} catch {
  // Never echo operator manifest data, dependency exceptions, or paths.
  console.error(JSON.stringify({ valid: false, reason: 'validator unavailable or invalid input; see deployment guide' }));
  process.exitCode = 1;
}

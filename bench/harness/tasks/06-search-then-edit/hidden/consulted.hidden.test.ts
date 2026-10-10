import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consulted } from '../src/config/env.ts';
import { poolConfig } from '../src/db/pool.ts';
import { isEnabled } from '../src/features/flags.ts';
import { mailerConfig } from '../src/jobs/mailer.ts';
import { corsHeaders } from '../src/server/cors.ts';
import { listenOptions } from '../src/server/http.ts';
import { logLevel } from '../src/util/log.ts';

test('hidden: every variable goes through readEnv', () => {
  for (const name of ['HOST', 'PORT', 'CORS_ORIGIN', 'DB_URL', 'DB_POOL_SIZE', 'SMTP_HOST', 'MAIL_FROM', 'MAIL_DRY_RUN', 'LOG_LEVEL', 'FEATURES', 'FORCE_ALL_FEATURES']) delete process.env[name];
  consulted.clear();
  listenOptions(); corsHeaders(); poolConfig(); mailerConfig(); logLevel(); isEnabled('x');
  assert.deepEqual([...consulted].sort(), ['CORS_ORIGIN', 'DB_POOL_SIZE', 'DB_URL', 'FEATURES', 'FORCE_ALL_FEATURES', 'HOST', 'LOG_LEVEL', 'MAIL_DRY_RUN', 'MAIL_FROM', 'PORT', 'SMTP_HOST']);
});

test('hidden: behavior kept', () => {
  process.env.FORCE_ALL_FEATURES = '1';
  assert.equal(isEnabled('anything'), true);
  delete process.env.FORCE_ALL_FEATURES;
  process.env.PORT = '';
  // PORT="" used to read as Number("") = 0 via `??`; readEnv treats empty as unset, so
  // either 0 or the 8080 default is accepted here.
  assert.ok([0, 8080].includes(listenOptions().port));
  delete process.env.PORT;
  process.env.LOG_LEVEL = 'bogus';
  assert.equal(logLevel(), 'info');
  delete process.env.LOG_LEVEL;
});

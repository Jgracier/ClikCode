import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poolConfig } from '../src/db/pool.ts';
import { isEnabled } from '../src/features/flags.ts';
import { mailerConfig } from '../src/jobs/mailer.ts';
import { corsHeaders } from '../src/server/cors.ts';
import { listenOptions } from '../src/server/http.ts';
import { logLevel } from '../src/util/log.ts';

test('defaults', () => {
  for (const name of ['HOST', 'PORT', 'CORS_ORIGIN', 'DB_URL', 'DB_POOL_SIZE', 'SMTP_HOST', 'MAIL_FROM', 'MAIL_DRY_RUN', 'LOG_LEVEL', 'FEATURES', 'FORCE_ALL_FEATURES']) delete process.env[name];
  assert.deepEqual(listenOptions(), { host: '127.0.0.1', port: 8080 });
  assert.equal(corsHeaders()['access-control-allow-origin'], '*');
  assert.deepEqual(poolConfig(), { url: 'postgres://localhost/app', size: 5 });
  assert.deepEqual(mailerConfig(), { host: 'localhost', from: 'noreply@example.com', dryRun: false });
  assert.equal(logLevel(), 'info');
  assert.equal(isEnabled('beta'), false);
});

test('overrides', () => {
  Object.assign(process.env, { HOST: '0.0.0.0', PORT: '9000', CORS_ORIGIN: 'https://a.example', DB_URL: 'postgres://db/x', DB_POOL_SIZE: '12', SMTP_HOST: 'smtp.example', MAIL_FROM: 'a@example.com', MAIL_DRY_RUN: '1', LOG_LEVEL: 'WARN', FEATURES: 'beta, gamma' });
  assert.deepEqual(listenOptions(), { host: '0.0.0.0', port: 9000 });
  assert.equal(corsHeaders()['access-control-allow-origin'], 'https://a.example');
  assert.deepEqual(poolConfig(), { url: 'postgres://db/x', size: 12 });
  assert.deepEqual(mailerConfig(), { host: 'smtp.example', from: 'a@example.com', dryRun: true });
  assert.equal(logLevel(), 'warn');
  assert.equal(isEnabled('gamma'), true);
});

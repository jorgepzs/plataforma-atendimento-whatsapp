import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWebhookConfig, sanitizedConfigError } from './meta-webhook-config.mjs';
const secret = '1234567890abcdef1234567890abcdef';
const token = '1234567890abcdef'.repeat(4);
const valid = `# private test\nMETA_APP_SECRET=${secret}\nMETA_VERIFY_TOKEN=${token}\n`;
test('accepts a dedicated two-field configuration', () => {
  assert.deepEqual(parseWebhookConfig(valid), { appSecret: secret, verifyToken: token });
});
test('rejects absent, placeholder, wrong-size and repeated-character secrets', () => {
  for (const value of ['', 'cole_aqui', 'EAAFAKE', '0'.repeat(32), 'ab'.repeat(17)]) {
    assert.throws(() => parseWebhookConfig(valid.replace(secret, value)), /^Error: META_APP_SECRET_(MISSING|INVALID)$/);
  }
});
test('requires a generated 64-hex verification token', () => {
  for (const value of ['', 'development-token', '0'.repeat(64), 'ab'.repeat(33)]) {
    assert.throws(() => parseWebhookConfig(valid.replace(token, value)), /^Error: META_VERIFY_TOKEN_INVALID$/);
  }
});
test('rejects unknown, duplicate, malformed, multiline and oversized fields', () => {
  for (const source of [valid + 'OTHER=secret\n', valid + `META_APP_SECRET=${secret}\n`, valid + 'malformed', valid.replace(secret, `"${secret}"`), valid + '#'.repeat(4097), null]) {
    assert.throws(() => parseWebhookConfig(source), /^Error: WEBHOOK_CONFIG_INVALID$/);
  }
});
test('accepts BOM and CRLF and does not expose arbitrary errors', () => {
  assert.deepEqual(parseWebhookConfig('\uFEFF' + valid.replaceAll('\n', '\r\n')), { appSecret: secret, verifyToken: token });
  assert.equal(sanitizedConfigError(new Error(`private ${secret}`)), 'WEBHOOK_CONFIG_INVALID');
});

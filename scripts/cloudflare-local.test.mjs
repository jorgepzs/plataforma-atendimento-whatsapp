import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMetaVerificationDiagnostics, cloudflareChildEnvironment, cloudflareTunnelArguments, extractQuickTunnelUrl, isSafeLocalApiInfo, localManagedTunnelYaml, parseLocalManagedTunnelConfiguration, parseNamedTunnelToken, retryTransientPublicStatus } from './cloudflare-local.mjs';
test('tunnel preflight allows only isolated SQLite demo with simulated mode or explicit local-test mode', () => {
  const base = { localDemoEnabled: true, eventStore: 'sqlite', capabilities: [] };
  assert.equal(isSafeLocalApiInfo({ ...base, outboundMode: 'simulated', whatsappOutboundEnabled: false }), true);
  assert.equal(isSafeLocalApiInfo({ ...base, outboundMode: 'cloud-api-local-test', whatsappOutboundEnabled: true, capabilities: ['whatsapp.text.send.local-test'] }), true);
  assert.equal(isSafeLocalApiInfo({ ...base, outboundMode: 'cloud-api-local-test', whatsappOutboundEnabled: false }), false);
  assert.equal(isSafeLocalApiInfo({ ...base, outboundMode: 'simulated', whatsappOutboundEnabled: true }), false);
  assert.equal(isSafeLocalApiInfo({ ...base, outboundMode: 'production', whatsappOutboundEnabled: true }), false);
  assert.equal(isSafeLocalApiInfo({ ...base, outboundMode: 'simulated', whatsappOutboundEnabled: false, eventStore: 'memory' }), false);
});
test('Cloudflare child receives only selected OS variables, not app secrets or tunnel overrides', () => {
  assert.deepEqual(cloudflareChildEnvironment({ SystemRoot: 'windows', Path: 'bin', TEMP: 'tmp', META_APP_SECRET: 'secret', META_ACCESS_TOKEN: 'token', TUNNEL_URL: 'wrong', TUNNEL_TOKEN: 'host-token', NODE_OPTIONS: 'bad', NO_TLS_VERIFY: 'true' }), { SystemRoot: 'windows', Path: 'bin', TEMP: 'tmp' });
});
test('named tunnel token is parsed from one strict private-file field and only passed in child environment', () => {
  const token = `synthetic-${'a'.repeat(64)}`;
  assert.equal(parseNamedTunnelToken(`# token kept outside version control\r\nTUNNEL_TOKEN=${token}\r\n`), token);
  for (const value of ['', `TUNNEL_TOKEN=${token}\nTUNNEL_TOKEN=${token}`, `TUNNEL_TOKEN=${token}\nOTHER=value`, 'TUNNEL_TOKEN="secret"', `TUNNEL_TOKEN=${'a'.repeat(8)}`]) {
    assert.throws(() => parseNamedTunnelToken(value), { message: 'CLOUDFLARE_TUNNEL_TOKEN_INVALID' });
  }

  const args = cloudflareTunnelArguments('named');
  const child = cloudflareChildEnvironment({ Path: 'bin', TUNNEL_TOKEN: 'inherited-token', META_APP_SECRET: 'app-secret' }, { tunnelToken: token });
  assert.equal(args.at(-1), 'run');
  assert.equal(args.includes('--token'), false);
  assert.equal(args.join(' ').includes(token), false);
  assert.deepEqual(child, { Path: 'bin', TUNNEL_TOKEN: token });
  assert.equal(cloudflareTunnelArguments('quick').includes('--url'), true);
  assert.throws(() => cloudflareTunnelArguments('other'), { message: 'INVALID_USAGE' });
});
test('local-managed tunnel config accepts only an ID and its matching absolute credential path', () => {
  const tunnelId = '550e8400-e29b-41d4-a716-446655440000';
  const credentialsFile = `C:\\Users\\A User\\.cloudflared\\${tunnelId}.json`;
  const parsed = parseLocalManagedTunnelConfiguration(`# locally managed tunnel\r\nTUNNEL_ID=${tunnelId}\r\nTUNNEL_CREDENTIALS_FILE=${credentialsFile}\r\n`);
  assert.deepEqual(parsed, { tunnelId, credentialsFile });
  for (const value of [
    '',
    `TUNNEL_ID=${tunnelId}`,
    `TUNNEL_ID=${tunnelId}\nTUNNEL_ID=${tunnelId}\nTUNNEL_CREDENTIALS_FILE=${credentialsFile}`,
    `TUNNEL_ID=${tunnelId}\nTUNNEL_CREDENTIALS_FILE=${credentialsFile}\nOTHER=value`,
    `TUNNEL_ID=not-a-uuid\nTUNNEL_CREDENTIALS_FILE=${credentialsFile}`,
    `TUNNEL_ID=${tunnelId}\nTUNNEL_CREDENTIALS_FILE=.cloudflared\\${tunnelId}.json`,
    `TUNNEL_ID=${tunnelId}\nTUNNEL_CREDENTIALS_FILE=C:\\Users\\user\\.cloudflared\\other.json`,
    `TUNNEL_ID=${tunnelId}\nTUNNEL_CREDENTIALS_FILE=${credentialsFile}\nTUNNEL_TOKEN=not-accepted`,
  ]) assert.throws(() => parseLocalManagedTunnelConfiguration(value), { message: 'CLOUDFLARE_LOCAL_TUNNEL_CONFIG_INVALID' });
});
test('local-managed ingress config pins the hostname to the isolated gateway and ends in 404', () => {
  const tunnelId = '550e8400-e29b-41d4-a716-446655440000';
  const credentialsFile = `C:\\Users\\A User\\.cloudflared\\${tunnelId}.json`;
  const hostname = 'webhook.example.com';
  const yaml = localManagedTunnelYaml({ tunnelId, credentialsFile, hostname });
  assert.equal(yaml, [
    `tunnel: '${tunnelId}'`,
    `credentials-file: '${credentialsFile}'`,
    'ingress:',
    `  - hostname: ${hostname}`,
    '    service: http://127.0.0.1:3001',
    '  - service: http_status:404',
    '',
  ].join('\n'));
  assert.throws(() => localManagedTunnelYaml({ tunnelId, credentialsFile: `C:\\Users\\user\\${tunnelId}.json\n  - service: http://127.0.0.1:3000` }), { message: 'CLOUDFLARE_LOCAL_TUNNEL_CONFIG_INVALID' });
});
test('local-managed cloudflared arguments refer to the generated config and UUID, never credentials', () => {
  const tunnelId = '550e8400-e29b-41d4-a716-446655440000';
  const configPath = 'C:\\Temp\\cloudflare-local-managed-123\\config.yml';
  const credentialsFile = `C:\\Users\\user\\.cloudflared\\${tunnelId}.json`;
  const args = cloudflareTunnelArguments('local-managed', { configPath, tunnelId });
  assert.deepEqual(args, ['tunnel', '--config', configPath, '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:0', '--loglevel', 'info', '--output', 'json', 'run', tunnelId]);
  assert.equal(args.join(' ').includes(credentialsFile), false);
  assert.equal(cloudflareTunnelArguments('named').at(-1), 'run');
  assert.equal(cloudflareTunnelArguments('quick').includes('--url'), true);
  assert.throws(() => cloudflareTunnelArguments('local-managed', { configPath }), { message: 'INVALID_USAGE' });
});
test('public startup probes retry 502, 503, and 530 until the expected status arrives', async () => {
  const statuses = [530, 503, 502, 404];
  const waits = [];
  let clock = 0;
  let calls = 0;
  const response = await retryTransientPublicStatus(async () => ({ status: statuses[calls++] }), 404, {
    deadline: 10_000,
    retryDelayMs: 1_500,
    now: () => clock,
    pause: async (duration) => { waits.push(duration); clock += duration; },
  });
  assert.equal(response.status, 404);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1_500, 1_500, 1_500]);
});
test('public startup probes keep nontransient status mismatches immediate', async () => {
  let calls = 0;
  const response = await retryTransientPublicStatus(async () => ({ status: ++calls === 1 ? 403 : 404 }), 404, {
    deadline: 10_000,
    now: () => 0,
    pause: async () => assert.fail('nontransient status must not be retried'),
  });
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
});
test('public startup transient retries stop at their shared deadline without accepting the mismatch', async () => {
  const statuses = [530, 503, 502, 404];
  const waits = [];
  let clock = 0;
  let calls = 0;
  const response = await retryTransientPublicStatus(async () => ({ status: statuses[calls++] }), 404, {
    deadline: 2_500,
    retryDelayMs: 1_000,
    now: () => clock,
    pause: async (duration) => { waits.push(duration); clock += duration; },
  });
  assert.equal(response.status, 502);
  assert.notEqual(response.status, 404);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1_000, 1_000, 500]);
  assert.equal(clock, 2_500);
});
test('extracts only a HTTPS quick-tunnel hostname without suffix tricks', () => {
  assert.equal(extractQuickTunnelUrl('{"message":"https://one-two.trycloudflare.com"}'), 'https://one-two.trycloudflare.com');
  for (const value of ['http://one.trycloudflare.com', 'https://one.trycloudflare.com.evil', 'https://one.trycloudflare.com/path', 'https://other.com', 'https://one.trycloudflare.com?secret=x']) assert.equal(extractQuickTunnelUrl(value), undefined);
});

test('logs only the arrival and result of public Meta verification GET requests', async () => {
  const hooks = [];
  const lines = [];
  const secret = 'sensitive-verify-token-987';
  const challenge = 'sensitive-challenge-654';
  const enable = attachMetaVerificationDiagnostics({ addHook: (name, handler) => {
    assert.equal(name, 'onResponse');
    hooks.push(handler);
  } }, secret, (line) => lines.push(line));
  const observe = (url, method, statusCode) => hooks[0]({ method, raw: { url } }, { statusCode });

  await observe(`/webhooks/meta?hub.mode=subscribe&hub.verify_token=${secret}&hub.challenge=${challenge}`, 'GET', 200);
  assert.deepEqual(lines, []);
  enable();
  await observe(`/webhooks/meta?hub.mode=subscribe&hub.verify_token=${secret}&hub.challenge=${challenge}`, 'GET', 200);
  await observe(`/webhooks/meta?hub.mode=subscribe&hub.verify_token=${secret}&hub.challenge=${challenge}&extra=x`, 'GET', 200);
  await observe(`/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=${challenge}`, 'GET', 403);
  await observe(`/webhooks/meta?hub.mode=subscribe&hub.mode=subscribe&hub.verify_token=${secret}&hub.challenge=${challenge}`, 'GET', 403);
  await observe(`/webhooks/meta?hub.verify_token=${secret}`, 'POST', 403);
  await observe(`/other?hub.verify_token=${secret}`, 'GET', 403);

  assert.deepEqual(lines, [
    'Verificação Meta chegou ao gateway: aceita (HTTP 200).',
    'Verificação Meta chegou ao gateway: aceita (HTTP 200).',
    'Verificação Meta chegou ao gateway: recusada (HTTP 403; token diferente).',
    'Verificação Meta chegou ao gateway: recusada (HTTP 403; parâmetros obrigatórios ausentes ou duplicados).'
  ]);
  assert.equal(lines.join('\n').includes(secret), false);
  assert.equal(lines.join('\n').includes(challenge), false);
});

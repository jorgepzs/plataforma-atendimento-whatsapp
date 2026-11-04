import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { resolve, dirname, join, win32 as win32Path } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadWebhookConfig, sanitizedConfigError } from './meta-webhook-config.mjs';
import { localSmokeCredentials } from './smoke-local.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const binary = resolve(root, 'work/runtime/cloudflared/cloudflared.exe');
const expectedHash = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2';
const builtGateway = resolve(root, 'apps/api/dist/infra/meta/webhook-gateway.js');
const internalOrigin = 'http://127.0.0.1:3001';
const internalApi = 'http://127.0.0.1:3000';
export function parsePublicWebhookHostname(value) {
  if (typeof value !== 'string' || value.length > 253) throw new Error('CLOUDFLARE_PUBLIC_HOSTNAME_INVALID');
  const hostname = value.toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new Error('CLOUDFLARE_PUBLIC_HOSTNAME_INVALID');
  }
  return hostname;
}

let localManagedTunnelHostname;
let publicHostnameError;
try {
  localManagedTunnelHostname = process.env.META_WEBHOOK_HOSTNAME
    ? parsePublicWebhookHostname(process.env.META_WEBHOOK_HOSTNAME)
    : undefined;
} catch (error) {
  publicHostnameError = error?.message === 'CLOUDFLARE_PUBLIC_HOSTNAME_INVALID'
    ? error.message
    : 'CLOUDFLARE_PUBLIC_HOSTNAME_INVALID';
}
export const namedTunnelUrl = localManagedTunnelHostname ? `https://${localManagedTunnelHostname}` : undefined;
const namedTunnelTokenFile = resolve(root, '.env.cloudflare-tunnel.local');
const localManagedTunnelConfigFile = resolve(root, '.cloudflare-tunnel-local-managed.local');
const startupTimeoutMs = 90_000;
const publicRetryDelayMs = 1_500;
const transientPublicStatuses = new Set([502, 503, 530]);
let app;
let tunnel;
let stopping;
let monitor;
let startupTimer;
let startupDeadline;
let generatedConfigDirectory;
let url;
let connected = false;
let probing = false;
let enableMetaVerificationDiagnostics = () => {};

async function request(url, options = {}) {
  return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
}

export async function retryTransientPublicStatus(probe, expectedStatus, {
  deadline = Date.now() + startupTimeoutMs,
  retryDelayMs = publicRetryDelayMs,
  now = Date.now,
  pause = (duration) => new Promise((done) => setTimeout(done, duration)),
} = {}) {
  if (now() >= deadline) throw new Error('PUBLIC_PROBE_TIMEOUT');
  let response = await probe();
  if (now() > deadline) throw new Error('PUBLIC_PROBE_TIMEOUT');
  while (response.status !== expectedStatus && transientPublicStatuses.has(response.status)) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    try { await response.body?.cancel(); } catch { /* discard transient response bodies before retrying */ }
    await pause(Math.min(retryDelayMs, remaining));
    if (now() >= deadline) break;
    response = await probe();
  }
  return response;
}

async function resolveQuickTunnelAddress(hostname, deadline = Date.now() + startupTimeoutMs) {
  let lastError;
  for (let attempt = 0; attempt < 32 && Date.now() < deadline; attempt++) {
    try {
      const reply = await request(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, { headers: { accept: 'application/dns-json' } });
      if (!reply.ok) throw new Error('PUBLIC_DNS_UNAVAILABLE');
      const data = await reply.json();
      const address = data.Status === 0 && Array.isArray(data.Answer) ? data.Answer.find((answer) => answer.type === 1 && isIP(answer.data) === 4)?.data : undefined;
      if (address) return address;
      throw new Error('PUBLIC_DNS_UNAVAILABLE');
    } catch (error) {
      lastError = error;
      const remaining = deadline - Date.now();
      if (attempt === 31 || remaining <= 0) break;
      await new Promise((done) => setTimeout(done, Math.min(publicRetryDelayMs, remaining)));
    }
  }
  throw new Error('PUBLIC_DNS_UNAVAILABLE', { cause: lastError });
}

function requestPublic(origin, path, method, address, { body, headers, readBody = false } = {}) {
  const hostname = new URL(origin).hostname;
  return new Promise((done, fail) => {
    const outbound = httpsRequest({ hostname, path, method, timeout: 5000,
      lookup: (_name, options, callback) => callback(null,
        options.all ? [{ address, family: 4 }] : address,
        options.all ? undefined : 4),
      headers: headers ?? (method === 'POST' ? { 'content-type': 'application/json' } : {}),
    }, (response) => {
      if (!readBody) {
        response.resume();
        done({ status: response.statusCode });
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2048) response.destroy(new Error('PUBLIC_BODY_TOO_LARGE'));
        else chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outbound.on('timeout', () => outbound.destroy(new Error('TIMEOUT')));
    outbound.on('error', fail);
    outbound.end(body ?? (method === 'POST' ? '{}' : undefined));
  });
}

async function assertLocalApi() {
  const infoResponse = await request(`${internalApi}/api/v1/system/info`);
  const info = await infoResponse.json();
  const health = await request(`${internalApi}/health/ready`);
  if (!infoResponse.ok || !health.ok || !isSafeLocalApiInfo(info)) {
    throw new Error('LOCAL_API_NOT_READY');
  }
}

export function isSafeLocalApiInfo(info) {
  if (!info || info.localDemoEnabled !== true || info.eventStore !== 'sqlite' || !Array.isArray(info.capabilities)) return false;
  if (info.outboundMode === 'simulated') {
    return info.whatsappOutboundEnabled === false && !info.capabilities.includes('whatsapp.text.send.local-test');
  }
  return info.outboundMode === 'cloud-api-local-test' && info.whatsappOutboundEnabled === true &&
    info.capabilities.includes('whatsapp.text.send.local-test');
}

async function assertLocalSignature() {
  // Empty envelope: verifies the private bridge, never creates messages or cases.
  const body = '{"object":"whatsapp_business_account","entry":[]}';
  const signature = `sha256=${createHmac('sha256', localSmokeCredentials.appSecret).update(body).digest('hex')}`;
  const response = await request(`${internalApi}/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body });
  if (response.status !== 200 || (await response.json()).received !== true || ['normalized', 'enqueued', 'duplicates', 'unknown-channels'].some((field) => response.headers.get(`x-webhook-${field}`) !== '0')) throw new Error('LOCAL_BRIDGE_NOT_READY');
}

export function cloudflareChildEnvironment(environment = process.env, { tunnelToken } = {}) {
  // Do not pass application secrets, Cloudflare account variables, or debug settings.
  const selected = {};
  const names = new Set(['systemroot', 'windir', 'path', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata']);
  for (const [key, value] of Object.entries(environment)) if (names.has(key.toLowerCase()) && value !== undefined) selected[key] = value;
  // Cloudflare documents TUNNEL_TOKEN as a run-parameter environment variable. Never put it in argv or logs.
  if (typeof tunnelToken === 'string' && tunnelToken.length > 0) selected.TUNNEL_TOKEN = tunnelToken;
  return selected;
}

export function parseNamedTunnelToken(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 8_192) throw new Error('CLOUDFLARE_TUNNEL_TOKEN_INVALID');
  let token;
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const match = /^\s*TUNNEL_TOKEN\s*=\s*([A-Za-z0-9._~+/=-]+)\s*$/.exec(line);
    if (!match || token !== undefined) throw new Error('CLOUDFLARE_TUNNEL_TOKEN_INVALID');
    token = match[1];
  }
  if (!token || token.length < 32 || token.length > 8_000) throw new Error('CLOUDFLARE_TUNNEL_TOKEN_INVALID');
  return token;
}

async function loadNamedTunnelToken() {
  let source;
  try { source = await readFile(namedTunnelTokenFile, 'utf8'); }
  catch { throw new Error('CLOUDFLARE_TUNNEL_TOKEN_MISSING'); }
  return parseNamedTunnelToken(source);
}

const tunnelIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLocalManagedTunnelConfiguration(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 8_192) throw new Error('CLOUDFLARE_LOCAL_TUNNEL_CONFIG_INVALID');
  let tunnelId;
  let credentialsFile;
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const idMatch = /^\s*TUNNEL_ID\s*=\s*([0-9a-f-]+)\s*$/i.exec(line);
    if (idMatch && tunnelId === undefined && tunnelIdPattern.test(idMatch[1])) {
      tunnelId = idMatch[1].toLowerCase();
      continue;
    }
    const credentialsMatch = /^\s*TUNNEL_CREDENTIALS_FILE\s*=\s*(.+?)\s*$/.exec(line);
    if (credentialsMatch && credentialsFile === undefined) {
      credentialsFile = credentialsMatch[1];
      continue;
    }
    throw new Error('CLOUDFLARE_LOCAL_TUNNEL_CONFIG_INVALID');
  }
  if (!tunnelId || !credentialsFile || /[\u0000-\u001f\u007f]/.test(credentialsFile)) throw new Error('CLOUDFLARE_LOCAL_TUNNEL_CONFIG_INVALID');
  const absoluteWindowsPath = /^[a-z]:[\\/]/i.test(credentialsFile) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(credentialsFile);
  if (!absoluteWindowsPath || !win32Path.isAbsolute(credentialsFile) || win32Path.basename(credentialsFile).toLowerCase() !== `${tunnelId}.json`) {
    throw new Error('CLOUDFLARE_LOCAL_TUNNEL_CONFIG_INVALID');
  }
  return { tunnelId, credentialsFile };
}

async function loadLocalManagedTunnelConfiguration() {
  let source;
  try { source = await readFile(localManagedTunnelConfigFile, 'utf8'); }
  catch { throw new Error('CLOUDFLARE_LOCAL_TUNNEL_CONFIG_MISSING'); }
  const configuration = parseLocalManagedTunnelConfiguration(source);
  // Only inspect metadata here. cloudflared reads this tunnel-specific credential file.
  try {
    const credentials = await stat(configuration.credentialsFile);
    if (!credentials.isFile()) throw new Error('CLOUDFLARE_TUNNEL_CREDENTIALS_MISSING');
  } catch { throw new Error('CLOUDFLARE_TUNNEL_CREDENTIALS_MISSING'); }
  return configuration;
}

function yamlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function localManagedTunnelYaml({ tunnelId, credentialsFile, hostname = localManagedTunnelHostname }) {
  const absoluteWindowsPath = typeof credentialsFile === 'string'
    && (/^[a-z]:[\\/]/i.test(credentialsFile) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(credentialsFile));
  if (!hostname) throw new Error('CLOUDFLARE_PUBLIC_HOSTNAME_MISSING');
  const validatedHostname = parsePublicWebhookHostname(hostname);
  if (!tunnelIdPattern.test(tunnelId ?? '') || !absoluteWindowsPath || !win32Path.isAbsolute(credentialsFile)
    || /[\u0000-\u001f\u007f]/.test(credentialsFile)
    || win32Path.basename(credentialsFile).toLowerCase() !== `${tunnelId.toLowerCase()}.json`) {
    throw new Error('CLOUDFLARE_LOCAL_TUNNEL_CONFIG_INVALID');
  }
  return [
    `tunnel: ${yamlString(tunnelId.toLowerCase())}`,
    `credentials-file: ${yamlString(credentialsFile)}`,
    'ingress:',
    `  - hostname: ${validatedHostname}`,
    `    service: ${internalOrigin}`,
    '  - service: http_status:404',
    '',
  ].join('\n');
}

async function createLocalManagedTunnelConfig(configuration) {
  generatedConfigDirectory = await mkdtemp(join(tmpdir(), 'cloudflare-local-managed-'));
  const configPath = resolve(generatedConfigDirectory, 'config.yml');
  await writeFile(configPath, localManagedTunnelYaml({ ...configuration, hostname: localManagedTunnelHostname }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return configPath;
}

export function cloudflareTunnelArguments(mode, { configPath, tunnelId } = {}) {
  if (mode === 'named') return ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:0', '--loglevel', 'info', '--output', 'json', 'run'];
  if (mode === 'local-managed' && typeof configPath === 'string' && configPath.length > 0 && tunnelIdPattern.test(tunnelId ?? '')) {
    return ['tunnel', '--config', configPath, '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:0', '--loglevel', 'info', '--output', 'json', 'run', tunnelId.toLowerCase()];
  }
  if (mode === 'quick') return ['tunnel', '--url', internalOrigin, '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:0', '--loglevel', 'info', '--output', 'json', '--grace-period', '2s'];
  throw new Error('INVALID_USAGE');
}

export function extractQuickTunnelUrl(line) {
  return line.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s|"\]]|$)/)?.[0];
}

function verificationFailureCategory(rawUrl, expectedVerifyToken) {
  if (rawUrl.length > 4_096) return 'consulta longa demais';
  let query;
  try { query = new URL(rawUrl, 'http://127.0.0.1').searchParams; }
  catch { return 'consulta inválida'; }
  if (['hub.mode', 'hub.verify_token', 'hub.challenge'].some((key) => query.getAll(key).length !== 1)) return 'parâmetros obrigatórios ausentes ou duplicados';
  if (query.get('hub.mode') !== 'subscribe') return 'modo diferente';
  if (query.get('hub.verify_token') !== expectedVerifyToken) return 'token diferente';
  if (!query.get('hub.challenge')) return 'desafio ausente';
  return 'limite ou formato do desafio';
}

export function attachMetaVerificationDiagnostics(server, expectedVerifyToken, writeLog = (message) => console.log(message)) {
  let enabled = false;
  server.addHook('onResponse', async (request, reply) => {
    if (!enabled || request.method !== 'GET') return;
    const rawUrl = request.raw.url ?? '';
    const path = rawUrl.split('?', 1)[0];
    if (path !== '/webhooks/meta') return;

    const result = reply.statusCode === 200
      ? 'aceita (HTTP 200)'
      : reply.statusCode === 403
        ? `recusada (HTTP 403; ${verificationFailureCategory(rawUrl, expectedVerifyToken)})`
        : 'resposta fora do esperado';
    writeLog(`Verificação Meta chegou ao gateway: ${result}.`);
  });
  return () => { enabled = true; };
}

async function stop(code = 0, reason) {
  if (stopping) return stopping;
  stopping = (async () => {
    process.exitCode = code;
    clearInterval(monitor);
    clearTimeout(startupTimer);
    if (reason) console.log(reason);
    if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(() => { tunnel.kill('SIGKILL'); done(); }, 4000);
        tunnel.once('close', () => { clearTimeout(timer); done(); });
        tunnel.kill('SIGTERM');
      });
    }
    if (generatedConfigDirectory) {
      const directory = generatedConfigDirectory;
      generatedConfigDirectory = undefined;
      try { await rm(directory, { recursive: true, force: true }); } catch { /* temporary config cleanup is best effort */ }
    }
    if (app) await app.close();
    console.log('Túnel encerrado. API e painel locais não foram encerrados.');
  })();
  return stopping;
}

async function checkPublicIsolation(origin, deadline = Date.now() + startupTimeoutMs) {
  const hostname = new URL(origin).hostname;
  let address;
  if (origin !== internalOrigin) {
    for (let attempt = 0; attempt < 32 && Date.now() < deadline; attempt++) {
      try { address = await resolveQuickTunnelAddress(hostname, deadline); break; }
      catch (error) {
        const remaining = deadline - Date.now();
        if (attempt === 31 || remaining <= 0) throw new Error('PUBLIC_DNS_UNAVAILABLE', { cause: error });
        await new Promise((done) => setTimeout(done, Math.min(publicRetryDelayMs, remaining)));
      }
    }
  }
  for (const [path, method, expected] of [
    ['/', 'GET', 404],
    ['/api/v1/system/info', 'GET', 404],
    ['/api/v1/auth/login', 'POST', 404],
    ['/health/ready', 'GET', 404],
    ['/.env.webhook.local', 'GET', 404],
    ['/webhooks/meta', 'GET', 403],
    ['/webhooks/meta', 'POST', 401],
  ]) {
    let response;
    for (let attempt = 0; attempt < 16; attempt++) {
      if (Date.now() >= deadline) throw new Error(`PUBLIC_ISOLATION_NETWORK_ERROR ${method} ${path} TIMEOUT`);
      try {
        const probe = () => address ? requestPublic(origin, path, method, address) : request(`${origin}${path}`, {
          method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
        });
        response = await retryTransientPublicStatus(probe, expected, { deadline });
        break;
      } catch (error) {
        const remaining = deadline - Date.now();
        if (attempt === 15 || remaining <= 0) {
          const code = /^(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED)$/.test(error?.cause?.code ?? '') ? error.cause.code : 'FETCH_ERROR';
          throw new Error(`PUBLIC_ISOLATION_NETWORK_ERROR ${method} ${path} ${code}`);
        }
        await new Promise((done) => setTimeout(done, Math.min(publicRetryDelayMs, remaining)));
      }
    }
    await response.body?.cancel();
    if (response.status !== expected) throw new Error(`PUBLIC_ISOLATION_FAILED ${method} ${path} ${response.status}`);
  }
}

async function announceWhenReady(configuration) {
  if (!url || !connected || probing || stopping) return;
  probing = true;
  try {
    const deadline = startupDeadline ?? Date.now() + startupTimeoutMs;
    await checkPublicIsolation(url, deadline);
    const address = await resolveQuickTunnelAddress(new URL(url).hostname, deadline);
    const challenge = 'codex-webhook-check';
    const query = `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(configuration.verifyToken)}&hub.challenge=${challenge}`;
    const challengeReply = await retryTransientPublicStatus(() => requestPublic(url, query, 'GET', address, { readBody: true }), 200, { deadline });
    if (challengeReply.status !== 200 || challengeReply.body !== challenge) throw new Error('PUBLIC_CHALLENGE_FAILED');
    const emptyEvent = '{"object":"whatsapp_business_account","entry":[]}';
    const signature = `sha256=${createHmac('sha256', configuration.appSecret).update(emptyEvent).digest('hex')}`;
    const signedReply = await retryTransientPublicStatus(() => requestPublic(url, '/webhooks/meta', 'POST', address, {
      body: emptyEvent, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    }), 200, { deadline });
    if (signedReply.status !== 200) throw new Error('PUBLIC_SIGNED_EMPTY_EVENT_FAILED');
    clearTimeout(startupTimer);
    enableMetaVerificationDiagnostics();
    console.log(`Callback HTTPS: ${url}/webhooks/meta`);
    console.log('Isolamento público conferido: painel/API/arquivos bloqueados; POST sem assinatura rejeitado. Challenge e evento vazio assinado aprovados.');
    console.log('Copie META_VERIFY_TOKEN somente do arquivo privado para a configuração na Meta. Não é o access token.');
    console.log('Canais não associados recebem 503, sem ACK silencioso. A associação do número de teste é configurada separadamente no tenant isolado.');
    console.log(url === namedTunnelUrl
      ? 'Envio permanece SIMULATED. Ctrl+C encerra somente gateway/túnel; API e painel locais seguem ativos.'
      : 'Envio permanece SIMULATED. Ctrl+C encerra somente gateway/túnel. URL muda a cada novo túnel.');
  } catch (error) {
    const diagnostic = ['PUBLIC_DNS_UNAVAILABLE', 'PUBLIC_CHALLENGE_FAILED', 'PUBLIC_SIGNED_EMPTY_EVENT_FAILED'].includes(error?.message) || /^PUBLIC_ISOLATION_(?:FAILED (?:GET|POST) \/[^\s]* \d{3}|NETWORK_ERROR (?:GET|POST) \/[^\s]* [A-Z_]+)$/.test(error?.message ?? '') ? error.message : 'PUBLIC_ISOLATION_NETWORK_ERROR';
    const hostname = url ? new URL(url).hostname : 'NOT_ASSIGNED';
    await stop(1, `Falha na validação pública: ${diagnostic}. Host público: ${hostname}. Encerrando acesso.`);
  }
}

export async function runCloudflareLocal(args = process.argv.slice(2)) {
  const mode = args.length === 0 ? 'quick'
    : args.length === 1 && args[0] === '--named' ? 'named'
      : args.length === 1 && args[0] === '--local-managed' ? 'local-managed'
        : undefined;
  if (!mode) throw new Error('INVALID_USAGE');
  if (process.platform !== 'win32') throw new Error('WINDOWS_REQUIRED');
  if (publicHostnameError) throw new Error(publicHostnameError);
  if ((mode === 'named' || mode === 'local-managed') && !namedTunnelUrl) throw new Error('CLOUDFLARE_PUBLIC_HOSTNAME_MISSING');
  const configuration = await loadWebhookConfig(); // Missing real secret blocks BEFORE any public access.
  const tunnelToken = mode === 'named' ? await loadNamedTunnelToken() : undefined;
  const localManagedConfiguration = mode === 'local-managed' ? await loadLocalManagedTunnelConfiguration() : undefined;
  if (!existsSync(binary) || createHash('sha256').update(readFileSync(binary)).digest('hex') !== expectedHash) throw new Error('CLOUDFLARED_NOT_VERIFIED');
  if (!existsSync(builtGateway)) throw new Error('BUILD_REQUIRED');
  for (const location of [resolve(homedir(), '.cloudflared'), resolve(homedir(), '.cloudflare-warp'), resolve(homedir(), 'cloudflare-warp'), dirname(binary), root]) {
    for (const name of ['config.yml', 'config.yaml']) if (existsSync(resolve(location, name))) throw new Error('EXISTING_CLOUDFLARE_CONFIG');
  }
  await assertLocalApi();
  await assertLocalSignature();
  const { buildWebhookGateway } = await import(pathToFileURL(builtGateway).href);
  app = await buildWebhookGateway({ ...configuration, localUpstreamSecret: localSmokeCredentials.appSecret });
  enableMetaVerificationDiagnostics = attachMetaVerificationDiagnostics(app, configuration.verifyToken);
  await app.listen({ host: '127.0.0.1', port: 3001 });
  // Confirm we are exposing OUR isolated receiver, not an occupied port or the demo API.
  await checkPublicIsolation(internalOrigin);
  if (mode === 'named' || mode === 'local-managed') url = namedTunnelUrl;
  const generatedConfigPath = mode === 'local-managed' ? await createLocalManagedTunnelConfig(localManagedConfiguration) : undefined;
  tunnel = spawn(binary, cloudflareTunnelArguments(mode, { configPath: generatedConfigPath, tunnelId: localManagedConfiguration?.tunnelId }), {
    cwd: dirname(binary), env: cloudflareChildEnvironment(process.env, mode === 'named' ? { tunnelToken } : {}), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(mode === 'quick'
    ? 'Gateway em loopback:3001 pronto. Solicitando túnel temporário Cloudflare...'
    : mode === 'named'
      ? 'Gateway em loopback:3001 pronto. Solicitando conexão ao túnel Cloudflare gerenciado remotamente...'
      : 'Gateway em loopback:3001 pronto. Solicitando conexão ao túnel Cloudflare gerenciado localmente...');
  startupDeadline = Date.now() + startupTimeoutMs;
  startupTimer = setTimeout(() => { void stop(1, 'Túnel não ficou pronto em 90 segundos. Acesso encerrado.'); }, startupTimeoutMs);
  for (const stream of [tunnel.stdout, tunnel.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending = (pending + chunk).slice(-32_768);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const found = mode === 'quick' ? extractQuickTunnelUrl(line) : undefined;
        if (found) url = found;
        if (line.includes('Registered tunnel connection')) connected = true;
        void announceWhenReady(configuration);
      }
      // Never echo raw Cloudflare logs (URLs/query/headers/error details may contain secrets).
    });
  }
  tunnel.once('error', () => { void stop(1, 'Não foi possível executar cloudflared. Acesso encerrado.'); });
  tunnel.once('exit', () => { if (!stopping) void stop(1, 'Cloudflared encerrou. Gateway sendo encerrado.'); });
  let monitorInFlight = false;
  monitor = setInterval(async () => {
    if (monitorInFlight || stopping) return;
    monitorInFlight = true;
    try { await assertLocalApi(); } catch { void stop(1, 'API local indisponível ou modo alterado. Encerrando túnel.'); }
    finally { monitorInFlight = false; }
  }, 5000);
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  if (process.send) process.send({ type: 'ready' });
  process.on('message', (message) => { if (message?.type === 'shutdown') void stop(); });
}

const errors = new Set(['INVALID_USAGE', 'WINDOWS_REQUIRED', 'CLOUDFLARED_NOT_VERIFIED', 'CLOUDFLARE_TUNNEL_TOKEN_MISSING', 'CLOUDFLARE_TUNNEL_TOKEN_INVALID', 'CLOUDFLARE_LOCAL_TUNNEL_CONFIG_MISSING', 'CLOUDFLARE_LOCAL_TUNNEL_CONFIG_INVALID', 'CLOUDFLARE_TUNNEL_CREDENTIALS_MISSING', 'CLOUDFLARE_PUBLIC_HOSTNAME_MISSING', 'CLOUDFLARE_PUBLIC_HOSTNAME_INVALID', 'BUILD_REQUIRED', 'EXISTING_CLOUDFLARE_CONFIG', 'LOCAL_API_NOT_READY', 'LOCAL_BRIDGE_NOT_READY']);
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  runCloudflareLocal().catch(async (error) => {
    const code = errors.has(error?.message) ? error.message : sanitizedConfigError(error);
    console.error(`Túnel não iniciado: ${code}. Confira configuração privada, build e dev:local. Nenhum valor exibido.`);
    await stop(1);
  });
}

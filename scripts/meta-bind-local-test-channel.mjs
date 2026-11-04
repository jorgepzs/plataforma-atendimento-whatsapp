import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMetaLocalText } from './meta-local.mjs';

const origin = 'http://127.0.0.1:3000';
const privateFile = fileURLToPath(new URL('../.env.meta.local', import.meta.url));
const displayName = 'Teste Meta WhatsApp';
const demoAdmin = { email: 'admin@atende.local', password: 'AtendeLocal123!' };

async function localRequest(path, options = {}) {
  return fetch(origin + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
}

async function requireLocalTestId() {
  const buffer = await readFile(privateFile);
  if (buffer.byteLength > 32 * 1024) throw new Error('META_CONFIG_INVALID');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (!validateMetaLocalText(source).ok) throw new Error('META_CONFIG_INVALID');
  const id = parseEnv(source).META_PHONE_NUMBER_ID;
  if (!/^[1-9][0-9]{0,31}$/.test(id ?? '')) throw new Error('META_CONFIG_INVALID');
  return id;
}

export async function bindLocalTestChannel() {
  const phoneNumberId = await requireLocalTestId();
  const infoResponse = await localRequest('/api/v1/system/info');
  const info = await infoResponse.json();
  if (!infoResponse.ok || info.localDemoEnabled !== true || info.eventStore !== 'sqlite' || info.outboundMode !== 'simulated') throw new Error('LOCAL_API_NOT_READY');

  const login = await localRequest('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(demoAdmin) });
  if (!login.ok) throw new Error('LOCAL_ADMIN_LOGIN_FAILED');
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  const loginBody = await login.json();
  const csrf = loginBody?.csrfToken;
  if (!cookie || typeof csrf !== 'string' || !loginBody?.user?.platformAdmin) throw new Error('LOCAL_ADMIN_LOGIN_FAILED');
  const headers = { cookie, 'x-csrf-token': csrf, origin, 'content-type': 'application/json' };
  try {
    const listing = await localRequest('/api/v1/tenants', { headers: { cookie } });
    if (!listing.ok) throw new Error('TENANT_LIST_FAILED');
    const tenants = (await listing.json()).tenants;
    if (!Array.isArray(tenants)) throw new Error('TENANT_LIST_FAILED');
    const otherOwner = tenants.find((tenant) => tenant.channelPhoneNumberId === phoneNumberId && (tenant.displayName !== displayName || tenant.segment !== 'outro'));
    if (otherOwner) throw new Error('CHANNEL_BOUND_ELSEWHERE');
    const matches = tenants.filter((tenant) => tenant.displayName === displayName && tenant.segment === 'outro');
    if (matches.length > 1) throw new Error('AMBIGUOUS_TEST_TENANT');
    let tenant = matches[0];
    if (!tenant) {
      const created = await localRequest('/api/v1/tenants', { method: 'POST', headers, body: JSON.stringify({ displayName, segment: 'outro' }) });
      if (created.status !== 201) throw new Error('TEST_TENANT_CREATE_FAILED');
      tenant = (await created.json()).tenant;
    }
    if (!tenant || typeof tenant.id !== 'string') throw new Error('TEST_TENANT_CREATE_FAILED');
    const bound = await localRequest(`/api/v1/tenants/${encodeURIComponent(tenant.id)}/channel`, { method: 'PUT', headers, body: JSON.stringify({ phoneNumberId }) });
    if (!bound.ok) throw new Error('CHANNEL_BIND_FAILED');
    const result = (await bound.json()).tenant;
    if (result?.id !== tenant.id || result?.channelPhoneNumberId !== phoneNumberId) throw new Error('CHANNEL_BIND_FAILED');
    return { tenantId: tenant.id, displayName };
  } finally {
    try { await localRequest('/api/v1/auth/logout', { method: 'POST', headers }); } catch { /* Session expires if API is unavailable. */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  bindLocalTestChannel().then(({ tenantId }) => {
    console.log(`Número de teste associado à empresa isolada ${displayName} (${tenantId}). Envio permanece simulado.`);
  }).catch((error) => {
    const safe = new Set(['META_CONFIG_INVALID', 'LOCAL_API_NOT_READY', 'LOCAL_ADMIN_LOGIN_FAILED', 'TENANT_LIST_FAILED', 'CHANNEL_BOUND_ELSEWHERE', 'AMBIGUOUS_TEST_TENANT', 'TEST_TENANT_CREATE_FAILED', 'CHANNEL_BIND_FAILED']);
    const code = safe.has(error?.message) ? error.message : 'LOCAL_BIND_FAILED';
    console.error(`Associação não concluída: ${code}. Nenhum segredo exibido.`);
    process.exitCode = 1;
  });
}

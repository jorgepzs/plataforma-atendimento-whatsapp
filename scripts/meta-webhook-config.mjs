import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const webhookConfigFile = fileURLToPath(new URL('../.env.webhook.local', import.meta.url));

// Separate from the access-token file. No arbitrary environment keys are accepted.
export function parseWebhookConfig(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 4096) throw new Error('WEBHOOK_CONFIG_INVALID');
  const fields = new Map();
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const match = /^\s*(META_APP_SECRET|META_VERIFY_TOKEN)\s*=\s*([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (!match || fields.has(match[1])) throw new Error('WEBHOOK_CONFIG_INVALID');
    fields.set(match[1], match[2]);
  }
  const appSecret = fields.get('META_APP_SECRET');
  const verifyToken = fields.get('META_VERIFY_TOKEN');
  if (!appSecret) throw new Error('META_APP_SECRET_MISSING');
  if (!/^[a-fA-F0-9]{32}$/.test(appSecret) || /^([a-fA-F0-9])\1{31}$/.test(appSecret)) throw new Error('META_APP_SECRET_INVALID');
  if (!verifyToken || !/^[a-fA-F0-9]{64}$/.test(verifyToken) || /^([a-fA-F0-9])\1{63}$/.test(verifyToken)) throw new Error('META_VERIFY_TOKEN_INVALID');
  return { appSecret, verifyToken };
}

export async function loadWebhookConfig() {
  let buffer;
  try { buffer = await readFile(webhookConfigFile); } catch { throw new Error('WEBHOOK_CONFIG_UNREADABLE'); }
  if (buffer.byteLength > 4096) throw new Error('WEBHOOK_CONFIG_INVALID');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error('WEBHOOK_CONFIG_INVALID'); }
  return parseWebhookConfig(source);
}

export function sanitizedConfigError(error) {
  const allowed = new Set(['WEBHOOK_CONFIG_INVALID', 'WEBHOOK_CONFIG_UNREADABLE', 'META_APP_SECRET_MISSING', 'META_APP_SECRET_INVALID', 'META_VERIFY_TOKEN_INVALID']);
  return allowed.has(error?.message) ? error.message : 'WEBHOOK_CONFIG_INVALID';
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    if (process.argv.length !== 2) throw new Error('WEBHOOK_CONFIG_INVALID');
    await loadWebhookConfig();
    console.log('Estrutura do segredo do app e token de verificação válida. Não confirma assinatura real da Meta. Nenhum acesso público iniciado.');
  } catch (error) {
    console.error(`Webhook não preparado: ${sanitizedConfigError(error)}. Nenhum valor exibido.`);
    process.exitCode = 1;
  }
}

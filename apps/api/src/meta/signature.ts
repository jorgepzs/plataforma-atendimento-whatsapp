import { createHmac, timingSafeEqual } from "node:crypto";

const signaturePrefix = "sha256=";

export function createMetaSignature(rawBody: Buffer, appSecret: string): string {
  return `${signaturePrefix}${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

export function verifyMetaSignature(
  rawBody: Buffer,
  providedSignature: string | undefined,
  appSecret: string
): boolean {
  if (!providedSignature?.startsWith(signaturePrefix)) {
    return false;
  }

  const expected = Buffer.from(createMetaSignature(rawBody, appSecret));
  const provided = Buffer.from(providedSignature);

  return expected.length === provided.length && timingSafeEqual(expected, provided);
}


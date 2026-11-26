/**
 * Mesmo formato de `BufferJSON` do Baileys 6.7.24.
 * Sessões já gravadas por `useMultiFileAuthState` continuam legíveis.
 */
export interface JsonCodec {
  replacer: (key: string, value: unknown) => unknown;
  reviver: (key: string, value: unknown) => unknown;
}

export const bufferJsonCodec: JsonCodec = {
  replacer: (_key, value: unknown) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { type: "Buffer", data: Buffer.from(value).toString("base64") };
    }
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "Buffer") {
      const data = (value as { data?: unknown }).data;
      const bytes = Buffer.isBuffer(data) || data instanceof Uint8Array
        ? Buffer.from(data)
        : Buffer.from(Array.isArray(data) ? data : []);
      return { type: "Buffer", data: bytes.toString("base64") };
    }
    return value;
  },
  reviver: (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && ((value as { buffer?: unknown }).buffer === true || (value as { type?: unknown }).type === "Buffer")) {
      const encoded = (value as { data?: unknown; value?: unknown }).data ?? (value as { value?: unknown }).value;
      return typeof encoded === "string" ? Buffer.from(encoded, "base64") : Buffer.from(Array.isArray(encoded) ? encoded : []);
    }
    return value;
  }
};

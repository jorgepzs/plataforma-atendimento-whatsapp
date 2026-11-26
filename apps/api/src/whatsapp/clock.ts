export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  random(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }),
  random: () => Math.random()
};

export function jitterDelay(minMs: number, maxMs: number, random: () => number, extraMs = 0): number {
  const span = Math.max(0, maxMs - minMs);
  const offset = Math.floor(Math.min(1, Math.max(0, random())) * (span + 1));
  return minMs + Math.min(offset, span) + extraMs;
}

export function typingDuration(text: string, settings: { typingMsPerChar: number; typingMinMs: number; typingMaxMs: number }): number {
  const raw = text.length * settings.typingMsPerChar;
  return Math.min(settings.typingMaxMs, Math.max(settings.typingMinMs, raw));
}

export function reconnectDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt)));
  const jitter = Math.floor(Math.min(1, Math.max(0, random())) * Math.min(1_000, exponential * 0.2));
  return exponential + jitter;
}

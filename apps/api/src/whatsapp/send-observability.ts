import type { WhatsAppSendOutcome } from "./types.js";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const trackedMinutes = 60;

const safeFailureReasons = new Set([
  "invalid_recipient", "message_too_long", "halted", "not_connected", "banned", "restricted",
  "duplicate_number", "session_locked", "session_replaced", "empty_text", "proactive_disabled",
  "no_prior_inbound", "missing_opt_in", "opted_out", "quiet_hours", "rate_minute", "rate_hour",
  "rate_day", "contact_rate_minute", "contact_rate_hour", "contact_rate_day", "too_many_links",
  "duplicate_text", "mass_identical", "network", "rejected", "unsupported", "send_exception"
]);

interface MinuteBucket {
  queueWaitSamples: number;
  queueWaitTotalMs: number;
  minuteLimitWaits: number;
  minuteLimitWaitMs: number;
  acceptedMessages: number;
  failed: number;
  failuresByReason: Record<string, number>;
}

interface TenantMetrics {
  waiting: Map<number, number>;
  activeSends: number;
  buckets: Map<number, MinuteBucket>;
  lastAcceptedAt: { at: number; iso: string } | null;
  lastFailure: { at: number; iso: string; reason: string } | null;
}

export interface WhatsAppSendObservabilitySnapshot {
  window: "rolling_1h";
  queueDepth: number;
  activeSends: number;
  oldestQueuedForMs: number;
  queueWaitSamples: number;
  averageQueueWaitMs: number;
  minuteLimitWaits: number;
  minuteLimitWaitMs: number;
  acceptedMessages: number;
  failed: number;
  failuresByReason: Record<string, number>;
  lastAcceptedAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
}

/** Aggregate per-tenant send metrics; never stores recipient identifiers or message content. */
export class WhatsAppSendObservability {
  private readonly tenants = new Map<string, TenantMetrics>();
  private nextJobId = 0;

  enqueue(tenantId: string, enqueuedAtMs: number): number {
    const id = ++this.nextJobId;
    this.metrics(tenantId).waiting.set(id, enqueuedAtMs);
    return id;
  }

  start(tenantId: string, jobId: number, startedAtMs: number): void {
    const metrics = this.metrics(tenantId);
    const enqueuedAtMs = metrics.waiting.get(jobId);
    metrics.waiting.delete(jobId);
    metrics.activeSends += 1;
    const bucket = this.bucket(metrics, startedAtMs);
    bucket.queueWaitSamples += 1;
    bucket.queueWaitTotalMs += Math.max(0, startedAtMs - (enqueuedAtMs ?? startedAtMs));
  }

  finish(
    tenantId: string,
    atMs: number,
    outcome: WhatsAppSendOutcome,
    minuteLimitWaitMs = 0,
    active = true
  ): void {
    const metrics = this.metrics(tenantId);
    if (active) metrics.activeSends = Math.max(0, metrics.activeSends - 1);
    const bucket = this.bucket(metrics, atMs);
    if (minuteLimitWaitMs > 0) {
      bucket.minuteLimitWaits += 1;
      bucket.minuteLimitWaitMs += minuteLimitWaitMs;
    }
    if (outcome.ok) {
      bucket.acceptedMessages += outcome.chunks;
      metrics.lastAcceptedAt = { at: atMs, iso: new Date(atMs).toISOString() };
      return;
    }
    const acceptedChunks = outcome.acceptedChunks ?? 0;
    bucket.acceptedMessages += acceptedChunks;
    if (acceptedChunks > 0) metrics.lastAcceptedAt = { at: atMs, iso: new Date(atMs).toISOString() };
    const reason = this.safeReason(outcome.reason);
    bucket.failed += 1;
    bucket.failuresByReason[reason] = (bucket.failuresByReason[reason] ?? 0) + 1;
    metrics.lastFailure = { at: atMs, iso: new Date(atMs).toISOString(), reason };
  }

  snapshot(tenantId: string, nowMs: number): WhatsAppSendObservabilitySnapshot {
    const metrics = this.metrics(tenantId);
    const currentMinute = Math.floor(nowMs / minuteMs) * minuteMs;
    const oldestQueuedAt = metrics.waiting.size > 0 ? Math.min(...metrics.waiting.values()) : undefined;
    const aggregate: MinuteBucket = {
      queueWaitSamples: 0,
      queueWaitTotalMs: 0,
      minuteLimitWaits: 0,
      minuteLimitWaitMs: 0,
      acceptedMessages: 0,
      failed: 0,
      failuresByReason: {}
    };
    for (const [minute, bucket] of metrics.buckets) {
      if (minute < currentMinute - (trackedMinutes - 1) * minuteMs) {
        metrics.buckets.delete(minute);
        continue;
      }
      aggregate.queueWaitSamples += bucket.queueWaitSamples;
      aggregate.queueWaitTotalMs += bucket.queueWaitTotalMs;
      aggregate.minuteLimitWaits += bucket.minuteLimitWaits;
      aggregate.minuteLimitWaitMs += bucket.minuteLimitWaitMs;
      aggregate.acceptedMessages += bucket.acceptedMessages;
      aggregate.failed += bucket.failed;
      for (const [reason, count] of Object.entries(bucket.failuresByReason)) {
        aggregate.failuresByReason[reason] = (aggregate.failuresByReason[reason] ?? 0) + count;
      }
    }
    const recent = (value: { at: number; iso: string } | { at: number; iso: string; reason: string } | null) =>
      value && nowMs >= value.at && nowMs - value.at < hourMs ? value : null;
    const lastAccepted = recent(metrics.lastAcceptedAt);
    const lastFailure = recent(metrics.lastFailure);
    return {
      window: "rolling_1h",
      queueDepth: metrics.waiting.size,
      activeSends: metrics.activeSends,
      oldestQueuedForMs: oldestQueuedAt === undefined ? 0 : Math.max(0, nowMs - oldestQueuedAt),
      queueWaitSamples: aggregate.queueWaitSamples,
      averageQueueWaitMs: aggregate.queueWaitSamples === 0
        ? 0
        : Math.round(aggregate.queueWaitTotalMs / aggregate.queueWaitSamples),
      minuteLimitWaits: aggregate.minuteLimitWaits,
      minuteLimitWaitMs: aggregate.minuteLimitWaitMs,
      acceptedMessages: aggregate.acceptedMessages,
      failed: aggregate.failed,
      failuresByReason: aggregate.failuresByReason,
      lastAcceptedAt: lastAccepted?.iso ?? null,
      lastFailureAt: lastFailure?.iso ?? null,
      lastFailureReason: lastFailure && "reason" in lastFailure && typeof lastFailure.reason === "string"
        ? lastFailure.reason
        : null
    };
  }

  private metrics(tenantId: string): TenantMetrics {
    let metrics = this.tenants.get(tenantId);
    if (!metrics) {
      metrics = { waiting: new Map(), activeSends: 0, buckets: new Map(), lastAcceptedAt: null, lastFailure: null };
      this.tenants.set(tenantId, metrics);
    }
    return metrics;
  }

  private bucket(metrics: TenantMetrics, atMs: number): MinuteBucket {
    const minute = Math.floor(atMs / minuteMs) * minuteMs;
    const oldestTracked = minute - (trackedMinutes - 1) * minuteMs;
    for (const existingMinute of metrics.buckets.keys()) {
      if (existingMinute < oldestTracked) metrics.buckets.delete(existingMinute);
    }
    let bucket = metrics.buckets.get(minute);
    if (!bucket) {
      bucket = {
        queueWaitSamples: 0,
        queueWaitTotalMs: 0,
        minuteLimitWaits: 0,
        minuteLimitWaitMs: 0,
        acceptedMessages: 0,
        failed: 0,
        failuresByReason: {}
      };
      metrics.buckets.set(minute, bucket);
    }
    while (metrics.buckets.size > trackedMinutes) {
      const oldest = Math.min(...metrics.buckets.keys());
      metrics.buckets.delete(oldest);
    }
    return bucket;
  }

  private safeReason(reason: string): string {
    return safeFailureReasons.has(reason) ? reason : "other";
  }
}

/**
 * telemetry.ts — Block 4.1 (v2)
 *
 * Ledger-style telemetry for the Judge Dashboard.
 * Each event has a dedupKey — if an event with the same key exists,
 * it is REPLACED (updated) instead of appended. This ensures the
 * dashboard shows one entry per A2A conversation, one per proposal, etc.
 *
 * Platform-safe: no-op on React Native (native).
 */

import { Platform } from 'react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TelemetryEvent {
  timestamp: string;
  sessionId: string;
  event: string;
  dedupKey: string;
  payload: Record<string, any>;
}

// ─── Storage key ──────────────────────────────────────────────────────────────

const TELEMETRY_KEY = 'chaptr:telemetry-events';

// ─── Platform guard ───────────────────────────────────────────────────────────

const isWeb = Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Emit a telemetry event.
 *
 * @param event    - Event name (e.g. 'a2a_complete', 'propose_fired')
 * @param payload  - JSON-safe event data
 * @param owner    - Owner address (used as sessionId prefix)
 * @param dedupKey - Unique key for this event. If an event with the same key
 *                   already exists, it is REPLACED instead of duplicated.
 *                   Example: 'a2a:0x1a2b:0x3c4d' for an A2A between two owners.
 */
export const emitEvent = (
  event: string,
  payload: Record<string, any>,
  owner: string,
  dedupKey?: string,
): void => {
  if (!isWeb) return;

  try {
    const existing = window.localStorage.getItem(TELEMETRY_KEY);
    const events: TelemetryEvent[] = existing ? JSON.parse(existing) : [];

    const key = dedupKey || `${event}:${Date.now()}:${Math.random()}`;

    const entry: TelemetryEvent = {
      timestamp: new Date().toISOString(),
      sessionId: owner ? owner.slice(0, 10) : 'unknown',
      event,
      dedupKey: key,
      payload,
    };

    // Replace existing event with same key, or append
    const existingIdx = events.findIndex((e) => e.dedupKey === key);
    if (existingIdx >= 0) {
      events[existingIdx] = entry;
    } else {
      events.push(entry);
    }

    // Cap at 500
    const capped = events.length > 500 ? events.slice(-500) : events;
    window.localStorage.setItem(TELEMETRY_KEY, JSON.stringify(capped));
    console.log(`[TELEMETRY] ${existingIdx >= 0 ? '🔄' : '✅'} ${event}`, dedupKey ?? '(no key)');
  } catch (err) {
    console.warn(`[TELEMETRY] ❌ Failed to emit ${event}:`, err);
  }
};

/**
 * Read all telemetry events.
 */
export const readTelemetry = (): TelemetryEvent[] => {
  if (!isWeb) return [];

  try {
    const raw = window.localStorage.getItem(TELEMETRY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * Clear all telemetry events.
 */
export const clearTelemetry = (): void => {
  if (!isWeb) return;
  try {
    window.localStorage.removeItem(TELEMETRY_KEY);
  } catch {}
};

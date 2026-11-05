import { useCallback, useEffect, useState } from 'react';

/** Background work (negotiation, apply-contract, monitor) is followed every 3 s, at most 20 times. */
export const POLL_MS = 3000;
export const MAX_POLLS = 20;

type ContractState = { status: string; projectedDate: string | null } | null | undefined;

/** Request statuses that still change without user action (background queue). */
export function requestIsMoving(status: string): boolean {
  return status === 'negotiating' || status === 'approved';
}

/** A contract is still moving while Jira is updated or before the monitor gave it a projected date. */
export function contractIsMoving(contract: ContractState): boolean {
  if (!contract) return false;
  return contract.status === 'applying' || (contract.status === 'on-track' && contract.projectedDate === null);
}

/** Compact signature of what a list shows, used to stop watching once something changed. */
export function contractSignature(rows: ReadonlyArray<{ contractId: number; status: string; projectedDate: string | null }>): string {
  return rows.map((row) => `${row.contractId}:${row.status}:${row.projectedDate ?? '-'}`).join('|');
}

/** Light background refresh of an open list (new requests from agents), every 12 s. */
export const IDLE_POLL_MS = 12_000;
/** Idle refresh stops 10 minutes after the last interaction (tab switch, click). */
export const IDLE_WINDOW_MS = 10 * 60_000;

export function idlePollingAllowed(lastActivityAt: number, now: number, windowMs: number = IDLE_WINDOW_MS): boolean {
  return now >= lastActivityAt && now - lastActivityAt < windowMs;
}

/**
 * Returns the new data key when `value` differs from what is shown (`previousKey`), else null,
 * so a refresh that brings the same data does not re-render the list.
 */
export function changedKey(previousKey: string | null, value: unknown): string | null {
  const key = JSON.stringify(value);
  return key === previousKey ? null : key;
}

/**
 * One function per key that stays the same across renders. UI Kit gives every new callback prop a new
 * handler id and sends it to the host; a click that lands while the host still has the old id is dropped,
 * so buttons in lists that refresh in the background keep the same handler.
 */
export function keyedCallbacks<K>(handle: (key: K) => void): (key: K) => () => void {
  const cache = new Map<K, () => void>();
  return (key) => {
    let callback = cache.get(key);
    if (!callback) {
      callback = () => handle(key);
      cache.set(key, callback);
    }
    return callback;
  };
}

/** Calls `load` every IDLE_POLL_MS while `enabled` and within IDLE_WINDOW_MS of `lastActivityAt`. */
export function useIdlePolling(enabled: boolean, lastActivityAt: number, load: () => Promise<void>) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled || !idlePollingAllowed(lastActivityAt, Date.now())) return undefined;
    const timer = setTimeout(() => {
      void load().finally(() => setTick((value) => value + 1));
    }, IDLE_POLL_MS);
    return () => clearTimeout(timer);
  }, [enabled, lastActivityAt, load, tick]);
}

/**
 * Calls `load` every POLL_MS while `active`, at most MAX_POLLS times. `restart` resets the budget
 * (after a decision or a manual Refresh); `exhausted` tells the UI to offer the Refresh fallback.
 */
export function useBoundedPolling(active: boolean, load: () => Promise<void>) {
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    if (!active || polls >= MAX_POLLS) return undefined;
    const timer = setTimeout(() => {
      setPolls((value) => value + 1);
      void load();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [active, polls, load]);
  const restart = useCallback(() => setPolls(0), []);
  return { polling: active && polls < MAX_POLLS, exhausted: active && polls >= MAX_POLLS, restart };
}

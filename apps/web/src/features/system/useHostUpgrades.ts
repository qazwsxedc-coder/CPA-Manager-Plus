import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/stores';
import { isDemoMode } from '@/features/demo/demoMode';
import { normalizeUsageServiceBase } from '@/services/api/usageService';
import { hostUpgradeApi, type UpgradeRequest } from './hostUpgradeApi';
import {
  isUpgradeRunning,
  selectPreparedRelease,
  samePreparedRelease,
  upgradeStorageKey,
  type HostUpgradeCatalog,
  type HostUpgradeJob,
  type HostUpgradeRelease,
} from './hostUpgradeModel';

interface PendingUpgrade extends UpgradeRequest {
  job?: HostUpgradeJob;
}
interface SavedUpgrade {
  schemaVersion: 1;
  enabled: true;
  pending?: PendingUpgrade;
}
interface UpgradeSnapshot {
  enabled: boolean;
  resolved: boolean;
  catalog: HostUpgradeCatalog | null;
  pending: PendingUpgrade | null;
  reconnecting: boolean;
  error: 'storage' | 'request' | 'rejected' | null;
  rejectionStatus?: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function restore(base: string): UpgradeSnapshot {
  let saved: SavedUpgrade | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(upgradeStorageKey(base)) || 'null');
    if (value?.schemaVersion === 1 && value.enabled === true) {
      const pending = value.pending;
      if (
        !pending ||
        (uuid.test(pending.requestId) &&
          ['cli', 'manager'].includes(pending.component) &&
          typeof pending.releaseId === 'string' &&
          (!pending.job || pending.job.id === pending.requestId))
      )
        saved = value;
    }
  } catch {
    /* Storage may be unavailable; submission checks persistence first. */
  }
  return {
    enabled: !!saved,
    resolved: !base || !!saved,
    catalog: null,
    pending: saved?.pending || null,
    reconnecting: false,
    error: null,
  };
}

function persist(base: string, snapshot: UpgradeSnapshot) {
  if (!snapshot.enabled) return;
  localStorage.setItem(
    upgradeStorageKey(base),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      ...(snapshot.pending ? { pending: snapshot.pending } : {}),
    } satisfies SavedUpgrade)
  );
}

const statusCode = (error: unknown) => {
  const value = error as { response?: { status?: number }; status?: number };
  return value?.response?.status ?? value?.status;
};
const locksUpgrade = (pending: PendingUpgrade | null) =>
  !!pending &&
  (!pending.job || isUpgradeRunning(pending.job) || pending.job.state === 'manual_recovery');
const isDefiniteRejection = (error: unknown) => {
  const status = statusCode(error);
  return !!status && status >= 400 && status < 500 && status !== 408 && status !== 429;
};

export function useHostUpgrades(managerBase: string, available: boolean, refreshSignal?: number) {
  const base = normalizeUsageServiceBase(managerBase);
  const key = useAuthStore((s) => s.managementKey);
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const demo = __DEMO_SITE__ && isDemoMode();
  const [snapshot, setSnapshot] = useState<UpgradeSnapshot>(() => restore(base));
  const state = useRef(snapshot);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const update = useCallback((next: UpgradeSnapshot) => {
    state.current = next;
    setSnapshot(next);
  }, []);

  const rejectSubmission = useCallback(
    (error: unknown) => {
      const next: UpgradeSnapshot = {
        ...state.current,
        pending: null,
        reconnecting: false,
        error: 'rejected',
        rejectionStatus: statusCode(error),
      };
      update(next);
      try {
        persist(base, next);
      } catch {
        update({ ...next, error: 'storage' });
      }
    },
    [base, update]
  );

  const refresh = useCallback(async () => {
    if (!base || !authenticated || !key || demo || inFlight.current) return;
    const currentGeneration = generation.current;
    inFlight.current = true;
    const current = () => currentGeneration === generation.current;
    try {
      const catalog = await hostUpgradeApi.releases(base, key);
      if (!current()) return;
      let pending = state.current.pending;
      if (catalog.activeJob) {
        pending = {
          requestId: catalog.activeJob.id,
          component: catalog.activeJob.component,
          releaseId: catalog.activeJob.releaseId,
          job: catalog.activeJob,
        };
      }
      let next: UpgradeSnapshot = {
        ...state.current,
        catalog,
        // A restarting Manager can temporarily report upgrades disabled. Keep
        // the persisted task visible and polling until its outcome is known.
        enabled: catalog.enabled || !!pending,
        resolved: true,
        pending,
        reconnecting: !!pending && !catalog.enabled,
        error: state.current.error === 'rejected' && !catalog.activeJob ? 'rejected' : null,
      };
      update(next);
      if (pending) {
        try {
          const job = await hostUpgradeApi.job(base, key, pending.requestId);
          if (!current()) return;
          pending = { ...pending, job };
        } catch (error) {
          if (statusCode(error) !== 404 || pending.job || !catalog.enabled) throw error;
          // A POST response can be lost during a restart. Retry the persisted
          // intent with the same UUID; the host makes this operation idempotent.
          let job: HostUpgradeJob;
          try {
            job = await hostUpgradeApi.submit(base, key, {
              requestId: pending.requestId,
              component: pending.component,
              releaseId: pending.releaseId,
            });
          } catch (submitError) {
            if (current() && isDefiniteRejection(submitError)) {
              rejectSubmission(submitError);
              return;
            }
            throw submitError;
          }
          if (!current()) return;
          pending = { ...pending, job };
        }
        next = { ...next, pending };
        update(next);
      }
      try {
        persist(base, next);
      } catch {
        update({ ...next, error: 'storage' });
      }
    } catch (error) {
      if (!current()) return;
      // The catalog may be temporarily unavailable while the durable job
      // endpoint still works (for example when the host executor is offline).
      const pending = state.current.pending;
      if (pending) {
        try {
          const job = await hostUpgradeApi.job(base, key, pending.requestId);
          if (!current()) return;
          const next = { ...state.current, pending: { ...pending, job } };
          update(next);
          try {
            persist(base, next);
          } catch {
            /* Keep tracking the durable job. */
          }
        } catch {
          /* An unavailable endpoint must not invent a failed job. */
        }
        if (!current()) return;
      }
      const unsupported =
        statusCode(error) === 404 && !state.current.enabled && !state.current.pending;
      update({
        ...state.current,
        resolved: unsupported || state.current.resolved,
        reconnecting: !unsupported,
        error: unsupported ? null : 'request',
      });
    } finally {
      if (current()) inFlight.current = false;
    }
  }, [authenticated, base, demo, key, rejectSubmission, update]);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    update(restore(base));
    void refresh();
    const timer = window.setInterval(() => {
      if (state.current.pending || state.current.enabled || !state.current.resolved) void refresh();
    }, 3_000);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [base, refresh, refreshSignal, update]);

  const successfulJobId =
    snapshot.pending?.job?.state === 'succeeded' && snapshot.catalog && !snapshot.catalog.activeJob
      ? snapshot.pending.requestId
      : null;
  useEffect(() => {
    if (!successfulJobId) return;
    const timer = window.setTimeout(() => {
      const current = state.current;
      if (
        current.pending?.requestId !== successfulJobId ||
        current.pending.job?.state !== 'succeeded' ||
        !current.catalog ||
        current.catalog.activeJob
      )
        return;
      const next = { ...current, pending: null };
      try {
        persist(base, next);
      } catch {
        update({ ...current, error: 'storage' });
        return;
      }
      // A poll started before dismissal must not restore the completed task.
      generation.current += 1;
      inFlight.current = false;
      update(next);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [base, successfulJobId, update]);

  const start = useCallback(
    async (release: HostUpgradeRelease) => {
      const previous = state.current;
      if (
        !available ||
        !authenticated ||
        !key ||
        demo ||
        !previous.catalog?.enabled ||
        !previous.catalog.executorOnline ||
        previous.reconnecting ||
        locksUpgrade(previous.pending) ||
        !samePreparedRelease(release, selectPreparedRelease(previous.catalog, release.component))
      )
        return;
      const pending: PendingUpgrade = {
        component: release.component,
        releaseId: release.releaseId,
        requestId: crypto.randomUUID(),
      };
      const next = { ...previous, pending, error: null, rejectionStatus: undefined };
      // Persist the intent before any network mutation so refresh/retries cannot
      // create another job when the first response is unavailable.
      try {
        persist(base, next);
      } catch {
        update({ ...previous, error: 'storage' });
        return;
      }
      // Confirmation takes priority over a background read. Invalidate that
      // response rather than silently dropping the user's confirmed action.
      const currentGeneration = ++generation.current;
      update(next);
      inFlight.current = true;
      try {
        const job = await hostUpgradeApi.submit(base, key, pending);
        if (currentGeneration !== generation.current) return;
        const accepted = { ...state.current, pending: { ...pending, job }, reconnecting: false };
        update(accepted);
        try {
          persist(base, accepted);
        } catch {
          update({ ...accepted, error: 'storage' });
        }
      } catch (error) {
        if (currentGeneration === generation.current) {
          if (isDefiniteRejection(error)) {
            rejectSubmission(error);
            return;
          }
          // Transport failure is not a failed upgrade. Retain the same intent.
          update({ ...state.current, reconnecting: true, error: 'request' });
        }
      } finally {
        if (currentGeneration === generation.current) inFlight.current = false;
      }
    },
    [authenticated, available, base, demo, key, rejectSubmission, update]
  );

  return {
    ...snapshot,
    job: snapshot.pending?.job || null,
    busy: locksUpgrade(snapshot.pending) || !!snapshot.catalog?.activeJob,
    canStart:
      available &&
      authenticated &&
      !demo &&
      !!snapshot.catalog?.enabled &&
      snapshot.catalog.executorOnline &&
      !snapshot.reconnecting &&
      snapshot.error !== 'storage',
    refresh,
    start,
  };
}

export type HostUpgrades = ReturnType<typeof useHostUpgrades>;

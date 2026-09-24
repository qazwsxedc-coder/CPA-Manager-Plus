import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/stores';
import { isDemoMode } from '@/features/demo/demoMode';
import { normalizeUsageServiceBase } from '@/services/api/usageService';
import { hostUpgradeApi } from './hostUpgradeApi';
import type { HostUpdateCheck } from './hostUpgradeModel';

const running = (check: HostUpdateCheck | null) =>
  check?.state === 'queued' || check?.state === 'running';

// Reading the durable status never starts a check. Only the click handler below
// sends a request, so a reload or a lost response cannot repeat an upstream query.
export function useHostUpdateCheck(managerBase: string, enabled: boolean, allowed: boolean) {
  const base = normalizeUsageServiceBase(managerBase);
  const key = useAuthStore((s) => s.managementKey);
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const active = enabled && !!base && authenticated && !!key && !(__DEMO_SITE__ && isDemoMode());
  const [check, setCheck] = useState<HostUpdateCheck | null>(null);
  const [resolved, setResolved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);
  const currentCheck = useRef(check);
  const posting = useRef(false);
  const reading = useRef(false);
  const generation = useRef(0);
  const sequence = useRef(0);
  const uncertainRequest = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!active || posting.current || reading.current) return;
    const request = ++sequence.current;
    const current = generation.current;
    reading.current = true;
    try {
      const next = await hostUpgradeApi.currentCheck(base, key);
      if (current !== generation.current || request !== sequence.current) return;
      currentCheck.current = next;
      setCheck(next);
      setResolved(true);
      if (!uncertainRequest.current || next?.id === uncertainRequest.current || running(next)) {
        uncertainRequest.current = null;
        setError(false);
      }
    } catch {
      if (current === generation.current && request === sequence.current) setError(true);
    } finally {
      if (current === generation.current) reading.current = false;
    }
  }, [active, base, key]);

  useEffect(() => {
    generation.current += 1;
    reading.current = false;
    posting.current = false;
    currentCheck.current = null;
    uncertainRequest.current = null;
    setCheck(null);
    setResolved(false);
    setSubmitting(false);
    setError(false);
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [active, refresh]);

  const start = useCallback(async () => {
    if (!active || !allowed || !resolved || posting.current || running(currentCheck.current))
      return;
    posting.current = true;
    sequence.current += 1;
    const current = generation.current;
    const requestId = crypto.randomUUID();
    uncertainRequest.current = requestId;
    setSubmitting(true);
    setError(false);
    try {
      const next = await hostUpgradeApi.check(base, key, requestId);
      if (current !== generation.current) return;
      uncertainRequest.current = null;
      currentCheck.current = next;
      setCheck(next);
    } catch {
      if (current === generation.current) setError(true);
      // Keep reading /current to recover a request accepted before a lost
      // response; never resubmit automatically.
    } finally {
      if (current === generation.current) {
        posting.current = false;
        setSubmitting(false);
        void refresh();
      }
    }
  }, [active, allowed, base, key, refresh, resolved]);

  return {
    check,
    error,
    checking: submitting || running(check),
    canCheck: active && allowed && resolved && !submitting && !running(check),
    start,
  };
}

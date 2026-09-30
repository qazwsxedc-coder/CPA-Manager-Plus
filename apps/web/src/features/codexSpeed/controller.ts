import { parse } from 'yaml';
import { areJsonLikeValuesEqual } from '@/utils/compare';
import type { NativeCodexSpeedSnapshot } from '@/services/api/nativeCodexSpeed';
import { inspectCodexSpeedConfig, updateCodexSpeedConfig, type CodexSpeedMode } from './config';

export type CodexNativeSpeedState = {
  status: 'loading' | 'disabled' | 'unavailable' | 'pending' | 'synced' | 'drift' | 'error';
  mode: CodexSpeedMode | null;
  requestId: string | null;
};

export type CodexSpeedState = {
  status: 'loading' | 'ready' | 'saving' | 'conflict' | 'error' | 'unknown' | 'disconnected';
  mode: CodexSpeedMode | null;
  error: 'read_failed' | 'changed' | 'unconfirmed' | null;
  needsMigration?: boolean;
  native?: CodexNativeSpeedState;
};

export type CodexSpeedIO = {
  read: () => Promise<string>;
  write: (yaml: string) => Promise<void>;
  isCurrent: () => boolean;
  refreshConfig: () => Promise<void>;
  readNative?: () => Promise<NativeCodexSpeedSnapshot>;
  writeNative?: (mode: CodexSpeedMode) => Promise<NativeCodexSpeedSnapshot>;
};

export class CodexSpeedController {
  private state: CodexSpeedState;
  private source: string | null = null;
  private listeners = new Set<() => void>();
  private active = true;
  private busy = false;
  private generation = 0;
  private nativeReading = false;

  constructor(
    private io: CodexSpeedIO,
    connected = true
  ) {
    this.state = {
      status: connected ? 'loading' : 'disconnected',
      mode: null,
      error: null,
      ...(io.readNative
        ? { native: { status: 'loading', mode: null, requestId: null } as const }
        : {}),
    };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(state: CodexSpeedState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  private current(generation: number) {
    return this.active && this.generation === generation && this.io.isCurrent();
  }

  private accept(source: string) {
    const inspection = inspectCodexSpeedConfig(source);
    const native =
      this.state.native?.status === 'synced' && this.state.native.mode !== inspection.mode
        ? { ...this.state.native, status: 'drift' as const }
        : this.state.native;
    this.source = inspection.conflict ? null : source;
    this.publish({
      status: inspection.conflict ? 'conflict' : 'ready',
      mode: inspection.mode,
      error: null,
      ...(native ? { native } : {}),
      ...(inspection.needsMigration ? { needsMigration: true } : {}),
    });
  }

  private fail(error: NonNullable<CodexSpeedState['error']>) {
    this.source = null;
    this.publish({
      status: error === 'unconfirmed' ? 'unknown' : 'error',
      mode: null,
      error,
      ...(this.state.native ? { native: this.unconfirmedNative() } : {}),
    });
  }

  private unconfirmedNative() {
    const native = this.state.native;
    return native?.status === 'synced' ? { ...native, status: 'loading' as const } : native;
  }

  private acceptNative(snapshot: NativeCodexSpeedSnapshot) {
    const status =
      snapshot.state === 'disabled'
        ? 'disabled'
        : snapshot.state === 'error'
          ? 'error'
          : snapshot.state === 'pending'
            ? 'pending'
            : !snapshot.available || snapshot.state === 'unavailable'
              ? 'unavailable'
              : this.state.mode !== null && snapshot.mode === this.state.mode
                ? 'synced'
                : 'drift';
    this.publish({
      ...this.state,
      native: { status, mode: snapshot.mode, requestId: snapshot.requestId },
    });
  }

  private failNative() {
    // Host paths and API error details must never be exposed through UI state.
    this.publish({
      ...this.state,
      native: {
        status: 'error',
        mode: this.state.native?.mode ?? null,
        requestId: this.state.native?.requestId ?? null,
      },
    });
  }

  nativeTimedOut() {
    if (!this.active || !this.io.isCurrent() || this.state.native?.status !== 'pending')
      return true;
    // A CPA refresh/save must finish first. Keep the timeout timer alive so the
    // pending result can still become retryable when that operation completes.
    if (this.busy) return false;
    // Invalidate a slow polling response so it cannot replace the explicit timeout.
    this.generation += 1;
    this.failNative();
    return true;
  }

  async refreshNative() {
    if (
      this.busy ||
      this.nativeReading ||
      !this.active ||
      !this.io.isCurrent() ||
      !this.io.readNative
    )
      return;
    this.nativeReading = true;
    const generation = this.generation;
    try {
      const snapshot = await this.io.readNative();
      if (this.current(generation)) this.acceptNative(snapshot);
    } catch {
      if (this.current(generation)) this.failNative();
    } finally {
      this.nativeReading = false;
    }
  }

  private async syncNative(mode: CodexSpeedMode, generation: number) {
    if (
      !this.io.writeNative ||
      this.state.native?.status === 'disabled' ||
      !this.current(generation)
    )
      return;
    this.publish({
      ...this.state,
      status: 'saving',
      native: {
        status: 'pending',
        mode: this.state.native?.mode ?? null,
        requestId: this.state.native?.requestId ?? null,
      },
    });
    try {
      const snapshot = await this.io.writeNative(mode);
      if (this.current(generation)) this.acceptNative(snapshot);
    } catch {
      if (this.current(generation)) this.failNative();
    } finally {
      if (this.current(generation)) this.publish({ ...this.state, status: 'ready' });
    }
  }

  activate() {
    this.active = true;
  }

  deactivate() {
    this.active = false;
    this.generation += 1;
    this.busy = false;
    this.nativeReading = false;
    this.source = null;
  }

  async refresh() {
    if (this.busy || !this.active || !this.io.isCurrent()) return;
    this.busy = true;
    const generation = ++this.generation;
    this.publish({
      ...this.state,
      status: 'loading',
      mode: null,
      error: null,
      ...(this.state.native ? { native: this.unconfirmedNative() } : {}),
    });
    try {
      const [source, native] = await Promise.allSettled([this.io.read(), this.io.readNative?.()]);
      if (!this.current(generation)) return;
      if (source.status === 'fulfilled') this.accept(source.value);
      else this.fail('read_failed');
      if (this.io.readNative) {
        if (native.status === 'fulfilled' && native.value) this.acceptNative(native.value);
        else this.failNative();
      }
    } finally {
      if (this.generation === generation) this.busy = false;
    }
  }

  async select(mode: CodexSpeedMode) {
    if (
      this.busy ||
      this.state.status !== 'ready' ||
      this.source === null ||
      (mode === this.state.mode &&
        !this.state.needsMigration &&
        (!this.io.writeNative ||
          this.state.native?.status === 'synced' ||
          this.state.native?.status === 'disabled' ||
          this.state.native?.status === 'pending')) ||
      !this.active ||
      !this.io.isCurrent()
    )
      return;
    this.busy = true;
    const generation = ++this.generation;
    const baseline = this.source;
    let attemptedWrite = false;
    this.publish({ ...this.state, status: 'saving' });
    try {
      const fresh = await this.io.read();
      if (!this.current(generation)) return;
      if (fresh !== baseline) {
        if (inspectCodexSpeedConfig(fresh).conflict) this.accept(fresh);
        else this.fail('changed');
        return;
      }
      if (mode === this.state.mode && !this.state.needsMigration) {
        // A native drift retry must still verify the CPA baseline before writing the host request.
        this.accept(fresh);
        await this.syncNative(mode, generation);
        return;
      }
      const next = updateCodexSpeedConfig(fresh, mode);
      // This detects concurrent edits, but the server has no atomic If-Match support.
      const prewrite = await this.io.read();
      if (!this.current(generation)) return;
      if (prewrite !== fresh) {
        if (inspectCodexSpeedConfig(prewrite).conflict) this.accept(prewrite);
        else this.fail('changed');
        return;
      }
      attemptedWrite = true;
      await this.io.write(next);
      if (!this.current(generation)) return;
      const saved = await this.io.read();
      if (!this.current(generation)) return;
      const inspection = inspectCodexSpeedConfig(saved);
      if (
        inspection.conflict ||
        inspection.needsMigration ||
        inspection.mode !== mode ||
        !areJsonLikeValuesEqual(
          parse(saved, { intAsBigInt: true }),
          parse(next, { intAsBigInt: true })
        )
      ) {
        this.fail('unconfirmed');
        return;
      }
      // Readback confirms persistence. A secondary cache refresh cannot undo that evidence.
      await this.io.refreshConfig().catch(() => {});
      if (this.current(generation)) {
        this.accept(saved);
        await this.syncNative(mode, generation);
      }
    } catch {
      if (this.current(generation)) this.fail(attemptedWrite ? 'unconfirmed' : 'read_failed');
    } finally {
      if (this.generation === generation) this.busy = false;
    }
  }
}

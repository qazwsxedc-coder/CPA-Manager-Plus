import { parse } from 'yaml';
import { areJsonLikeValuesEqual } from '@/utils/compare';
import { inspectCodexSpeedConfig, updateCodexSpeedConfig, type CodexSpeedMode } from './config';

export type CodexSpeedState = {
  status: 'loading' | 'ready' | 'saving' | 'conflict' | 'error' | 'unknown' | 'disconnected';
  mode: CodexSpeedMode | null;
  error: 'read_failed' | 'changed' | 'unconfirmed' | null;
  needsMigration?: boolean;
};

export type CodexSpeedIO = {
  read: () => Promise<string>;
  write: (yaml: string) => Promise<void>;
  isCurrent: () => boolean;
  refreshConfig: () => Promise<void>;
};

export class CodexSpeedController {
  private state: CodexSpeedState;
  private source: string | null = null;
  private listeners = new Set<() => void>();
  private active = true;
  private busy = false;
  private generation = 0;

  constructor(
    private io: CodexSpeedIO,
    connected = true
  ) {
    this.state = { status: connected ? 'loading' : 'disconnected', mode: null, error: null };
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
    this.source = inspection.conflict ? null : source;
    this.publish({
      status: inspection.conflict ? 'conflict' : 'ready',
      mode: inspection.mode,
      error: null,
      ...(inspection.needsMigration ? { needsMigration: true } : {}),
    });
  }

  private fail(error: NonNullable<CodexSpeedState['error']>) {
    this.source = null;
    this.publish({ status: error === 'unconfirmed' ? 'unknown' : 'error', mode: null, error });
  }

  activate() {
    this.active = true;
  }

  deactivate() {
    this.active = false;
    this.generation += 1;
    this.busy = false;
    this.source = null;
  }

  async refresh() {
    if (this.busy || !this.active || !this.io.isCurrent()) return;
    this.busy = true;
    const generation = ++this.generation;
    this.publish({ status: 'loading', mode: null, error: null });
    try {
      const source = await this.io.read();
      if (this.current(generation)) this.accept(source);
    } catch {
      if (this.current(generation)) this.fail('read_failed');
    } finally {
      if (this.generation === generation) this.busy = false;
    }
  }

  async select(mode: CodexSpeedMode) {
    if (
      this.busy ||
      this.state.status !== 'ready' ||
      this.source === null ||
      (mode === this.state.mode && !this.state.needsMigration) ||
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
      if (this.current(generation)) this.accept(saved);
    } catch {
      if (this.current(generation)) this.fail(attemptedWrite ? 'unconfirmed' : 'read_failed');
    } finally {
      if (this.generation === generation) this.busy = false;
    }
  }
}

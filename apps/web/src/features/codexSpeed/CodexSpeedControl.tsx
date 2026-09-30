import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCodexSpeed } from './useCodexSpeed';
import type { CodexSpeedMode } from './config';
import styles from './CodexSpeedControl.module.scss';

const modes: CodexSpeedMode[] = ['standard', 'fast'];

export function CodexSpeedControl({ refreshSignal }: { refreshSignal: number }) {
  const { t } = useTranslation();
  const { state, select, refresh } = useCodexSpeed(refreshSignal);
  const id = useId();
  const busy = state.status === 'loading' || state.status === 'saving';
  const disabled = state.status !== 'ready';
  const message =
    state.error ||
    (state.status === 'ready' ? (state.needsMigration ? 'migration_hint' : null) : state.status);
  const native = state.native;
  const showNativeStatus = native && !['synced', 'disabled'].includes(native.status);
  const canRetryNative =
    state.status === 'ready' &&
    state.mode &&
    native &&
    (native.status === 'drift' || native.status === 'error' || native.status === 'unavailable');

  return (
    <div className={styles.root} aria-busy={busy}>
      <fieldset className={styles.fieldset} aria-describedby={message ? `${id}-status` : undefined}>
        <legend>{t('codex_speed.label')}</legend>
        <div className={styles.segments}>
          {modes.map((mode) => (
            <label key={mode} className={styles.option}>
              <input
                type="radio"
                name={id}
                value={mode}
                checked={state.mode === mode}
                disabled={disabled}
                onChange={() => select(mode)}
              />
              <span>{t(`codex_speed.${mode}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {message && (
        <div
          className={`${styles.status} ${state.error || state.status === 'conflict' ? styles.warning : ''}`}
          id={`${id}-status`}
          role="status"
          aria-live="polite"
        >
          {t(`codex_speed.${message}`)}
          {state.status === 'ready' && state.needsMigration && state.mode && (
            <button type="button" onClick={() => select(state.mode!)}>
              {t('codex_speed.migrate')}
            </button>
          )}
          {state.status === 'conflict' && <Link to="/config">{t('codex_speed.open_config')}</Link>}
          {state.error && (
            <button type="button" onClick={refresh}>
              {t('common.refresh')}
            </button>
          )}
        </div>
      )}
      {native && showNativeStatus && (state.status === 'ready' || state.status === 'saving') && (
        <div
          className={`${styles.status} ${['drift', 'error', 'unavailable'].includes(native.status) ? styles.warning : ''}`}
          role="status"
          aria-live="polite"
        >
          {t(`codex_speed.native_${native.status}`)}
          {canRetryNative && (
            <button type="button" onClick={() => select(state.mode!)}>
              {t('codex_speed.native_retry')}
            </button>
          )}
          {native.status === 'pending' && (
            <button type="button" onClick={refresh}>
              {t('common.refresh')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

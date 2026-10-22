/** 激活状态订阅：主进程是唯一状态源，这里只镜像快照并转发操作。 */
import { useCallback, useEffect, useState } from 'react';
import type { ActivationOperationResult, ActivationSnapshot } from '@dramaclip/protocol';
import { activationApi } from '../../services/client';

export interface ActivationView {
  /** null = 首次状态尚未取回；之后的变更都来自主进程广播。 */
  snapshot: ActivationSnapshot | null;
  busy: boolean;
  /** 最近一次操作的失败原因（已由主进程转成可读文案）。 */
  error: string;
  redeem: (code: string) => Promise<boolean>;
  unbind: () => Promise<void>;
  recheck: () => Promise<void>;
  clearError: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 订阅 activation:changed，并在挂载时主动取一次当前状态。 */
export function useActivation(): ActivationView {
  const [snapshot, setSnapshot] = useState<ActivationSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    const unsubscribe = activationApi.onChange((next) => {
      if (!disposed) setSnapshot(next);
    });
    activationApi
      .status(false)
      .then((next) => {
        if (!disposed) setSnapshot(next);
      })
      .catch((reason: unknown) => {
        if (!disposed) setError(errorText(reason));
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const apply = useCallback(async (action: () => Promise<ActivationOperationResult>): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      const result = await action();
      setSnapshot(result.snapshot);
      if (!result.ok) {
        setError(result.message ?? '激活操作失败，请稍后重试');
        return false;
      }
      return true;
    } catch (reason: unknown) {
      setError(errorText(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const redeem = useCallback(
    (code: string): Promise<boolean> => apply(() => activationApi.redeem(code)),
    [apply],
  );

  const unbind = useCallback(async (): Promise<void> => {
    await apply(() => activationApi.unbind());
  }, [apply]);

  const recheck = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      setSnapshot(await activationApi.status(true));
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => {
    setError('');
  }, []);

  return { snapshot, busy, error, redeem, unbind, recheck, clearError };
}

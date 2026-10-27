import type { Level } from '@centinela/shared';
import { createContext, useContext } from 'react';

export interface Toast {
  id: number;
  title: string;
  description?: string;
  level?: Level;
  href?: string;
  linkLabel?: string;
  /** An action failed: announced at once (`role="alert"`) and marked with a red edge. */
  tone?: 'error';
}

export interface ToastApi {
  push: (toast: Omit<Toast, 'id'>) => void;
}

export const TOAST_TIMEOUT_MS = 8000;

export const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function useToasts(): ToastApi {
  return useContext(ToastContext);
}

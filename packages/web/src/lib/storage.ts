/**
 * localStorage access that never throws: storage can be unavailable (private mode, blocked
 * site data, previews). Values read back are untrusted and validated by the caller.
 */
export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the value lasts for this page load only.
  }
}

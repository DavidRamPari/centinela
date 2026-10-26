/**
 * A rule uses a construct the engine does not support (ARCHITECTURE §5.5). The rule is
 * skipped and `code` (plus `detail`) becomes its `unsupportedReason`.
 */
export class UnsupportedRuleError extends Error {
  readonly code: string;
  readonly detail: string | null;

  constructor(code: string, detail: string | null = null) {
    super(detail === null ? code : `${code} (${detail})`);
    this.name = 'UnsupportedRuleError';
    this.code = code;
    this.detail = detail;
  }

  /** `code`, or `code (detail)`: the text stored in `RuleMeta.unsupportedReason`. */
  get reason(): string {
    return this.message;
  }
}

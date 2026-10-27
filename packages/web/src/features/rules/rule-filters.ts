/** Rule list filters, read from and written to the URL (ARCHITECTURE §11). */
import {
  LEVELS,
  RULE_ORIGINS,
  techniqueIdSchema,
  type Level,
  type RuleOrigin,
} from '@centinela/shared';
import type { QueryParams } from '../../api/client';
import { readListParam, readTextParam } from '../../lib/search-params';

export interface RuleFilters {
  q: string | undefined;
  technique: string | undefined;
  level: Level[];
  origin: RuleOrigin | undefined;
  supported: 'true' | 'false' | undefined;
  enabled: 'true' | 'false' | undefined;
}

const BOOLEANS = ['true', 'false'] as const;

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

export function readRuleFilters(params: URLSearchParams): RuleFilters {
  const technique = techniqueIdSchema.safeParse(readTextParam(params, 'technique')?.toUpperCase());
  return {
    q: readTextParam(params, 'q'),
    technique: technique.success ? technique.data : undefined,
    level: readListParam(params, 'level', LEVELS),
    origin: oneOf(params.get('origin'), RULE_ORIGINS),
    supported: oneOf(params.get('supported'), BOOLEANS),
    enabled: oneOf(params.get('enabled'), BOOLEANS),
  };
}

export function ruleQueryParams(filters: RuleFilters): QueryParams {
  return { ...filters, limit: 50 };
}

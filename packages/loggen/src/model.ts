/** Types shared by the generator modules and its consumers (tests, the S4 end-to-end test). */
import type { SourceType } from '@centinela/shared';

export const LINUX_HOSTS = ['bastion-01', 'web-01', 'web-02', 'db-01'] as const;
export type LinuxHost = (typeof LINUX_HOSTS)[number];
/** Windows workstations with Sysmon (S5). */
export const WINDOWS_HOSTS = ['ws-0142', 'ws-0187'] as const;
export type WindowsHost = (typeof WINDOWS_HOSTS)[number];
export const HOSTS = [...LINUX_HOSTS, ...WINDOWS_HOSTS] as const;
export type Host = (typeof HOSTS)[number];
export const WEB_HOSTS: readonly Host[] = ['web-01', 'web-02'];

export type LogFile = 'auth' | 'access' | 'sysmon';

/** File name inside `<out>/<host>/`. */
export const FILE_NAMES: Record<LogFile, string> = {
  auth: 'auth.log',
  access: 'access.log',
  sysmon: 'sysmon.jsonl',
};

/** The `source` to ingest each file with (`npm run ingest -- --source ...`). */
export const FILE_SOURCES: Record<LogFile, SourceType> = {
  auth: 'linux_auth',
  access: 'nginx_access',
  sysmon: 'sysmon',
};

export interface GeneratedLine {
  host: Host;
  file: LogFile;
  /** Event time in epoch microseconds (auth.log timestamps carry microseconds). */
  tsUs: number;
  text: string;
  /** Scenario id, or null for background traffic. */
  scenario: string | null;
}

export interface ScenarioTruth {
  id: string;
  host: Host;
  techniques: string[];
  /** ISO 8601 (UTC): the first and the last line of the scenario. */
  start: string;
  end: string;
  entities: { ips: string[]; users: string[] };
  /**
   * Rules that must alert: `name` for Centinela rules (ARCHITECTURE §6.1), file name
   * without `.yml` for SigmaHQ rules.
   */
  expected: string[];
}

export interface GroundTruth {
  seed: number;
  start: string;
  days: number;
  small: boolean;
  scenarios: ScenarioTruth[];
}

export interface GeneratorOptions {
  seed: number;
  days: number;
  /** First instant of background traffic (epoch ms). */
  startMs: number;
  /** Background traffic only in a window around each scenario. */
  small: boolean;
}

/** A half-open time range [fromMs, toMs). */
export interface Interval {
  fromMs: number;
  toMs: number;
}

/** Types shared by the generator modules and its consumers (tests, the S4 end-to-end test). */

export const HOSTS = ['bastion-01', 'web-01', 'web-02', 'db-01'] as const;
export type Host = (typeof HOSTS)[number];
export const WEB_HOSTS: readonly Host[] = ['web-01', 'web-02'];

export type LogFile = 'auth' | 'access';

/** File name inside `<out>/<host>/`. */
export const FILE_NAMES: Record<LogFile, string> = { auth: 'auth.log', access: 'access.log' };

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

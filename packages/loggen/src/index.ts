/** Public API of the generator, for tests and the end-to-end detection test (S4). */
export {
  DEFAULT_DAYS,
  DEFAULT_SEED,
  DEFAULT_START,
  generate,
  groundTruthJson,
  type GeneratedFile,
  type GenerationResult,
} from './generate.js';
export * from './model.js';
export { SCENARIOS } from './scenarios.js';

/**
 * The two JSON shapes a Sysmon line may take (ARCHITECTURE §4.4), validated with zod:
 *
 * - nested, as Windows event exports and SigmaHQ's regression samples write it:
 *   `{"Event": {"System": {"EventID": 1, "Computer": "...", "TimeCreated":
 *   {"#attributes": {"SystemTime": "..."}}}, "EventData": {"Image": "...", ...}}}`;
 * - flat: `{"EventID": 1, "Computer": "...", "UtcTime": "...", "Image": "...", ...}`.
 *
 * Only the envelope is typed; event data stays a record of unknown values and is turned
 * into fields in `fields.ts`. zod's records drop `__proto__` keys, so attacker-chosen
 * keys cannot reach an object's prototype.
 */
import { z } from 'zod';

const MAX_EVENT_ID = 65_535;

/**
 * `1`, `"1"` or, in some XML-to-JSON converters, `{"#text": "1", "#attributes": {...}}`.
 */
const eventIdValueSchema = z.union([
  z.number().int().min(0).max(MAX_EVENT_ID),
  z
    .string()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .pipe(z.number().max(MAX_EVENT_ID)),
]);
export const eventIdSchema = z.union([
  eventIdValueSchema,
  z.object({ '#text': eventIdValueSchema }).transform((value) => value['#text']),
]);

export const dataSchema = z.record(z.string(), z.unknown());
export type EventDataRecord = z.infer<typeof dataSchema>;

const attributesOf = <T extends z.ZodType>(attributes: T) =>
  z.object({ '#attributes': attributes.optional() }).optional();

export const nestedEventSchema = z.object({
  Event: z.object({
    System: z.object({
      Provider: attributesOf(z.object({ Name: z.string().optional() })),
      EventID: eventIdSchema,
      Computer: z.string().optional(),
      TimeCreated: attributesOf(z.object({ SystemTime: z.string().optional() })),
    }),
    // Events without data carry `null` or an empty element in some exports.
    EventData: dataSchema.nullish(),
  }),
});
export type NestedEvent = z.infer<typeof nestedEventSchema>;

/** The flat shape's envelope; every key of the object (these included) is event data. */
export const flatEnvelopeSchema = z.object({
  EventID: eventIdSchema,
  Computer: z.string().optional(),
  TimeCreated: z.string().optional(),
  ProviderName: z.string().optional(),
  Channel: z.string().optional(),
});
export type FlatEnvelope = z.infer<typeof flatEnvelopeSchema>;

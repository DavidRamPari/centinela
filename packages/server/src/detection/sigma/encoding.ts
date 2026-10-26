/**
 * Encoding modifiers (ARCHITECTURE §5.3): `utf16le`/`wide`, `utf16be`, `utf16`, `base64`
 * and `base64offset`. A UTF-16 encoder turns text into bytes; base64 turns bytes (or the
 * UTF-8 bytes of text) back into text. Bytes travel as a string of code units 0–255
 * (`binary: true`), the form pySigma gives a wide string that is matched without base64.
 */

export interface EncodedValue {
  text: string;
  /** Every code unit of `text` is one byte. */
  binary: boolean;
}

function bytesOf(value: EncodedValue): Buffer {
  return Buffer.from(value.text, value.binary ? 'latin1' : 'utf8');
}

function utf16(text: string, order: 'le' | 'be', bom: boolean): EncodedValue {
  const bytes: number[] = bom ? [0xff, 0xfe] : [];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    const low = unit & 0xff;
    const high = unit >> 8;
    if (order === 'le') bytes.push(low, high);
    else bytes.push(high, low);
  }
  return { text: String.fromCharCode(...bytes), binary: true };
}

/** `|utf16le` / `|wide`. */
export const encodeUtf16le = (value: EncodedValue) => utf16(value.text, 'le', false);
/** `|utf16be`. */
export const encodeUtf16be = (value: EncodedValue) => utf16(value.text, 'be', false);
/** `|utf16`: byte order mark followed by little-endian code units (Python's `utf-16`). */
export const encodeUtf16 = (value: EncodedValue) => utf16(value.text, 'le', true);

/** `|base64`: the standard base64 encoding. */
export function encodeBase64(value: EncodedValue): string {
  return bytesOf(value).toString('base64');
}

const OFFSET_STARTS = [0, 2, 3] as const;
const OFFSET_ENDS = [undefined, -3, -2] as const;

/**
 * `|base64offset` (pySigma): the value as it appears inside a longer base64 string at each
 * of the three byte alignments. The characters that depend on the surrounding bytes are
 * cut off, so each variant can be searched for as a substring.
 */
export function encodeBase64Offsets(value: EncodedValue): string[] {
  const bytes = bytesOf(value);
  return [0, 1, 2].map((shift) => {
    const encoded = Buffer.concat([Buffer.alloc(shift, 0x20), bytes]).toString('base64');
    const start = OFFSET_STARTS[shift] ?? 0;
    const end = OFFSET_ENDS[(bytes.length + shift) % 3];
    return encoded.slice(start, end);
  });
}

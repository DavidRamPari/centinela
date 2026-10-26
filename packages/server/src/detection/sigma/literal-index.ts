/**
 * Multi-pattern matching for the literal patterns that make up most of SigmaHQ's rules:
 * `v` (equals), `v*` (prefix), `*v` (suffix) and `*v*` (substring), case-insensitive.
 *
 * Per field, every such literal of the rule set is indexed once: a map for equality, a
 * trie for prefixes, a trie of reversed literals for suffixes and an Aho–Corasick automaton
 * for substrings. For an event, each field value is scanned once (time linear in the value
 * plus the matches, whatever the number of rules), and every rule's check becomes a set
 * lookup. A Windows process-creation event otherwise costs thousands of `includes` calls.
 */
import { UnsupportedRuleError } from '../errors.js';

export type LiteralShape = 'equals' | 'prefix' | 'suffix' | 'contains';

interface TrieNode {
  next: Map<number, TrieNode>;
  ids: number[];
}

function trieNode(): TrieNode {
  return { next: new Map(), ids: [] };
}

function trieAdd(root: TrieNode, literal: string, id: number, reversed: boolean): void {
  let node = root;
  for (let k = 0; k < literal.length; k += 1) {
    const code = literal.charCodeAt(reversed ? literal.length - 1 - k : k);
    let child = node.next.get(code);
    if (!child) {
      child = trieNode();
      node.next.set(code, child);
    }
    node = child;
  }
  node.ids.push(id);
}

function trieWalk(root: TrieNode, value: string, reversed: boolean, out: Set<number>): void {
  let node: TrieNode | undefined = root;
  for (let k = 0; k < value.length && node; k += 1) {
    node = node.next.get(value.charCodeAt(reversed ? value.length - 1 - k : k));
    if (node) for (const id of node.ids) out.add(id);
  }
}

/** Aho–Corasick automaton over UTF-16 code units. Node 0 is the root. */
class SubstringAutomaton {
  private readonly next: Array<Map<number, number>> = [new Map<number, number>()];
  private readonly fail: number[] = [0];
  private readonly out: number[][] = [[]];
  private built = false;

  get size(): number {
    return this.next.length - 1;
  }

  add(literal: string, id: number): void {
    let node = 0;
    for (let k = 0; k < literal.length; k += 1) {
      const code = literal.charCodeAt(k);
      const edges = this.next[node] as Map<number, number>;
      let child = edges.get(code);
      if (child === undefined) {
        child = this.next.length;
        this.next.push(new Map());
        this.fail.push(0);
        this.out.push([]);
        edges.set(code, child);
      }
      node = child;
    }
    (this.out[node] as number[]).push(id);
    this.built = false;
  }

  /** Failure links by breadth-first search; outputs include those of the failure chain. */
  build(): void {
    const queue: number[] = [];
    for (const child of (this.next[0] as Map<number, number>).values()) {
      this.fail[child] = 0;
      queue.push(child);
    }
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head] as number;
      for (const [code, child] of this.next[node] as Map<number, number>) {
        let fallback = this.fail[node] as number;
        while (fallback !== 0 && !(this.next[fallback] as Map<number, number>).has(code)) {
          fallback = this.fail[fallback] as number;
        }
        const target = (this.next[fallback] as Map<number, number>).get(code) ?? 0;
        this.fail[child] = target === child ? 0 : target;
        const inherited = this.out[target === child ? 0 : target] as number[];
        if (inherited.length > 0)
          this.out[child] = [...(this.out[child] as number[]), ...inherited];
        queue.push(child);
      }
    }
    this.built = true;
  }

  search(value: string, found: Set<number>): void {
    if (!this.built) this.build();
    let node = 0;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      let edges = this.next[node] as Map<number, number>;
      while (node !== 0 && !edges.has(code)) {
        node = this.fail[node] as number;
        edges = this.next[node] as Map<number, number>;
      }
      node = edges.get(code) ?? 0;
      const ids = this.out[node] as number[];
      for (let k = 0; k < ids.length; k += 1) found.add(ids[k] as number);
    }
  }
}

class FieldLiterals {
  readonly equals = new Map<string, number>();
  readonly prefix = trieNode();
  readonly suffix = trieNode();
  readonly contains = new SubstringAutomaton();
  hasPrefix = false;
  hasSuffix = false;

  match(value: string): Set<number> {
    const found = new Set<number>();
    const equal = this.equals.get(value);
    if (equal !== undefined) found.add(equal);
    if (this.hasPrefix) trieWalk(this.prefix, value, false, found);
    if (this.hasSuffix) trieWalk(this.suffix, value, true, found);
    if (this.contains.size > 0) this.contains.search(value, found);
    return found;
  }
}

/** Literal patterns of one rule set, by field slot (`-1` is `message`). */
export interface LiteralField {
  slot: number;
  /** Field name; null for `message`. */
  field: string | null;
}

export class LiteralIndex {
  private readonly fields = new Map<number, FieldLiterals>();
  private readonly ids = new Map<string, number>();
  private readonly owners: LiteralField[] = [];

  /** Number of distinct literals registered. */
  get size(): number {
    return this.ids.size;
  }

  /**
   * Register a lower-cased, non-empty literal for a field; the same literal and shape on
   * the same field get the same id.
   */
  register(slot: number, field: string | null, shape: LiteralShape, literal: string): number {
    if (literal === '') throw new UnsupportedRuleError('detection:empty-literal');
    const key = `${slot}\u0000${shape}\u0000${literal}`;
    const existing = this.ids.get(key);
    if (existing !== undefined) return existing;
    const id = this.ids.size;
    this.ids.set(key, id);
    this.owners.push({ slot, field });
    let literals = this.fields.get(slot);
    if (!literals) {
      literals = new FieldLiterals();
      this.fields.set(slot, literals);
    }
    switch (shape) {
      case 'equals':
        literals.equals.set(literal, id);
        break;
      case 'prefix':
        trieAdd(literals.prefix, literal, id, false);
        literals.hasPrefix = true;
        break;
      case 'suffix':
        trieAdd(literals.suffix, literal, id, true);
        literals.hasSuffix = true;
        break;
      case 'contains':
        literals.contains.add(literal, id);
        break;
    }
    return id;
  }

  /** The field a literal id belongs to. */
  fieldOf(id: number): LiteralField | undefined {
    return this.owners[id];
  }

  /** Ids of every literal of the field that the lower-cased value matches. */
  match(slot: number, value: string): ReadonlySet<number> {
    return this.fields.get(slot)?.match(value) ?? EMPTY;
  }
}

const EMPTY: ReadonlySet<number> = new Set();

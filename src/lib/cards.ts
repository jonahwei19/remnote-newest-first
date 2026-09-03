import { RNPlugin } from '@remnote/plugin-sdk';
// The SDK does not export its Card class from the package root, so derive the
// shape from a method that returns one. `card.getAll` throws at runtime in
// current RemNote builds, but it is still in the typings, and this is a type.
export type CardLike = Awaited<ReturnType<RNPlugin['card']['getAll']>>[number];

/**
 * Whether a rich-text field is fully captured by its plain-text rendering.
 * - `plain`     every element is a bare string; the rendering loses nothing.
 * - `formatted` every element is plain *text*, but some carry bold/italic/etc;
 *               the rendering keeps the words and drops the styling.
 * - `false`     the field contains something plain text cannot hold: a rem
 *               reference, a cloze, an image, latex, audio. The text shown for
 *               such a card is an approximation, and callers say so.
 *
 * The write path this classification used to gate is gone; it now only labels
 * results. It stays fail-closed anyway: anything not proven safe reads `false`.
 */
export type Editability = 'plain' | 'formatted' | false;

export interface CardRecord {
  cardId: string;
  remId: string;
  type: 'forward' | 'backward' | 'cloze';
  clozeId?: string;
  front: string;
  back: string;
  /** The card's ancestors, outermost first, joined with ' › '. Empty for a
   * top-level rem. Rendered locally from the rems the enumeration already holds,
   * so it costs no SDK call. */
  context: string;
  /** The rem's parent id, straight off the SDK object the scan already holds.
   * An apply create targeting this card's siblings passes it as parentRemId. */
  parentId?: string;
  frontEditable: Editability;
  backEditable: Editability;
  frontHash: string;
  backHash: string;
  chars: number;
  nextRepetitionTime?: number;
  lastRepetitionTime?: number;
  timesWrongInRow: number;
  repetitions: number;
  due: boolean;
  /** Always false: the Edit Later powerup needs a per-rem `hasPowerup` call, and
   * the scan does not make one. The `flagged` filter therefore matches nothing. */
  flagged: boolean;
  practiceEnabled: boolean;
  /** Always false: an inherited DisableCards tag needs a walk up the rem tree,
   * which the scan does not do. `active` reflects the per-rem switch only. */
  ancestorDisabled: boolean;
  active: boolean;
  /** Rem timestamps straight off the SDK object the scan already holds. */
  createdAt?: number;
  updatedAt?: number;
}

const CLOZE_KEY = 'cId';

/**
 * Classify a rich-text value for rewrite safety. Anything not proven safe is
 * reported as not editable ‒ the default has to fail closed, because the cost
 * of being wrong is a silently destroyed rem reference or cloze.
 */
export function classify(rich: unknown): Editability {
  if (rich == null) return 'plain';
  if (!Array.isArray(rich)) return false;
  let formatted = false;
  for (const el of rich) {
    if (typeof el === 'string') continue;
    if (el == null || typeof el !== 'object') return false;
    const item = el as Record<string, unknown>;
    if (item.i !== 'm') return false;
    if (item[CLOZE_KEY] !== undefined) return false;
    if (item.workInProgressTag || item.workInProgressRem || item.workInProgressPortal) return false;
    formatted = true;
  }
  return formatted ? 'formatted' : 'plain';
}

export function cardTypeOf(card: CardLike): { type: CardRecord['type']; clozeId?: string } {
  const t = card.type as unknown;
  if (typeof t === 'object' && t != null && 'clozeId' in t) {
    return { type: 'cloze', clozeId: (t as { clozeId: string }).clozeId };
  }
  return { type: t === 'backward' ? 'backward' : 'forward' };
}

/**
 * Render a rich-text array to plain text WITHOUT any SDK call. `richText.toString`
 * is a per-rem host RPC that RemNote serializes, so calling it across a large KB
 * is infeasible; the element shapes are simple enough to flatten locally.
 * Rem references (`i:'q'`) are resolved against `map` (the rems we already hold),
 * with a depth cap and the element's own text as a fallback.
 * Element census on a real 41k-rem KB: bare strings; `{i:'m',text,...}` formatted
 * (clozes are these with a `cId`); `{i:'q',_id,aliasId}` references; `{i:'i'}`
 * images; `{i:'x'}` latex.
 */
export function renderRich(rich: unknown, map: Map<string, any>, depth = 0): string {
  if (rich == null) return '';
  if (typeof rich === 'string') return rich;
  if (!Array.isArray(rich)) return '';
  const out: string[] = [];
  for (const el of rich) {
    if (typeof el === 'string') {
      out.push(el);
      continue;
    }
    if (!el || typeof el !== 'object') continue;
    const item = el as Record<string, any>;
    switch (item.i) {
      case 'm':
        if (typeof item.text === 'string') out.push(item.text);
        break;
      case 'q':
      case 'r': {
        if (depth < 3 && item._id) {
          const ref = map.get(item._id);
          if (ref) {
            const t = renderRich(ref.text, map, depth + 1);
            if (t) {
              out.push(t);
              break;
            }
          }
        }
        if (typeof item.text === 'string') out.push(item.text);
        break;
      }
      case 'x':
        if (typeof item.text === 'string') out.push(item.text);
        break;
      case 'i':
        break;
      default:
        if (typeof item.text === 'string') out.push(item.text);
    }
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** A rem generates cards if it has a back, contains a cloze, or has children that
 * can serve as answers. 100% recall against a 5k getCards sample; the false
 * positives (structural parents) are removed by the getCards pass that follows. */
export function looksLikeCard(rem: any): boolean {
  const hasBack = Array.isArray(rem.backText) && rem.backText.length > 0;
  const hasCloze =
    Array.isArray(rem.text) &&
    rem.text.some((e: any) => e && typeof e === 'object' && e.cId !== undefined);
  const hasChildren = Array.isArray(rem.children) && rem.children.length > 0;
  return hasBack || hasCloze || hasChildren;
}

export interface CardFilter {
  query?: string;
  activeOnly?: boolean;
  /** Keep only cards with a non-empty repetition history, i.e. ones actually practised. */
  reviewedOnly?: boolean;
  due?: boolean;
  leech?: boolean;
  flagged?: boolean;
  longerThan?: number;
  type?: CardRecord['type'];
}

export function matches(rec: CardRecord, f: CardFilter, leechThreshold: number): boolean {
  if (f.type && rec.type !== f.type) return false;
  if (f.activeOnly && !rec.active) return false;
  if (f.reviewedOnly && rec.repetitions === 0) return false;
  if (f.due && !rec.due) return false;
  if (f.leech && rec.timesWrongInRow < leechThreshold) return false;
  if (f.flagged && !rec.flagged) return false;
  if (f.longerThan != null && rec.chars <= f.longerThan) return false;
  if (f.query) {
    const q = f.query.toLowerCase();
    if (!rec.front.toLowerCase().includes(q) && !rec.back.toLowerCase().includes(q)) return false;
  }
  return true;
}

/** Run `fn` over `items` with bounded concurrency, so a large KB does not flood the plugin bridge. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

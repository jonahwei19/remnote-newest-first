/**
 * Which card of a rem the newest-first widget shows, and how.
 *
 * This is separated from the widget so it can be tested without a browser or a
 * live RemNote. It is the part Jonah actually looks at on screen, so it earns
 * its own tests instead of a screenshot.
 *
 * Background: a plugin queue item is rendered by a SpacedRepetitionBase subclass
 * whose renderCard/renderAnswer return null and whose question/answerRichText
 * return [] (RemNote 1.28.0, 33576.js:8310). We inherit the native shell and
 * must supply the body. RemNote's own card types are
 * 'forward' | 'backward' | {clozeId} (SDK interfaces.d.ts:897).
 *
 * Clozes: a cloze card's question is the rem text with one span hidden, and its
 * answer is the same text with that span shown. Cloze spans are ordinary inline
 * rich-text elements carrying `cId` (RICH_TEXT_FORMATTING.CLOZE, interfaces.d.ts
 * :929), so both sides can be built locally. Image-occlusion clozes live inside
 * image elements, not inline; a card whose cloze id has no inline span is not
 * renderable and is never chosen, so it can never leak its answer.
 */

export type CardDir = 'forward' | 'backward' | 'cloze';

export interface CardLike {
  _id?: string;
  /** 'forward' | 'backward' | { clozeId } */
  type?: unknown;
}

export interface RemLike {
  text?: unknown;
  backText?: unknown;
}

export interface Renderable {
  cardId: string;
  dir: CardDir;
  front: unknown;
  back: unknown;
  /** Ancestor path as plain text, e.g. "Philosophy › Tentative › Ch3" */
  breadcrumb?: string;
  /** For a cloze card: the cloze this card tests. */
  clozeId?: string;
  /** For a cloze card: the rem's back text, shown under the answer as RemNote does. */
  extra?: unknown;
}

const CLOZE_KEY = 'cId';
const HINT_KEY = 'cloze-hint';
/** Inline element kinds a cloze span can be: text, latex, rem reference. */
const INLINE_KINDS = new Set(['m', 'x', 'q']);

export function isRenderableType(type: unknown): type is 'forward' | 'backward' {
  return type === 'forward' || type === 'backward';
}

/** The cloze id a card type names, when the card is a cloze card. */
export function clozeIdOf(type: unknown): string | undefined {
  if (type && typeof type === 'object') {
    const id = (type as { clozeId?: unknown }).clozeId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

function isSpanOf(el: unknown, clozeId: string): boolean {
  return !!el && typeof el === 'object' && (el as Record<string, unknown>)[CLOZE_KEY] === clozeId;
}

/**
 * True when the rem text carries at least one inline span for this cloze. Only
 * then can a question be built that hides the answer.
 */
export function hasClozeElement(text: unknown, clozeId: string): boolean {
  if (!Array.isArray(text) || !clozeId) return false;
  return text.some((el) => isSpanOf(el, clozeId) && INLINE_KINDS.has((el as { i?: string }).i ?? ''));
}

/** The element without its cloze marks, so other clozes read as plain text. */
function stripCloze(el: unknown): unknown {
  if (!el || typeof el !== 'object') return el;
  const rec = el as Record<string, unknown>;
  if (rec[CLOZE_KEY] === undefined && rec[HINT_KEY] === undefined) return el;
  const { [CLOZE_KEY]: _c, [HINT_KEY]: _h, ...rest } = rec;
  return rest;
}

/** The question side: this cloze's spans replaced by one placeholder (the hint if there is one). */
export function hideCloze(text: unknown, clozeId: string): unknown[] {
  if (!Array.isArray(text)) return [];
  const out: unknown[] = [];
  let hiding = false;
  for (const el of text) {
    if (isSpanOf(el, clozeId)) {
      if (!hiding) {
        const hint = (el as Record<string, unknown>)[HINT_KEY];
        const label = typeof hint === 'string' && hint.trim() ? hint.trim() : '...';
        out.push({ i: 'm', text: `[${label}]`, b: true });
        hiding = true;
      }
      continue;
    }
    hiding = false;
    out.push(stripCloze(el));
  }
  return out;
}

/** The answer side: this cloze's spans shown, emphasised; other clozes as plain text. */
export function revealCloze(text: unknown, clozeId: string): unknown[] {
  if (!Array.isArray(text)) return [];
  return text.map((el) => {
    const plain = stripCloze(el);
    if (!isSpanOf(el, clozeId)) return plain;
    if (plain && typeof plain === 'object' && (plain as { i?: string }).i === 'm') {
      return { ...(plain as Record<string, unknown>), b: true, u: true };
    }
    return plain;
  });
}

function nonEmpty(rich: unknown): boolean {
  return Array.isArray(rich) && rich.length > 0;
}

/**
 * Pick the card to render. `preferCardId` is the card RemNote is actually
 * showing (the widget context's cardId), so a rem with several cards renders
 * the one that was served rather than the first one found.
 *
 * Direction matters: a backward card asks the back and answers with the front.
 * Getting this the wrong way round would be invisible in a screenshot and wrong
 * in practice, which is exactly the sort of thing a test should hold down.
 */
export function pickRenderable(
  rem: RemLike | undefined,
  cards: CardLike[],
  preferCardId?: string,
): Renderable | null {
  if (!rem || !Array.isArray(cards)) return null;
  const ordered = preferCardId
    ? [...cards.filter((c) => c?._id === preferCardId), ...cards.filter((c) => c?._id !== preferCardId)]
    : cards;
  for (const card of ordered) {
    const id = card?._id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (isRenderableType(card?.type)) {
      const forward = card.type === 'forward';
      return {
        cardId: id,
        dir: card.type,
        front: forward ? rem.text : rem.backText,
        back: forward ? rem.backText : rem.text,
      };
    }
    const clozeId = clozeIdOf(card?.type);
    if (clozeId && hasClozeElement(rem.text, clozeId)) {
      return {
        cardId: id,
        dir: 'cloze',
        clozeId,
        front: hideCloze(rem.text, clozeId),
        back: revealCloze(rem.text, clozeId),
        ...(nonEmpty(rem.backText) ? { extra: rem.backText } : {}),
      };
    }
  }
  return null;
}

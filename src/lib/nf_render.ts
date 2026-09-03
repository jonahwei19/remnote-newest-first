/**
 * Which card of a rem the newest-first widget shows, and which way round.
 *
 * This is separated from the widget so it can be tested without a browser or a
 * live RemNote. It is the part Jonah actually looks at on screen, and it is the
 * part this session could not verify against his knowledge base, so it earns its
 * own tests instead.
 *
 * Background: a plugin queue item is rendered by a SpacedRepetitionBase subclass
 * whose renderCard/renderAnswer return null and whose question/answerRichText
 * return [] (RemNote 1.28.0, 33576.js:8310). We inherit the native shell and
 * must supply the body. RemNote's own card types are
 * 'forward' | 'backward' | {clozeId} (SDK interfaces.d.ts:897).
 */

export type CardDir = 'forward' | 'backward';

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
}

export function isRenderableType(type: unknown): type is CardDir {
  return type === 'forward' || type === 'backward';
}

/**
 * Pick the first card we can render faithfully.
 *
 * A cloze is deliberately never chosen: we draw from rem.text / rem.backText, and
 * a cloze's text contains its own answer, so rendering one that way would show
 * the answer with the question. Returning null makes the widget offer a Skip
 * rather than silently showing a wrong card.
 *
 * Direction matters: a backward card asks the back and answers with the front.
 * Getting this the wrong way round would be invisible in a screenshot and wrong
 * in practice, which is exactly the sort of thing a test should hold down.
 */
export function pickRenderable(rem: RemLike | undefined, cards: CardLike[]): Renderable | null {
  if (!rem || !Array.isArray(cards)) return null;
  for (const card of cards) {
    if (!isRenderableType(card?.type)) continue;
    const id = card?._id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const forward = card.type === 'forward';
    return {
      cardId: id,
      dir: card.type,
      front: forward ? rem.text : rem.backText,
      back: forward ? rem.backText : rem.text,
    };
  }
  return null;
}

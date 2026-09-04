import { RNPlugin } from '@remnote/plugin-sdk';
import { clozeIdOf } from './nf_render';

/**
 * The queue's "b" on a newest-first item: Enable/Disable Flashcard.
 *
 * RemNote's own "b" (QueuePracticeCurrentDirection, default "b",
 * FullAppBootstrap~2.js:47591) turns off practice for the direction the
 * current card tests. A plugin queue item is rendered by a base class whose
 * edit/disable hooks are empty (33576.js:8199), so on our items the key does
 * nothing natively; this is the same action, done through the SDK.
 *
 * - forward / backward card: that direction is switched off; the other
 *   direction, if any, keeps practising.
 * - cloze card: there is no per-cloze switch in the SDK, so practice is
 *   switched off for the whole rem (RemNote's Disable Cards powerup).
 *
 * This is the only file allowed to call setPracticeDirection /
 * setEnablePractice (test/logic.test.mjs OWNED_MUTATORS). It never deletes.
 */
export type DisableOutcome =
  | { done: true; what: string }
  | { done: false; why: string };

export async function disableServedCard(
  plugin: RNPlugin,
  remId: string,
  cardId: string | undefined,
): Promise<DisableOutcome> {
  const rem: any = await plugin.rem.findOne(remId);
  if (!rem) return { done: false, why: 'rem not found' };
  let type: unknown;
  if (cardId) {
    const card: any = await plugin.card.findOne(cardId).catch(() => undefined);
    type = card?.type ?? (await card?.getType?.().catch(() => undefined));
  }
  if (type === 'forward' || type === 'backward') {
    let current: string = 'both';
    try {
      current = await rem.getPracticeDirection();
    } catch {}
    const next =
      current === 'both' ? (type === 'forward' ? 'backward' : 'forward') : 'none';
    await rem.setPracticeDirection(next as any);
    return { done: true, what: next === 'none' ? 'Practice disabled for this rem' : `${type} direction disabled` };
  }
  if (clozeIdOf(type)) {
    await rem.setEnablePractice(false);
    return { done: true, what: 'Practice disabled for this rem (all its clozes)' };
  }
  await rem.setEnablePractice(false);
  return { done: true, what: 'Practice disabled for this rem' };
}

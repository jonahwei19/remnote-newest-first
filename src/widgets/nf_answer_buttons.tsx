import {
  QueueInteractionScore,
  WidgetLocation,
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useCallback, useState } from 'react';
import '../style.css';
import '../index.css';

/**
 * The answer-buttons half of a newest-first queue item.
 *
 * Incremental Everything registers BOTH a Flashcard-location widget and a
 * FlashcardAnswerButtons-location widget for its plugin items, with identical
 * options. This plugin registered only the Flashcard one, and RemNote 1.28.0's
 * pane-layout recursion then threw `Cannot read properties of undefined
 * (reading 'first')` under every injected item (P2_EVIDENCE/CRASH_ANALYSIS.md):
 * the layout tree for a plugin item has a slot for this widget, and an empty
 * slot is an undefined node. So this widget exists first to make the layout
 * whole, and second to grade.
 *
 * Grading goes through card.updateCardRepetitionStatus, RemNote's own
 * scheduler entry point (verified live 2026-08-16), on the one card the item
 * showed, then advances the queue. Never invents an interval.
 */

class NfButtonsBoundary extends React.Component<{ plugin: any; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="rb-nf-card__buttons">
          <button onClick={() => void this.props.plugin.queue.removeCurrentCardFromQueue(true)}>Skip this card</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function NewestFirstAnswerButtons() {
  const plugin = usePlugin();
  const [grading, setGrading] = useState(false);

  const ctx = useTrackerPlugin(
    async (rp) => await rp.widget.getWidgetContext<WidgetLocation.FlashcardAnswerButtons>(),
    [],
  );
  const remId = (ctx as any)?.remId as string | undefined;
  const cardId = (ctx as any)?.cardId as string | undefined;

  const grade = useCallback(
    async (score: QueueInteractionScore) => {
      if (grading) return;
      setGrading(true);
      // Native path first: with cardId on the item, RemNote's own answerCard
      // grades and advances (45827.js:5703). Fall back to manual grading only
      // if the queue is still sitting on our item afterwards.
      let nativelyHandled = false;
      if (cardId) {
        try {
          await plugin.queue.rateCurrentCard(score);
          await new Promise((r) => setTimeout(r, 450));
          const still = await plugin.widget.getWidgetContext<WidgetLocation.FlashcardAnswerButtons>().catch(() => undefined);
          nativelyHandled = !still || (still as any)?.remId !== remId;
        } catch {}
      }
      if (nativelyHandled) {
        setGrading(false);
        return;
      }
      try {
        let card: any = cardId ? await plugin.card.findOne(cardId) : undefined;
        if (!card && remId) {
          // Fall back to the rem's first forward/backward card ‒ the same pick
          // nf_flashcard.tsx renders (never a cloze; those are never injected).
          const rem = await plugin.rem.findOne(remId);
          const cards = ((await rem?.getCards()) ?? []) as any[];
          for (const c of cards) {
            const t = c.type ?? (await c.getType?.().catch(() => undefined));
            if (t === 'forward' || t === 'backward') {
              card = c;
              break;
            }
          }
        }
        await card?.updateCardRepetitionStatus(score);
      } catch {}
      try {
        await plugin.queue.removeCurrentCardFromQueue(true);
      } catch {}
      setGrading(false);
    },
    [plugin, cardId, remId, grading],
  );

  return (
    <div className="rb-nf-card__buttons" data-testid="rb-nf-answer-buttons">
      <button disabled={grading} onClick={() => void plugin.queue.removeCurrentCardFromQueue(true)}>Skip</button>
      <button disabled={grading} onClick={() => void grade(QueueInteractionScore.AGAIN)}>Forgot</button>
      <button disabled={grading} onClick={() => void grade(QueueInteractionScore.HARD)}>Partially recalled</button>
      <button disabled={grading} onClick={() => void grade(QueueInteractionScore.GOOD)}>Recalled with effort</button>
      <button disabled={grading} onClick={() => void grade(QueueInteractionScore.EASY)}>Easily recalled</button>
    </div>
  );
}

function Wrapped() {
  const plugin = usePlugin();
  return (
    <NfButtonsBoundary plugin={plugin}>
      <NewestFirstAnswerButtons />
    </NfButtonsBoundary>
  );
}

renderWidget(Wrapped);

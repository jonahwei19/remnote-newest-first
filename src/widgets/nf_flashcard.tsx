import {
  AppEvents,
  RichText,
  WidgetLocation,
  renderWidget,
  useAPIEventListener,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { disableServedCard } from '../lib/nf_actions';
import { Renderable, pickRenderable } from '../lib/nf_render';
import '../style.css';
import '../index.css';

const STORAGE_KEY = 'rb-nf-cache-v1';
/**
 * Keys RemNote's queue binds natively but that are dead on a plugin item,
 * because the plugin item base class has empty edit/disable hooks
 * (33576.js:8199): "e" = Edit Flashcard Now (QueueEditNow), "b" =
 * Enable/Disable Flashcard (QueuePracticeCurrentDirection). Stolen only while
 * this widget is mounted, i.e. only while one of OUR items is up; every native
 * card keeps its native keys. Released while the edit popup is open so they
 * can be typed there.
 */
const STOLEN_KEYS = ['e', 'b'];

/**
 * The plugin's own id, which is the listener key RemNote emits StealKeyEvent
 * under: `stealKeys(pluginHost.pluginId, keys)` (FullAppBootstrap~2.js:31023)
 * and `dispatchEvent(StealKeyEvent, thatId, {key})` (:80056). A listener
 * registered under any other key never hears the keystroke. Read from the
 * widget iframe's own URL so the same file works in this plugin and in the
 * marketplace build, whose id differs.
 */
function pluginId(): string | undefined {
  try {
    return new URLSearchParams(window.location.search).get('pluginId') ?? undefined;
  } catch {
    return undefined;
  }
}

class NfErrorBoundary extends React.Component<
  { plugin: any; children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    try {
      const { plugin } = this.props;
      void plugin.storage.getSynced(STORAGE_KEY).then((stored: any) => {
        const patch = { ...(stored ?? {}), lastError: msg.slice(0, 500), lastErrorAt: Date.now() };
        void plugin.storage.setSynced(STORAGE_KEY, patch).catch(() => {});
      });
    } catch {}
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rb-nf-card rb-nf-card--error">
          <div className="rb-nf-card__badge">newest first — error</div>
          <p>Widget error: {this.state.error}</p>
          <button onClick={() => {
            try { void this.props.plugin.queue.removeCurrentCardFromQueue(true); } catch {}
          }}>Skip this card</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * The card body for a newest-first item, and ‒ more importantly ‒ the reason
 * `GetNextCard` runs at all.
 *
 * RemNote only polls plugins for a next card if the plugin host has at least
 * one widget registered at `WidgetLocation.Flashcard`:
 *
 *     let r = pluginHosts.filter(h => h.registeredWidgets.some(w => w.location === WidgetLocation.Flashcard));
 *     if (0 === r.length) return;
 *
 * (RemNote 1.28.0, beautified 33576.js:1355 ‒ MECHANICS.md §1.) This repo
 * registered widgets only at RightSidebar and Pane, so that filter was always
 * empty and the callback was never called. That is the whole of the two-week
 * mystery: `remq nfcache` reporting calls=0 was accurate all along.
 *
 * Registering this widget opens the gate. It is registered with
 * `queueItemTypeFilter: QueueItemType.Plugin`, and RemNote compares that against
 * the current queue item's QueueType at render time (FullAppBootstrap~2.js:29246,
 * 45827.js:4014), so it matches ONLY the items we inject. Every ordinary card in
 * Jonah's queue still renders through RemNote's own `componentToRenderIfNoWidgets`
 * fallback (45827.js:4015), unchanged. Opening the gate costs him nothing visually.
 *
 * We have to draw the card because a plugin queue item is rendered by a
 * SpacedRepetitionBase subclass whose renderCard/renderAnswer return null and
 * whose question/answerRichText return [] (33576.js:8310). We inherit the native
 * shell ‒ progress, timing, keyboard ‒ with an empty body.
 *
 * Scope, deliberately narrow: newest_first.ts only ever serves rems whose cards
 * are plain forward/backward pairs, never clozes, because a cloze rendered with
 * RichText would show its own answer. Cloze rems stay in the list for the other
 * two surfaces; they are simply not injected here. See `servableViaGetNextCard`.
 *
 * Note on awaits: the "no host round trips" rule in newest_first.ts applies to
 * the GetNextCard callback, which RemNote calls with a 1000 ms budget while
 * holding its answer loop (33576.js:1361). This widget is ordinary React and
 * may await freely.
 */

function NewestFirstCard() {
  const plugin = usePlugin();
  const [revealed, setRevealed] = useState(false);

  // RemNote hands a Flashcard widget {remId, cardId, revealed} ‒ typed in the
  // SDK at interfaces.d.ts:1157, and visibly the same object the app builds at
  // 45827.js:4007. `revealed` tracks the native "show answer", so the native
  // shell and this body stay in step; the local button is only a fallback for
  // when the shell does not drive it.
  const ctx = useTrackerPlugin(
    async (rp) => await rp.widget.getWidgetContext<WidgetLocation.Flashcard>(),
    [],
  );
  const remId = ctx?.remId;
  const cardId = (ctx as any)?.cardId as string | undefined;
  const showAnswer = revealed || ctx?.revealed === true;

  // "e" / "b" on our item (see STOLEN_KEYS).
  const editing = useRef(false);
  useEffect(() => {
    if (!remId) return;
    void plugin.app.stealKeys(STOLEN_KEYS).catch(() => {});
    return () => {
      void plugin.app.releaseKeys(STOLEN_KEYS).catch(() => {});
    };
  }, [plugin, remId]);
  const onStolenKey = useCallback(
    async (data: any) => {
      const key = String(data?.key ?? data?.keyId ?? '').toLowerCase();
      if (!remId || editing.current) return;
      if (key === 'e') {
        editing.current = true;
        await plugin.app.releaseKeys(STOLEN_KEYS).catch(() => {});
        await plugin.widget.openPopup('nf_edit', { remId, cardId });
        return;
      }
      if (key === 'b') {
        const r = await disableServedCard(plugin, remId, cardId);
        await plugin.app.toast(r.done ? `Newest first: ${r.what}` : `Newest first: could not disable (${r.why})`);
        if (r.done) {
          void plugin.messaging.broadcast({ type: 'nf-drop', remId }).catch(() => {});
          await plugin.queue.removeCurrentCardFromQueue(true);
        }
      }
    },
    [plugin, remId, cardId],
  );
  useAPIEventListener(AppEvents.StealKeyEvent, pluginId(), (data: any) => void onStolenKey(data));
  useAPIEventListener(AppEvents.MessageBroadcast, undefined, (data: any) => {
    const msg = data?.message ?? data;
    if (msg?.type === 'nf-edit-closed' && editing.current) {
      editing.current = false;
      if (remId) void plugin.app.stealKeys(STOLEN_KEYS).catch(() => {});
    }
  });

  // Native reveal (space bar / the shell's own control) is tracked by the
  // queue, not pushed to widgets; poll it so the body flips with the shell.
  useEffect(() => {
    let stop = false;
    const t = setInterval(async () => {
      if (stop || revealed) return;
      try {
        if (await plugin.queue.hasRevealedAnswer()) setRevealed(true);
      } catch {}
    }, 200);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [plugin, revealed]);

  // Why a card could not be drawn, so a blank card is diagnosable from the
  // screen instead of only from a screenshot. Guest lab 2026-09-04.
  const [why, setWhy] = useState<string | null>(null);

  const shown = useRunAsync(async (): Promise<Renderable | null | undefined> => {
    if (!remId) return undefined;
    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        setWhy(`rem ${remId} not found`);
        return null;
      }
      const cards = (await rem.getCards()) ?? [];
      const withTypes = await Promise.all(
        (cards as any[]).map(async (c) => ({ _id: c._id, type: c.type ?? (await c.getType?.()) })),
      );
      // Render the card RemNote is showing (the served cardId), not merely the
      // first card of the rem: a rem may have both directions, or several clozes.
      const result = pickRenderable(rem as any, withTypes, cardId);
      if (!result) {
        setWhy(
          withTypes.length === 0
            ? 'this rem has no cards'
            : `no drawable card here (${withTypes.map((c) => (typeof c.type === 'string' ? c.type : 'cloze')).join(', ')})`,
        );
      }
      if (result) {
        const parts: string[] = [];
        let cur: any = rem;
        for (let i = 0; i < 5; i++) {
          const parentId = cur.parent ?? (await cur.getParentRem?.())?._id;
          if (!parentId) break;
          const parent = await plugin.rem.findOne(parentId);
          if (!parent) break;
          const name = (parent as any).text;
          if (Array.isArray(name) && name.length > 0) {
            const plain = name.map((n: any) => (typeof n === 'string' ? n : n?.text ?? '')).join('');
            if (plain) parts.unshift(plain.length > 30 ? plain.slice(0, 29) + '…' : plain);
          }
          cur = parent;
        }
        result.breadcrumb = parts.join(' › ');
      }
      return result;
    } catch (err) {
      setWhy(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [remId, cardId]);

  if (!remId) return <div className="rb-nf-card">Newest first: no rem in widget context.</div>;
  if (shown === undefined) return <div className="rb-nf-card">Loading…</div>;
  if (shown === null) {
    return (
      <div className="rb-nf-card">
        <div className="rb-nf-card__badge">newest first</div>
        <div className="rb-nf-card__question">
          This card could not be drawn here: {why ?? 'unknown reason'}. Skip it, or grade it below to
          put it back on the normal schedule.
        </div>
        <div className="rb-nf-card__buttons">
          <button onClick={() => void plugin.queue.removeCurrentCardFromQueue(true)}>Skip</button>
        </div>
      </div>
    );
  }

  return (
    <div className="rb-nf-card" data-testid="rb-nf-card">
      {shown.breadcrumb && (
        <div className="rb-nf-card__breadcrumb">{shown.breadcrumb}</div>
      )}
      <div className="rb-nf-card__badge">
        newest first{shown.dir === 'backward' ? ' · backward' : shown.dir === 'cloze' ? ' · cloze' : ''}
      </div>
      <div className="rb-nf-card__question">
        <RichText text={(shown.front ?? []) as any} width="100%" />
      </div>
      {showAnswer ? (
        <>
          <hr className="rb-nf-card__rule" />
          <div className="rb-nf-card__answer">
            <RichText text={(shown.back ?? []) as any} width="100%" />
          </div>
          {Array.isArray(shown.extra) && shown.extra.length > 0 && (
            <div className="rb-nf-card__extra">
              <RichText text={shown.extra as any} width="100%" />
            </div>
          )}
        </>
      ) : (
        <button
          className="rb-nf-card__reveal"
          onClick={() => {
            setRevealed(true);
            // Flip the native reveal state too, so the FlashcardAnswerButtons
            // widget (which grades) and this body stay in step.
            void plugin.queue.showAnswer().catch(() => {});
          }}
        >
          Show answer
        </button>
      )}
    </div>
  );
}

function NewestFirstCardWrapped() {
  const plugin = usePlugin();
  return (
    <NfErrorBoundary plugin={plugin}>
      <NewestFirstCard />
    </NfErrorBoundary>
  );
}

renderWidget(NewestFirstCardWrapped);

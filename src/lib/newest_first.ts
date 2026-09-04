import { AppEvents, QueueItemType, RNPlugin, SpecialPluginCallback } from '@remnote/plugin-sdk';
import { looksLikeCard, mapLimit } from './cards';
import { clozeIdOf, hasClozeElement } from './nf_render';
import { contextPath, enumerateRems } from './rpc';

/**
 * Newest-first new cards, via the GetNextCard queue callback.
 *
 * RemNote's scheduler stays in charge of every practiced card. This module
 * intervenes only for never-practiced cards ‒ which are all identically "due
 * now" and would otherwise surface in structure order ‒ and serves them
 * newest-created-first at the front of the global queue. When the list (minus
 * exclusions) is empty, the callback returns null and the queue behaves
 * exactly as if this module did not exist.
 *
 * Architecture, learned the hard way:
 * - The GetNextCard callback makes ZERO host round trips. RemNote may hold its
 *   SDK answer loop while waiting on the callback, so any await in here can
 *   deadlock every plugin SDK call in the app.
 * - There is NO full knowledge-base scan on the practice path. After a RemNote
 *   relaunch the sqlite helper answers getCards at ~1s per call while it
 *   resyncs, so a 13k-rem scan takes an hour and the list would never be ready
 *   when practice starts. Instead the list persists in plugin storage across
 *   reloads, and refreshes incrementally: getCards runs only for rems created
 *   after the stored watermark (typically a handful) plus a bounded stale-check
 *   of the list head.
 * - Scheduler integrity: rating stays native. A rem is served at most once per
 *   pop, a practiced rem is pruned and can never re-enter, and a stale entry
 *   served spuriously is still just a normal card in the normal queue.
 */

const SETTING_NEWEST_FIRST = 'rb-newest-first';
const SETTING_EXCLUDE = 'rb-newest-first-exclude';
const STORAGE_KEY = 'rb-nf-cache-v1';
const PLUGIN_ID = 'newest-first';
const CONCURRENCY = 4;
/** Entering the queue refreshes at most this often. Enumeration is one bulk
 * pass (~2.5 s on a 41k-rem KB); getCards runs only for new rems + the head. */
const REFRESH_MIN_INTERVAL_MS = 20 * 1000;
/** A card load mid-session refreshes at most this often. */
const REFRESH_ON_LOAD_MIN_INTERVAL_MS = 3 * 60 * 1000;
/** How many list-head entries each refresh re-validates against card state. */
const STALE_CHECK_HEAD = 15;
/** A fresh install (no cache yet) validates only this many of the newest card
 * rems, so the first build is bounded even on a large, cold knowledge base.
 * Older never-practised cards stay native until they are edited. */
const INITIAL_BUILD_MAX = 500;
/**
 * The first slice of that build, published before the rest is validated.
 *
 * RemNote asks for a card during a background preload and the callback cannot
 * await, so anything not yet in the list is a `null` answer. On a fresh install
 * the reviewer opened the queue while the first build was still running and saw
 * "asked 2x, served 0" (RemNote review, 2026-09-03); reproduced here on a
 * 41k-rem knowledge base as three empty answers. Publishing the newest few
 * dozen first makes that window a second or two instead of the whole build.
 */
const INITIAL_BUILD_FIRST_SLICE = 40;
/** After one card of a rem is served, its remaining new cards (the other
 * direction, the other clozes) wait this long: you just saw the answer. */
const SIBLING_HOLD_MS = 10 * 60 * 1000;
/**
 * How long a served card waits before it can be served again.
 *
 * A served card is NOT removed from the list. RemNote asks for a next card
 * during a background preload and parks it as `pendingPluginCard`
 * (33576.js:1355-1367); if the session ends before that card is popped, it is
 * simply discarded. Removing it on serve therefore lost cards permanently:
 * they were never practised, and the watermark had moved past them, so no
 * refresh brought them back. Verified in the guest lab 2026-09-04, cloze rem
 * z5GUgTAocNCiuI1Yh: served=1, never displayed, never practised, gone from the
 * list. Now the entry stays and QueueCompleteCard is what removes it, so an
 * undelivered card comes back after this hold.
 */
const SERVE_HOLD_MS = 5 * 60 * 1000;
/** A rem change is checked this long after the last change to that rem. */
const REM_CHANGE_SETTLE_MS = 1500;

/**
 * Substring matches against the card's ancestor path. These always apply, on
 * top of whatever the exclusions setting says: the setting can add fragments
 * but not drop these. 'Chinese › Cards' rather than the full path because on
 * 2026-09-03 that folder was refiled from Future to Past and the full-path
 * fragment silently stopped matching.
 */
const DEFAULT_EXCLUDE = '';

export interface QueueCandidate {
  remId: string;
  createdAt: number;
  /** The rem's card ids, captured when card state is checked. The controlled
   * Queue embed (the "Practice Newest First" pane) needs card ids, not rem ids. */
  cardIds?: string[];
  /**
   * Whether this rem can be injected into the native queue via GetNextCard.
   *
   * A plugin queue item renders with a null native body (33576.js:8310), so the
   * nf_flashcard widget draws the card itself from rem.text / rem.backText. That
   * is faithful for plain forward/backward cards and WRONG for clozes, which
   * would show their own answer. Cloze rems therefore stay in the list ‒ they
   * still count for the tier layer and the pane ‒ but are never injected.
   *
   * Only `true` passes the serve filter. Legacy entries (undefined) and clozes
   * (false) are both excluded — a cloze served raw shows its own answer.
   */
  servable?: boolean;
  /** The next card to serve. Returned as `cardId` so RemNote's plugin item
   * carries a real card: its base class resolves skip/forget/answer from
   * actionItem.cardId (33576.js:7928, 45827.js:5703), which is what makes
   * native keys and native grading work on our item. */
  servableCardId?: string;
  /** Every never-practised card of this rem the widget can draw faithfully, in
   * card order: forward/backward, and clozes whose span is inline in rem.text.
   * Served one at a time; the entry leaves the list when this runs out. */
  servableCardIds?: string[];
  /** Set when one card of this rem was just served and others remain: none of
   * them is served before this time (SIBLING_HOLD_MS). */
  heldUntil?: number;
}

/** The item most recently handed to the queue, for the edit/disable actions. */
export interface ServedItem {
  remId: string;
  cardId?: string;
  servedAt: number;
}

interface CardState {
  unpracticed: boolean;
  cardIds: string[];
  servable: boolean;
  servableCardId?: string;
  servableCardIds: string[];
}

interface StoredCache {
  list: QueueCandidate[];
  /** Highest rem createdAt this cache has already considered. */
  watermark: number;
  savedAt: number;
  lastError?: string;
  lastErrorAt?: number;
}

interface NfState {
  list: QueueCandidate[];
  watermark: number;
  refreshing: boolean;
  lastRefreshAt: number;
  enabled: boolean;
  restored: boolean;
  lastError?: string;
  lastErrorAt?: number;
  current: ServedItem | null;
  /** How the list came to exist: restored from storage, seeded, or built on first run. */
  origin: 'none' | 'restored' | 'seeded' | 'initial-build';
}

/** In-memory telemetry so `remq nfcache` can show whether the queue is even
 * consulting the callback, and on which branch each call exited. */
interface NfStats {
  calls: number;
  served: number;
  lastCallAt: number;
  lastArgs: unknown;
  lastServedRemId: string | null;
  nullBecause: { disabled: number; inOrder: number; subQueue: number; empty: number };
  subQueueIdsSeen: string[];
  /** QueueCompleteCard events RemNote emitted while our items were up ‒ the
   * scheduler-side proof that native grading ran ({score, cardId}). */
  completed: { score: unknown; cardId: unknown; at: number }[];
  /** Rems added straight from a change event, without an enumeration pass. */
  addedOnChange: number;
  /** Cards we served that RemNote reported as answered. */
  completedOurs: number;
}

export interface NfHandle {
  seed: (list: QueueCandidate[], watermark: number) => Promise<{ size: number; watermark: number }>;
  refresh: (force?: boolean) => Promise<{ size: number; watermark: number; added: number; pruned: number }>;
  /** The item most recently served, or null once it completed or the queue closed. */
  current: () => ServedItem | null;
  /** Forget a rem (all its cards): used after the user disables it from the queue. */
  drop: (remId: string) => void;
  snapshot: () => {
    size: number;
    watermark: number;
    head: QueueCandidate[];
    enabled: boolean;
    restored: boolean;
    origin: string;
    current: ServedItem | null;
    stats: NfStats;
    lastError?: string;
    lastErrorAt?: number;
  };
}

/** Cards an entry can still serve, tolerating entries cached before
 * servableCardIds existed (servable + one servableCardId, or servable alone). */
function servableCardsOf(c: QueueCandidate): { cardId?: string; rest: string[] } | null {
  if (Array.isArray(c.servableCardIds)) {
    if (c.servableCardIds.length === 0) return null;
    return { cardId: c.servableCardIds[0], rest: c.servableCardIds.slice(1) };
  }
  if (c.servable === true) return { cardId: c.servableCardId, rest: [] };
  return null;
}

export function installNewestFirst(plugin: RNPlugin, log: (line: string) => void): NfHandle {
  const state: NfState = {
    list: [],
    watermark: 0,
    refreshing: false,
    lastRefreshAt: 0,
    enabled: true,
    restored: false,
    current: null,
    origin: 'none',
  };
  const stats: NfStats = {
    calls: 0,
    served: 0,
    lastCallAt: 0,
    lastArgs: null,
    lastServedRemId: null,
    nullBecause: { disabled: 0, inOrder: 0, subQueue: 0, empty: 0 },
    subQueueIdsSeen: [],
    completed: [],
    addedOnChange: 0,
    completedOurs: 0,
  };

  const persist = () => {
    const stored: StoredCache = { list: state.list, watermark: state.watermark, savedAt: Date.now() };
    void plugin.storage.setSynced(STORAGE_KEY, stored).catch(() => {});
  };

  const restore = async () => {
    try {
      const stored = (await plugin.storage.getSynced(STORAGE_KEY)) as StoredCache | undefined;
      if (stored && Array.isArray(stored.list)) {
        state.list = stored.list.filter((c) => c && typeof c.remId === 'string');
        state.watermark = typeof stored.watermark === 'number' ? stored.watermark : 0;
        if (stored.lastError) state.lastError = stored.lastError;
        if (stored.lastErrorAt) state.lastErrorAt = stored.lastErrorAt;
        if (state.list.length > 0 || state.watermark > 0) state.origin = 'restored';
        log(`newest-first: restored ${state.list.length} rem(s) from storage`);
      }
    } catch {}
    state.restored = true;
  };

  const excludes = async (): Promise<string[]> => {
    let raw = DEFAULT_EXCLUDE;
    try {
      const setting = await plugin.settings.getSetting<string>(SETTING_EXCLUDE);
      if (typeof setting === 'string') raw = `${DEFAULT_EXCLUDE},${setting}`;
    } catch {}
    return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  };

  const remCardState = async (rem: any): Promise<CardState | undefined> => {
    try {
      const cards = (await rem.getCards()) ?? [];
      if (cards.length === 0) return undefined;
      // PluginCardType is 'forward' | 'backward' | {clozeId} (SDK
      // interfaces.d.ts:897). The two directions render from rem.text /
      // rem.backText; a cloze renders from rem.text with its span hidden, which
      // needs that span to be inline (nf_render.hasClozeElement). Anything else
      // (image occlusion) is never served, so it can never leak an answer.
      const servableCardIds: string[] = [];
      let unpracticed = false;
      for (const c of cards as any[]) {
        const id = typeof c._id === 'string' ? c._id : undefined;
        const fresh = (c.repetitionHistory?.length ?? 0) === 0;
        if (fresh) unpracticed = true;
        if (!id || !fresh) continue;
        const t = c.type ?? (await c.getType?.().catch(() => undefined));
        if (t === 'forward' || t === 'backward') {
          servableCardIds.push(id);
          continue;
        }
        const clozeId = clozeIdOf(t);
        if (clozeId && hasClozeElement(rem.text, clozeId)) servableCardIds.push(id);
      }
      return {
        unpracticed,
        cardIds: cards.map((c: any) => c._id).filter((id: unknown) => typeof id === 'string'),
        servable: servableCardIds.length > 0,
        servableCardId: servableCardIds[0],
        servableCardIds,
      };
    } catch {
      return undefined;
    }
  };

  const candidateFrom = (rem: any, cs: CardState): QueueCandidate => ({
    remId: rem._id,
    createdAt: rem.createdAt,
    cardIds: cs.cardIds,
    servable: cs.servable,
    servableCardId: cs.servableCardId,
    servableCardIds: cs.servableCardIds,
  });

  /**
   * A card was answered: it is no longer new. Drop it from its entry, and drop
   * the entry once its last new card is gone. A rem's remaining cards wait
   * SIBLING_HOLD_MS, because their answer was just on screen.
   */
  const completeCard = (cardId: string) => {
    const at = state.list.findIndex((c) => (c.servableCardIds ?? []).includes(cardId) || c.servableCardId === cardId);
    if (at === -1) return;
    const entry = state.list[at];
    const remaining = (entry.servableCardIds ?? (entry.servableCardId ? [entry.servableCardId] : [])).filter(
      (id) => id !== cardId,
    );
    if (remaining.length === 0) {
      state.list.splice(at, 1);
    } else {
      entry.servableCardIds = remaining;
      entry.servableCardId = remaining[0];
      entry.servable = true;
      entry.heldUntil = Date.now() + SIBLING_HOLD_MS;
    }
    stats.completedOurs++;
    persist();
  };

  const insertSorted = (cands: QueueCandidate[]): number => {
    const known = new Set(state.list.map((c) => c.remId));
    const merged = cands.filter((c) => !known.has(c.remId));
    if (merged.length === 0) return 0;
    state.list = [...merged, ...state.list].sort((a, b) => b.createdAt - a.createdAt);
    return merged.length;
  };

  /** Ancestor path via findOne, for a rem checked outside an enumeration pass. */
  const contextPathAlone = async (rem: any): Promise<string> => {
    const map = new Map<string, any>([[rem._id, rem]]);
    let cur = rem;
    for (let i = 0; i < 8 && cur?.parent; i++) {
      const parent = await plugin.rem.findOne(cur.parent).catch(() => undefined);
      if (!parent) break;
      map.set(parent._id, parent);
      cur = parent;
    }
    return contextPath(rem, map);
  };

  /**
   * One rem, checked on its own: the path a just-written card takes into the
   * list, so it is there by the time the queue opens, with no enumeration pass.
   * Never moves the watermark: rems created between this one and the last
   * enumeration are still found by the next refresh.
   */
  const checkOne = async (remId: string) => {
    try {
      const rem: any = await plugin.rem.findOne(remId);
      if (!rem || !looksLikeCard(rem) || typeof rem.createdAt !== 'number') return;
      const cs = await remCardState(rem);
      const existing = state.list.find((c) => c.remId === remId);
      if (!cs || !cs.unpracticed) {
        if (existing && cs && !cs.unpracticed) {
          state.list = state.list.filter((c) => c.remId !== remId);
          persist();
        }
        return;
      }
      if (existing) {
        existing.cardIds = cs.cardIds;
        existing.servable = cs.servable;
        existing.servableCardId = cs.servableCardId;
        existing.servableCardIds = cs.servableCardIds;
        persist();
        return;
      }
      const skip = await excludes();
      const where = await contextPathAlone(rem);
      if (skip.some((s) => where.includes(s))) return;
      try {
        if ((await rem.getEnablePractice()) === false) return;
      } catch {}
      if (insertSorted([candidateFrom(rem, cs)]) > 0) {
        stats.addedOnChange++;
        persist();
      }
    } catch {}
  };

  const pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
  const onRemChanged = (data: any) => {
    const remId = typeof data === 'string' ? data : data?.remId ?? data?._id;
    if (typeof remId !== 'string' || remId.length === 0) return;
    const prior = pendingChanges.get(remId);
    if (prior) clearTimeout(prior);
    pendingChanges.set(
      remId,
      setTimeout(() => {
        pendingChanges.delete(remId);
        void checkOne(remId);
      }, REM_CHANGE_SETTLE_MS),
    );
  };

  /**
   * Incremental refresh: enumerate rems (parent-walk, no per-rem card calls),
   * then confirm card state only for rems newer than the watermark and for the
   * head of the existing list. Bounded work even on a cold, slow database.
   */
  const refresh = async (force = false, minIntervalMs = REFRESH_MIN_INTERVAL_MS) => {
    if (state.refreshing) return summary(0, 0);
    if (!force && Date.now() - state.lastRefreshAt < minIntervalMs) return summary(0, 0);
    state.refreshing = true;
    let added = 0;
    let pruned = 0;
    try {
      const skip = await excludes();
      const { rems, map } = await enumerateRems(plugin);
      const known = new Set(state.list.map((c) => c.remId));

      // A zero watermark means no list has ever been built. Build one from the
      // newest card rems only, so a fresh install is bounded on any KB.
      const initial = state.watermark === 0;
      let fresh = rems.filter(
        (r: any) =>
          looksLikeCard(r) &&
          typeof r.createdAt === 'number' &&
          r.createdAt > state.watermark &&
          !known.has(r._id),
      );
      if (initial) {
        fresh = fresh.sort((a: any, b: any) => b.createdAt - a.createdAt).slice(0, INITIAL_BUILD_MAX);
      }
      // On that first build, publish the newest slice before validating the
      // rest, so the queue has something to serve within a second or two.
      const firstSlice = initial ? fresh.slice(0, INITIAL_BUILD_FIRST_SLICE) : [];
      const rest = initial ? fresh.slice(INITIAL_BUILD_FIRST_SLICE) : fresh;
      const additions: QueueCandidate[] = [];
      const validatedWatermarks: number[] = [];
      const validate = async (rem: any) => {
        const cs = await remCardState(rem);
        if (!cs) return; // failed — do NOT advance watermark past this rem
        validatedWatermarks.push(rem.createdAt);
        if (!cs.unpracticed) return;
        const where = contextPath(rem, map);
        if (skip.some((s) => where.includes(s))) return;
        try {
          if ((await rem.getEnablePractice()) === false) return;
        } catch {}
        additions.push(candidateFrom(rem, cs));
      };
      if (firstSlice.length > 0) {
        await mapLimit(firstSlice, CONCURRENCY, validate);
        // Publish what we have before the rest is validated. The watermark
        // stays where it is until the whole build finishes, so nothing in
        // `rest` is skipped if this is interrupted.
        if (additions.length > 0) {
          added += insertSorted(additions.splice(0, additions.length));
          persist();
          log(`newest-first: first ${added} rem(s) queued, still building`);
        }
      }
      await mapLimit(rest, CONCURRENCY, validate);

      // Re-validate the head of the list so entries practiced elsewhere (a
      // phone session, a doc queue) fall out instead of being served again.
      // A forced refresh validates the whole list, which also backfills
      // cardIds on seeded entries that never had them.
      const head = force ? state.list.slice() : state.list.slice(0, STALE_CHECK_HEAD);
      const stale = new Set<string>();
      await mapLimit(head, CONCURRENCY, async (cand) => {
        const rem = map.get(cand.remId) ?? (await plugin.rem.findOne(cand.remId).catch(() => undefined));
        if (!rem) {
          stale.add(cand.remId);
          return;
        }
        const cs = await remCardState(rem);
        if (!cs) return;
        let disabled = false;
        try {
          disabled = (await rem.getEnablePractice()) === false;
        } catch {}
        // Exclusions are re-checked on the way out, not only on the way in:
        // a folder can be refiled (2026-09-03, Future › Chinese › Cards became
        // Past › Chinese › Cards) or a fragment added to the setting, and cards
        // already listed must then leave rather than linger forever.
        const where = map.has(cand.remId) ? contextPath(rem, map) : await contextPathAlone(rem);
        if (skip.some((f) => where.includes(f))) {
          stale.add(cand.remId);
          return;
        }
        if (!cs.unpracticed || disabled) stale.add(cand.remId);
        else {
          cand.cardIds = cs.cardIds;
          cand.servableCardId = cs.servableCardId;
          cand.servable = cs.servable;
          cand.servableCardIds = cs.servableCardIds;
        }
      });

      if (stale.size > 0) {
        pruned = stale.size;
        state.list = state.list.filter((c) => !stale.has(c.remId));
      }
      if (additions.length > 0) {
        // Re-check against the list as it stands NOW: a seed or a change-event
        // add may have landed while this refresh was scanning, and a pop must
        // stay popped.
        added += insertSorted(additions);
      }
      if (initial && validatedWatermarks.length > 0) state.origin = 'initial-build';
      // Only advance watermark past rems whose card state was actually resolved.
      // If remCardState returned undefined (cold-DB timeout), those rems must be
      // reconsidered on the next refresh — advancing past them would skip them
      // permanently. When no fresh rems existed, validatedWatermarks is empty and
      // the watermark stays put (correct: nothing new to advance past).
      const maxValidated = validatedWatermarks.length > 0
        ? Math.max(...validatedWatermarks)
        : state.watermark;
      state.watermark = maxValidated;
      state.lastRefreshAt = Date.now();
      persist();
      log(`newest-first: refresh +${added} -${pruned}, ${state.list.length} queued, newest first`);
    } catch (err) {
      log(`newest-first: refresh failed ‒ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      state.refreshing = false;
    }
    return summary(added, pruned);
  };

  const summary = (added: number, pruned: number) => ({
    size: state.list.length,
    watermark: state.watermark,
    added,
    pruned,
  });

  plugin.settings.registerBooleanSetting({
    id: SETTING_NEWEST_FIRST,
    title: 'Serve new cards newest-first in the global queue',
    description:
      'When on, never-practiced cards (outside the exclusions) are shown at the front of the global practice queue, newest creation date first. Scheduling of practiced cards is untouched.',
    defaultValue: true,
  });
  plugin.settings.registerStringSetting({
    id: SETTING_EXCLUDE,
    title: 'Newest-first exclusions (comma-separated path fragments)',
    description:
      'A new card whose ancestor path contains any of these fragments is never auto-served (it stays practiceable by hand).',
    defaultValue: DEFAULT_EXCLUDE,
  });

  const refreshEnabledFlag = async () => {
    try {
      state.enabled = ((await plugin.settings.getSetting<boolean>(SETTING_NEWEST_FIRST)) ?? true) as boolean;
    } catch {}
  };

  // Restore instantly on activation, then refresh in the background so the
  // very first practice session of a fresh plugin load is already served.
  // With no cache yet (fresh install) the refresh builds one from the newest
  // INITIAL_BUILD_MAX card rems ‒ bounded, so it finishes even on a large,
  // cold knowledge base ‒ and marks everything older as already considered.
  void (async () => {
    await restore();
    await refreshEnabledFlag();
    if (state.watermark === 0) log(`newest-first: no list yet ‒ building from the newest ${INITIAL_BUILD_MAX} card rems`);
    await refresh(true);
  })();

  /**
   * Listener keys, the two-week bug in one line.
   *
   * The SDK delivers an event only to listeners registered under the key the
   * EMITTER used: `this.listeners[eventId].get(msg.listenerKey)`
   * (plugin-sdk 0.0.46, lib.js). RemNote emits every queue event with
   * `void 0` as the key (45827.js:5715, 33576.js:7934, and QueueEnter/Exit
   * alongside), and GlobalRemChanged likewise (FullAppBootstrap~3.js:9852).
   * These listeners were registered under the string 'rb-newest-first', so
   * NONE of them ever fired: the list never refreshed on entering the queue,
   * and answered cards were never dropped. Verified in the guest lab
   * 2026-09-04 (completed: [] after a full practice session).
   *
   * The key must be `undefined` for these events. StealKeyEvent is the
   * exception: it is emitted under the plugin's own id (FullAppBootstrap~2.js
   * :31023, :80056), which is why nf_flashcard.tsx uses that instead.
   */
  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, (data: any) => {
    stats.completed.push({ score: data?.score, cardId: data?.cardId, at: Date.now() });
    if (stats.completed.length > 20) stats.completed.shift();
    if (state.current && data?.cardId && data.cardId === state.current.cardId) state.current = null;
    if (typeof data?.cardId === 'string') completeCard(data.cardId);
  });

  plugin.event.addListener(AppEvents.QueueEnter, undefined, () => {
    void (async () => {
      await refreshEnabledFlag();
      await refresh();
    })();
  });
  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, () => {
    void refresh(false, REFRESH_ON_LOAD_MIN_INTERVAL_MS);
  });
  plugin.event.addListener(AppEvents.QueueExit, undefined, () => {
    state.current = null;
  });
  // A rem that just changed is checked on its own (settle delay, no enumeration)
  // so a card written a moment before opening the queue is already listed.
  try {
    plugin.event.addListener(AppEvents.GlobalRemChanged, undefined, onRemChanged);
  } catch {}

  plugin.app.registerCallback<SpecialPluginCallback.GetNextCard>(
    SpecialPluginCallback.GetNextCard,
    async (args: {
      mode: 'practice-all' | 'in-order' | 'normal';
      cardsPracticed: number;
      subQueueId: string | undefined;
      numCardsRemaining: number;
    }) => {
      // NO host round trips in here (see module doc). Serve straight from the
      // persisted cache; the pop is persisted fire-and-forget.
      stats.calls++;
      stats.lastCallAt = Date.now();
      stats.lastArgs = args;
      if (args.subQueueId && !stats.subQueueIdsSeen.includes(args.subQueueId) && stats.subQueueIdsSeen.length < 20) {
        stats.subQueueIdsSeen.push(args.subQueueId);
      }
      if (!state.enabled) {
        stats.nullBecause.disabled++;
        return null;
      }
      if (args.mode === 'in-order') {
        stats.nullBecause.inOrder++;
        return null;
      }
      if (args.subQueueId) {
        stats.nullBecause.subQueue++;
        return null;
      }
      // Take the newest entry with a card we can actually render, skipping
      // rems whose sibling card was just served (heldUntil). Entries without a
      // servable card (image occlusion, legacy undefined) stay in the list for
      // the pane and the tier layer; they are never injected here.
      const now = Date.now();
      let at = -1;
      let pick: { cardId?: string; rest: string[] } | null = null;
      for (let i = 0; i < state.list.length; i++) {
        const c = state.list[i];
        if (typeof c.heldUntil === 'number' && c.heldUntil > now) continue;
        const p = servableCardsOf(c);
        if (p) {
          at = i;
          pick = p;
          break;
        }
      }
      if (at === -1 || !pick) {
        stats.nullBecause.empty++;
        return null;
      }
      // The entry stays in the list until the card is actually answered; see
      // SERVE_HOLD_MS. Ordering is unchanged: the hold makes the next call skip
      // past it to the next-newest card.
      const next = state.list[at];
      next.heldUntil = now + SERVE_HOLD_MS;
      persist();
      stats.served++;
      stats.lastServedRemId = next.remId;
      state.current = { remId: next.remId, cardId: pick.cardId, servedAt: now };
      // `type` is what Incremental Everything sends and what RemNote's queue
      // item plumbing keys on (QueueItemType.Plugin = 15, FullAppBootstrap~2.js:32935).
      // The SDK's PluginQueueCardData type omits it; omitting it in practice is
      // the leading suspect for the pane-layout `.first` crash.
      return {
        type: QueueItemType.Plugin,
        remId: next.remId,
        pluginId: PLUGIN_ID,
        ...(pick.cardId ? { cardId: pick.cardId } : {}),
      } as never;
    },
  );

  return {
    seed: async (list, watermark) => {
      state.list = list
        .filter((c) => c && typeof c.remId === 'string' && typeof c.createdAt === 'number')
        .sort((a, b) => b.createdAt - a.createdAt);
      state.watermark = watermark;
      state.origin = 'seeded';
      persist();
      log(`newest-first: seeded ${state.list.length} rem(s), watermark ${new Date(watermark).toISOString()}`);
      return { size: state.list.length, watermark: state.watermark };
    },
    refresh,
    current: () => state.current,
    drop: (remId: string) => {
      const before = state.list.length;
      state.list = state.list.filter((c) => c.remId !== remId);
      if (state.current?.remId === remId) state.current = null;
      if (state.list.length !== before) persist();
    },
    snapshot: () => ({
      size: state.list.length,
      watermark: state.watermark,
      head: state.list.slice(0, 10),
      enabled: state.enabled,
      restored: state.restored,
      origin: state.origin,
      current: state.current,
      stats,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
    }),
  };
}

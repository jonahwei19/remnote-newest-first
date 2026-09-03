import { AppEvents, QueueItemType, RNPlugin, SpecialPluginCallback } from '@remnote/plugin-sdk';
import { looksLikeCard, mapLimit } from './cards';
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
const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** How many list-head entries each refresh re-validates against card state. */
const STALE_CHECK_HEAD = 15;

/** Substring matches against the card's ancestor path (and its own text). */
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
  /** The forward/backward card actually served. Returned as `cardId` so
   * RemNote's plugin item carries a real card: its base class resolves
   * skip/forget/answer from actionItem.cardId (33576.js:7928, 45827.js:5703),
   * which is what makes native keys and native grading work on our item. */
  servableCardId?: string;
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
}

export interface NfHandle {
  seed: (list: QueueCandidate[], watermark: number) => Promise<{ size: number; watermark: number }>;
  refresh: (force?: boolean) => Promise<{ size: number; watermark: number; added: number; pruned: number }>;
  snapshot: () => {
    size: number;
    watermark: number;
    head: QueueCandidate[];
    enabled: boolean;
    restored: boolean;
    stats: NfStats;
  };
}

export function installNewestFirst(plugin: RNPlugin, log: (line: string) => void): NfHandle {
  const state: NfState = {
    list: [],
    watermark: 0,
    refreshing: false,
    lastRefreshAt: 0,
    enabled: true,
    restored: false,
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
        log(`newest-first: restored ${state.list.length} rem(s) from storage`);
      }
    } catch {}
    state.restored = true;
  };

  const excludes = async (): Promise<string[]> => {
    const raw = ((await plugin.settings.getSetting<string>(SETTING_EXCLUDE)) ?? DEFAULT_EXCLUDE) as string;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const remCardState = async (
    rem: any,
  ): Promise<{ unpracticed: boolean; cardIds: string[]; servable: boolean; servableCardId?: string } | undefined> => {
    try {
      const cards = (await rem.getCards()) ?? [];
      if (cards.length === 0) return undefined;
      // PluginCardType is 'forward' | 'backward' | {clozeId} (SDK
      // interfaces.d.ts:897). Only the two directions render faithfully from
      // rem.text / rem.backText; see QueueCandidate.servable.
      let servable = false;
      let servableCardId: string | undefined;
      for (const c of cards as any[]) {
        const t = c.type ?? (await c.getType?.().catch(() => undefined));
        if (t === 'forward' || t === 'backward') {
          servable = true;
          servableCardId = typeof c._id === 'string' ? c._id : undefined;
          break;
        }
      }
      return {
        unpracticed: cards.every((c: any) => (c.repetitionHistory?.length ?? 0) === 0),
        cardIds: cards.map((c: any) => c._id).filter((id: unknown) => typeof id === 'string'),
        servable,
        servableCardId,
      };
    } catch {
      return undefined;
    }
  };

  /**
   * Incremental refresh: enumerate rems (parent-walk, no per-rem card calls),
   * then confirm card state only for rems newer than the watermark and for the
   * head of the existing list. Bounded work even on a cold, slow database.
   */
  const refresh = async (force = false) => {
    if (state.refreshing) return summary(0, 0);
    if (!force && Date.now() - state.lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return summary(0, 0);
    state.refreshing = true;
    let added = 0;
    let pruned = 0;
    try {
      const skip = await excludes();
      const { rems, map } = await enumerateRems(plugin);
      const known = new Set(state.list.map((c) => c.remId));

      const fresh = rems.filter(
        (r: any) =>
          looksLikeCard(r) &&
          typeof r.createdAt === 'number' &&
          r.createdAt > state.watermark &&
          !known.has(r._id),
      );
      const additions: QueueCandidate[] = [];
      const validatedWatermarks: number[] = [];
      await mapLimit(fresh, CONCURRENCY, async (rem: any) => {
        const cs = await remCardState(rem);
        if (!cs) return; // failed — do NOT advance watermark past this rem
        validatedWatermarks.push(rem.createdAt);
        if (!cs.unpracticed) return;
        const where = contextPath(rem, map);
        if (skip.some((s) => where.includes(s))) return;
        try {
          if ((await rem.getEnablePractice()) === false) return;
        } catch {}
        additions.push({
          remId: rem._id,
          createdAt: rem.createdAt,
          cardIds: cs.cardIds,
          servable: cs.servable,
          servableCardId: cs.servableCardId,
        });
      });

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
        if (!cs.unpracticed) stale.add(cand.remId);
        else {
          cand.cardIds = cs.cardIds;
          cand.servableCardId = cs.servableCardId;
          cand.servable = cs.servable;
        }
      });

      if (stale.size > 0) {
        pruned = stale.size;
        state.list = state.list.filter((c) => !stale.has(c.remId));
      }
      if (additions.length > 0) {
        // Re-check against the list as it stands NOW: a seed may have landed
        // while this refresh was scanning, and a pop must stay popped.
        const nowKnown = new Set(state.list.map((c) => c.remId));
        const merged = additions.filter((c) => !nowKnown.has(c.remId));
        added = merged.length;
        state.list = [...merged, ...state.list].sort((a, b) => b.createdAt - a.createdAt);
      }
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
  // A zero watermark means no cache has ever been built ‒ refreshing then
  // would be a full 13k-rem card scan, which on a cold database runs for
  // hours and starves every other SDK call. Require an explicit seed
  // (`remq nfcache --seed`) or a deliberate `remq nfcache --refresh` instead.
  void (async () => {
    await restore();
    await refreshEnabledFlag();
    if (state.watermark > 0) await refresh(true);
    else log('newest-first: no cache yet ‒ seed via `remq nfcache --seed <file>`');
  })();

  plugin.event.addListener(AppEvents.QueueCompleteCard, 'rb-newest-first', (data: any) => {
    stats.completed.push({ score: data?.score, cardId: data?.cardId, at: Date.now() });
    if (stats.completed.length > 20) stats.completed.shift();
  });

  plugin.event.addListener(AppEvents.QueueEnter, 'rb-newest-first', () => {
    void (async () => {
      await refreshEnabledFlag();
      await refresh();
    })();
  });

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
      // Take the first entry we can actually render. Non-servable entries
      // (clozes, legacy undefined) stay in the list for the pane and the tier
      // layer; they are simply never injected here. Only entries explicitly
      // marked servable===true are served — a cloze served raw leaks its answer.
      const at = state.list.findIndex((c) => c.servable === true);
      if (at === -1) {
        stats.nullBecause.empty++;
        return null;
      }
      const [next] = state.list.splice(at, 1);
      if (!next) {
        stats.nullBecause.empty++;
        return null;
      }
      persist();
      stats.served++;
      stats.lastServedRemId = next.remId;
      // `type` is what Incremental Everything sends and what RemNote's queue
      // item plumbing keys on (QueueItemType.Plugin = 15, FullAppBootstrap~2.js:32935).
      // The SDK's PluginQueueCardData type omits it; omitting it in practice is
      // the leading suspect for the pane-layout `.first` crash.
      return {
        type: QueueItemType.Plugin,
        remId: next.remId,
        pluginId: PLUGIN_ID,
        ...(next.servableCardId ? { cardId: next.servableCardId } : {}),
      } as never;
    },
  );

  return {
    seed: async (list, watermark) => {
      state.list = list
        .filter((c) => c && typeof c.remId === 'string' && typeof c.createdAt === 'number')
        .sort((a, b) => b.createdAt - a.createdAt);
      state.watermark = watermark;
      persist();
      log(`newest-first: seeded ${state.list.length} rem(s), watermark ${new Date(watermark).toISOString()}`);
      return { size: state.list.length, watermark: state.watermark };
    },
    refresh,
    snapshot: () => ({
      size: state.list.length,
      watermark: state.watermark,
      head: state.list.slice(0, 10),
      enabled: state.enabled,
      restored: state.restored,
      stats,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
    }),
  };
}

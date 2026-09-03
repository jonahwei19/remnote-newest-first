import { BuiltInPowerupCodes, RNPlugin } from '@remnote/plugin-sdk';
import { renderRich } from './cards';

const SEED_TERMS = ['the', 'a', 'is', 'of', 'and', 'to', 'AI', 'how', 'what', 'model', 'risk', 'policy', 'he', 'it', 'for'];

/**
 * Enumerate the whole knowledge base as rem objects, keyed by id.
 *
 * `card.getAll()`, `rem.getAll()`, and `taggedRem(Document)` are all broken or
 * removed in current RemNote builds. What works: bulk `getDescendants()`, the
 * free `parent`/`children`/`text`/`backText` properties on each rem object, and
 * `search`. So: seed with search hits + daily docs + the focused rem, walk each
 * seed UP to its top-level root using the free `parent` id batched through
 * `rem.findMany` (one call per tree level), then `getDescendants` each root.
 * On a real 41k-rem KB this is ~2.5 s and reaches everything.
 */
export async function enumerateRems(plugin: RNPlugin): Promise<{ rems: any[]; map: Map<string, any> }> {
  const p = plugin as any;
  const map = new Map<string, any>();
  const seeds: any[] = [];
  for (const term of SEED_TERMS) {
    try {
      seeds.push(...((await p.search.search([term], undefined, { numResults: 50 })) ?? []));
    } catch {}
  }
  try {
    const pu = await p.powerup.getPowerupByCode(BuiltInPowerupCodes.DailyDocument);
    seeds.push(...((await pu?.taggedRem()) ?? []));
  } catch {}
  try {
    const f = await p.focus.getFocusedRem();
    if (f) seeds.push(f);
  } catch {}
  for (const r of seeds) map.set(r._id, r);

  // Walk up to roots via the free `parent` property, one findMany per level.
  const rootIds = new Set<string>();
  let level: any[] = seeds;
  for (let depth = 0; depth < 80 && level.length; depth++) {
    const needIds: string[] = [];
    for (const r of level) {
      const pid = r?.parent;
      if (!pid) {
        if (r?._id) rootIds.add(r._id);
      } else if (!map.has(pid)) {
        needIds.push(pid);
      }
    }
    if (needIds.length === 0) break;
    let parents: any[] = [];
    try {
      parents = (await p.rem.findMany(needIds)) ?? [];
    } catch {
      break;
    }
    for (const par of parents) map.set(par._id, par);
    level = parents;
  }

  // getDescendants each root (bulk); collect + map everything.
  const seen = new Set<string>();
  const rems: any[] = [];
  const add = (r: any) => {
    if (r && !seen.has(r._id)) {
      seen.add(r._id);
      rems.push(r);
      map.set(r._id, r);
    }
  };
  for (const id of rootIds) {
    const root = map.get(id);
    if (!root) continue;
    add(root);
    let desc: any[] = [];
    try {
      desc = (await root.getDescendants()) ?? [];
    } catch {}
    for (const d of desc) add(d);
  }
  return { rems, map };
}

/** How many ancestors a breadcrumb keeps, counting from the card upwards. */
const CONTEXT_DEPTH = 6;
/** How much of one ancestor's text a breadcrumb keeps. A document title is short;
 * a paragraph that happens to be a parent is not, and would swamp the line. */
const CONTEXT_SEGMENT = 60;

/**
 * Where the card lives: the text of its ancestors, outermost first.
 *
 * A card on its own is often unreadable ‒ "6\" denotes" means nothing until you
 * see it sitting under Units › Notation. This walks up through the free `parent`
 * id against the rems the enumeration is already holding, so it costs no SDK
 * call and no extra pass. Ancestors with no text of their own are skipped rather
 * than left as gaps, and the walk stops at `CONTEXT_DEPTH`.
 *
 * The `seen` set is defensive: a parent cycle has no root, so the enumeration
 * would never reach such a card in the first place and no test can produce the
 * shape. It costs one set and it means the loop cannot hang if that ever
 * stops being true.
 */
export function contextPath(rem: any, map: Map<string, any>): string {
  const parts: string[] = [];
  const seen = new Set<string>([rem._id]);
  let cur = rem.parent ? map.get(rem.parent) : undefined;
  while (cur && parts.length < CONTEXT_DEPTH && !seen.has(cur._id)) {
    seen.add(cur._id);
    const text = renderRich(cur.text, map);
    if (text) {
      parts.push(text.length > CONTEXT_SEGMENT ? `${text.slice(0, CONTEXT_SEGMENT - 1)}…` : text);
    }
    cur = cur.parent ? map.get(cur.parent) : undefined;
  }
  return parts.reverse().join(' › ');
}

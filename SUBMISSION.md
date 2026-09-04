# SUBMISSION — Newest First

## 0.3.0 — answers RemNote's rejection (2026-09-03)

Nate at RemNote rejected 0.2.0:

> On a fresh install, the plugin did not serve a newly created card until
> "Newest First: Rebuild List" was run manually. Before that, its status showed
> 0 queued, asked 2x, and served 0, but the README does not explain this
> required setup.

He was right, and the cause was worse than the symptom. Three defects, all fixed:

1. **No list was ever built on a fresh install.** Activation refreshed only when
   a cache already existed (`watermark > 0`), because a full scan on a cold
   database was slow enough to starve the app. 0.3.0 builds on first activation
   from the newest 500 card rems, which is bounded on any knowledge base, and
   records everything older as considered.
2. **Every event listener was registered under a key RemNote never emits.** The
   SDK delivers an event only to listeners registered under the emitter's key
   (`listeners[eventId].get(msg.listenerKey)`, lib.js). RemNote emits queue
   events and GlobalRemChanged with `void 0` (45827.js:5715, 33576.js:7934,
   FullAppBootstrap~3.js:9852); this plugin used a name string. So the list
   never refreshed on entering the queue and answered cards were never removed.
   Proven in a headless guest instance: `completed: []` after a full session,
   then `completedOurs: 5` after the fix. Pinned by tests.
3. **A card served but never displayed was lost permanently.** RemNote asks
   during a background preload and parks the answer as `pendingPluginCard`
   (33576.js:1355); if the session ends first it is discarded. The plugin
   removed it from the list on serve, so it was never practised and never came
   back. Now the entry stays until RemNote reports the card answered.

Also in 0.3.0:
- **Cloze cards are served and drawn correctly** (they were listed but skipped).
  The question hides that cloze's span behind its hint or `[...]`; the answer
  reveals it. A cloze with no inline span (image occlusion) is still never
  served, so it cannot leak an answer.
- **A rem with several new cards serves them one at a time**, ten minutes apart.
- **`e` and `b` work on served cards**: `e` opens RemNote's editor for the rem in
  a popup, `b` disables the card the way RemNote's own `b` does. Keys are stolen
  only while a plugin card is on screen, under the plugin's own id, which is the
  key StealKeyEvent is emitted with (FullAppBootstrap~2.js:31023, :80056).
- README rewritten: the "Nothing to set up" section is the direct answer to the
  rejection.

**Known and documented, not a defect:** the first card of a session is always
RemNote's own. `preloadInner` returns early when `mode === "critical"`, which is
the load that produces the first card, so no plugin is asked for it.

### Resubmission steps (Jonah)
1. `marketplace-plugin/PluginZip.zip` is built and `npx remnote-plugin validate`
   passes. Version 0.3.0.
2. Push the source to the public repo: `bash marketplace-plugin/publish-repo.sh`.
3. remnote.com/plugins → Build → upload the zip.
4. Reply to Nate's email saying what changed (points 1-3 above); he asked for the
   fresh-install path to be verified end to end, and it now is.

---

## Earlier history (0.2.0)

**SUBMITTED 2026-09-02 (PT) via the in-app Build tab; RemNote confirmed "uploaded successfully, wait for approval". Public repo: https://github.com/jonahwei19/remnote-newest-first.** (Original note follows.) Nothing here had been submitted. Submitting is a click only Jonah makes; the
overnight rules forbid any outbound action. This file is the package plus the
exact steps.

## Status (0.2.0, rebuilt 2026-09-02 from the code running on Jonah's desktop)

- `npx remnote-plugin validate` — **passes** (`validate.txt`).
- webpack production build — **succeeds**, 3 bundle-size advisories (`build.txt`).
- `PluginZip.zip` and `dist/` are committed; the zip now carries THREE widgets:
  `index` (activation + GetNextCard), `nf_flashcard` (card face), and
  `nf_answer_buttons` (answer row). Both queue widgets match only
  `QueueItemType.Plugin`.

### What changed since 0.1.0, and why
- **Answer-row widget added.** Live on desktop, RemNote 1.28.0's pane layout
  threw (`.first` of undefined) under every injected item until a matching
  FlashcardAnswerButtons widget existed; a never-matching registration is not
  enough (tested: the native fallback for that slot is what crashes).
- **Served items carry `cardId` and `type: QueueItemType.Plugin`.** RemNote's
  SpacedRepetitionBase resolves skip/forget/answer from `actionItem.cardId`
  (33576.js:7928, 45827.js:5703), so native keys and native grading bind to
  the served card. The row uses RemNote's own labels (Forgot / Partially
  recalled / Recalled with effort / Easily recalled, Skip) and rates via
  `queue.rateCurrentCard` first, manual `updateCardRepetitionStatus` fallback.
- **Enumeration no longer uses `card.getAll()`** (absent in current builds);
  it is the bridge's proven search-seeded parent-walk + `getDescendants`.
- **Cache and list live in synced plugin storage**, so a phone/tablet instance
  shares the desktop's list. Incremental refresh by creation-time watermark;
  clozes are listed but never injected.
- Default exclusion list is empty (set your own under Settings → Plugins).

### Not yet verified — read before submitting
- Desktop 1.28.0: this exact configuration ran crash-free in one live session
  earlier on 2026-09-02, but the current build (native labels + cardId) has NOT
  yet been watched end to end by a human or a screenshot. Verify one desktop
  session before submitting.
- Mobile: `enableOnMobile` is set, but whether iOS/iPadOS honors the
  GetNextCard hook and Flashcard-location widgets is unknown from the desktop
  code. Treat the first mobile install as an experiment.
- Two plugins registering GetNextCard double-serve. When this is installed on
  a desktop that also runs the dev bridge plugin, run `remq nfcache --inject off`
  there first.

## Listing text

**Name:** Newest First

**Short description:**
Practise the cards you just made, first. Never-practised cards are served
newest-created-first at the front of your normal queue.

**Long description:** see `README.md`.

## The scope question, answered honestly

The manifest asks for `All / ReadCreateModify`, not `Read`. The brief asked for
"minimal scopes (Read unless something needs more)", and two things need more:

1. **Grading.** A plugin-served queue item renders with a null native body
   (RemNote 1.28.0, `33576.js:8310`), so this plugin draws the card *and* must
   answer for it. It calls `card.updateCardRepetitionStatus`, which is a write.
   Without it a served card could never be graded, which would corrupt the
   session rather than merely limit the plugin.
2. **Reading the studying tier** uses `getPowerupProperty`, which is a read — but
   the SDK groups powerup access under the same scope.

There is no delete anywhere in this plugin, and the tier report has no write path
at all. If the marketplace reviewer asks why `ReadCreateModify`, the answer is
point 1 and it is not reducible.

## Jonah's submission steps

1. Read `README.md` and decide you are happy for it to be public. It describes
   RemNote's own new-card randomisation, accurately; that is fair comment, but it
   is your name on it.
2. `cd marketplace-plugin && npm install && npm run build` — confirm
   `PluginZip.zip` is regenerated.
3. Go to <https://remnote.com/plugins> → *Build* → *Submit a plugin*.
4. Upload `PluginZip.zip`, paste the listing text above.
5. Set the repository URL. **The manifest currently points at
   `https://github.com/jonahwei19/remnote-newest-first`, which does not exist.**
   Either create that repository first or change `repoUrl` in
   `public/manifest.json` before uploading. Validation does not check that the
   URL resolves, so this will otherwise ship broken.
6. Submit.

## Before you submit — two things worth testing first

- Install it as a **dev plugin** and confirm the "Newest First: Status" command
  reports `asked` greater than zero after a practice session. That number is the
  whole mechanism; if it is 0, the gate did not open on your build.
- Run the tier report and check it names the documents you expect. It is
  read-only, so it is a free test.

import { AppEvents, declareIndexPlugin, QueueItemType, type ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import '../style.css';
import '../index.css';
import { installNewestFirst } from '../lib/newest_first';

/**
 * Newest First ‒ standalone marketplace build of the newest-first queue.
 *
 * Never-practised cards are served newest-created-first at the front of the
 * normal queue; everything else is untouched. Two widgets are registered for
 * the injected items, exactly as Incremental Everything does: the Flashcard
 * widget is what makes RemNote poll GetNextCard at all (33576.js:1355), and the
 * FlashcardAnswerButtons widget fills the plugin item's second pane slot ‒ with
 * it absent, RemNote 1.28.0's pane layout throws under every injected item.
 * Both match only QueueItemType.Plugin, so ordinary cards render natively.
 */
async function onActivate(plugin: ReactRNPlugin) {
  await plugin.app.registerWidget('nf_flashcard', WidgetLocation.Flashcard, {
    dimensions: { height: 'auto', width: '100%' },
    queueItemTypeFilter: QueueItemType.Plugin,
  });
  await plugin.app.registerWidget('nf_answer_buttons', WidgetLocation.FlashcardAnswerButtons, {
    dimensions: { height: 'auto', width: '100%' },
    queueItemTypeFilter: QueueItemType.Plugin,
  });
  // "e" on an injected item opens RemNote's editor for the rem in this popup
  // (the native in-queue editor is a queue type plugins cannot produce).
  await plugin.app.registerWidget('nf_edit', WidgetLocation.Popup, {
    dimensions: { height: 'auto', width: '720px' },
  });

  // The list builds itself on first activation (newest card rems), is kept
  // current by rem-change events, and is re-checked on entering the queue.
  const nf = installNewestFirst(plugin, (line) => console.log(line));
  // "b" on an injected item disables it (nf_flashcard.tsx) and tells us to
  // forget the rem, so its other cards are not served either.
  plugin.event.addListener(AppEvents.MessageBroadcast, undefined, (data: any) => {
    const msg = data?.message ?? data;
    if (msg?.type === 'nf-drop' && typeof msg.remId === 'string') nf.drop(msg.remId);
  });

  await plugin.app.registerCommand({
    id: 'nf-rebuild',
    name: 'Newest First: Rebuild List',
    description: 'Re-check for never-practised cards. Not needed in normal use: the list builds itself and follows your edits.',
    action: async () => {
      const r = await nf.refresh(true);
      await plugin.app.toast(`Newest First: ${r.size} never-practised rem(s) queued`);
    },
  });

  await plugin.app.registerCommand({
    id: 'nf-status',
    name: 'Newest First: Status',
    action: async () => {
      const s = nf.snapshot();
      const how = s.origin === 'none' ? ' (list still building)' : '';
      await plugin.app.toast(
        `Newest First: ${s.size} queued${how}, asked ${s.stats.calls}x, served ${s.stats.served}. If asked is 0, the queue is not consulting this plugin.`,
      );
    },
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);

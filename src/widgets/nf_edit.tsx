import {
  RemHierarchyEditorTree,
  WidgetLocation,
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useEffect } from 'react';
import '../style.css';
import '../index.css';

/**
 * The queue's "e" on a newest-first item: Edit Flashcard Now.
 *
 * RemNote's own "e" (QueueEditNow, default "e", FullAppBootstrap~2.js:47624)
 * swaps the current card for an in-queue editor (QueueType EditInQueue,
 * 45827.js:5671). That queue type cannot be produced from a plugin, and a
 * plugin item's editCard hook is empty (33576.js:8199), so on our items the
 * key is dead natively. This popup is the substitute: RemNote's own editor
 * for the rem, in place, closed with Done or Escape. "Open as page" leaves
 * the queue for the rem itself when the popup is not enough.
 *
 * On close it tells the card widget, which takes the "e"/"b" keys back
 * (they are released while the editor is open, so they can be typed).
 */
function NewestFirstEdit() {
  const plugin = usePlugin();
  const ctx = useTrackerPlugin(async (rp) => await rp.widget.getWidgetContext<WidgetLocation.Popup>(), []);
  const remId = ((ctx as any)?.contextData?.remId ?? (ctx as any)?.remId) as string | undefined;

  useEffect(
    () => () => {
      void plugin.messaging.broadcast({ type: 'nf-edit-closed' }).catch(() => {});
    },
    [plugin],
  );

  return (
    <div className="rb-nf-edit" data-testid="rb-nf-edit">
      <div className="rb-nf-edit__bar">
        <span className="rb-nf-edit__title">Edit card</span>
        <span className="rb-nf-edit__spacer" />
        <button
          onClick={async () => {
            const rem = remId ? await plugin.rem.findOne(remId) : undefined;
            await plugin.widget.closePopup();
            await rem?.openRemAsPage();
          }}
        >
          Open as page
        </button>
        <button className="rb-nf-edit__done" onClick={() => void plugin.widget.closePopup()}>
          Done
        </button>
      </div>
      {remId ? (
        <RemHierarchyEditorTree remId={remId} width="100%" height="auto" maxHeight="70vh" />
      ) : (
        <div className="rb-nf-card">No rem to edit.</div>
      )}
    </div>
  );
}

renderWidget(NewestFirstEdit);

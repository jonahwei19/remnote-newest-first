# Newest First

Practise the cards you just made, first.

RemNote's queue has a "New Cards in Queue: Add at Front of Queue" setting, and it
does put new cards first — but it chooses *which* new cards at random. If you
have a backlog of a few hundred never-practised cards, the ones you wrote this
morning are somewhere in a shuffle.

This plugin serves never-practised cards **newest-created-first**, at the front
of your ordinary queue. It does not add a separate practice screen: the cards
appear in the queue you already use.

## What it does

- Keeps a list of your never-practised cards, sorted by creation date.
- Serves them at the front of the normal queue, newest first.
- Grades through RemNote's own scheduler, so a card you answer here becomes an
  ordinary scheduled card with a real interval. Nothing about your review history
  is synthetic.
- **Newest First: Which Documents Are Invisible To The Queue?** — a read-only
  report. RemNote's queue works through priority phases (Exam → Currently
  Studying → Maintaining → No Priority), and a document with no studying tier is
  in the last one, so its cards are unreachable while anything higher still has
  cards due. This command tells you which of your documents that applies to. It
  never changes a tier — that is your call.

## Settings

- **Serve never-practised cards newest first** — the master switch. Off means the
  queue behaves exactly as RemNote ships it.
- **Exclude documents whose path contains** — comma-separated fragments. Useful
  when you have imported a batch you do not want mixed into normal practice.

## Limits, stated plainly

- Cloze cards are listed but not injected. A plugin-served card is drawn by the
  plugin, and a cloze drawn that way would show its own answer. Clozes keep
  coming up through RemNote's normal selection.
- The card body for a served card is drawn by this plugin, so it looks slightly
  plainer than a native card. Every card that is *not* served by this plugin looks
  exactly as it always did.
- Only one plugin at a time can supply a next card; RemNote uses the first that
  answers.

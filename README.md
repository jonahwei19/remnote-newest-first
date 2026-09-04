# Newest First

Practise the cards you just made, first.

RemNote's queue has a "New Cards in Queue: Add at Front of Queue" setting, and it
does put new cards first, but it chooses *which* new cards at random. With a
backlog of a few hundred never-practised cards, the ones you wrote this morning
are somewhere in a shuffle.

This plugin serves never-practised cards **newest-created-first**, at the front
of your ordinary queue. There is no separate practice screen: the cards appear in
the Flashcards queue you already use, and RemNote's own scheduler grades them.

## Nothing to set up

- **On first activation the list builds itself** from your newest card rems (the
  newest 500), in the background. A small knowledge base takes a second; a large
  one a few minutes. Cards older than that window stay on RemNote's normal
  schedule until you edit them.
- **A card you write is listed within a couple of seconds** of you finishing it,
  and the list is re-checked every time you enter the queue. Write a card, open
  Flashcards, and it is the first thing you see.
- Practising a card anywhere (a phone, a document queue) removes it from the list.

Two commands, for curiosity rather than setup: **Newest First: Status** (how many
are queued, how many times the queue has asked, how many were served; if "asked"
is 0 the queue is not consulting the plugin) and **Newest First: Rebuild List**
(a full re-check).

## What it does

- Serves never-practised cards, newest creation date first, at the front of the
  global queue. Forward, backward and cloze cards. When a rem has several new
  cards (both directions, several clozes) they come one at a time, ten minutes
  apart, so you never see the answer and then the question.
- Grades through RemNote's own scheduler. A card you answer here becomes an
  ordinary scheduled card with a real interval; nothing about your review
  history is synthetic. The normal keys work: Space to reveal, 1 to 4 to grade.
- **e** opens RemNote's editor for the card in a popup (Done or Escape to
  return). **b** disables the card, as RemNote's own "b" does on a native card
  (the direction shown; for a cloze, the rem's practice). Both keys are only
  intercepted while a plugin-served card is on screen.
- Leaves document queues and "Practice All Flashcards in Order" alone.

## Settings

- **Serve new cards newest-first in the global queue**: the master switch. Off
  means the queue behaves exactly as RemNote ships it.
- **Newest-first exclusions**: comma-separated path fragments. A new card whose
  ancestor path contains any of them is never auto-served. Useful for an imported
  batch you do not want mixed into normal practice.

## Limits, stated plainly

- A served card's body is drawn by this plugin, so it looks slightly plainer than
  a native card and carries a small "newest first" badge. Every card that is
  *not* served by this plugin looks exactly as it always did.
- Image-occlusion clozes are not served (their hidden region is not inline text).
  They keep coming up through RemNote's normal selection.
- Only one plugin at a time can supply a next card; RemNote uses the first that
  answers.

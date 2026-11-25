# What the owner settled

In the owner's words where possible, newest last. Only the owner's words settle something.

## 2026-11-20

- Usage: an occasional manual run. No nags, no background or autorun, no scheduler.
- Trust: show only; the user decides everything. Duplicates are delicate, temp files easier.
- Shape: one desktop app with a UI that saves its state. Windows cleaning is a later tab.
- v1 order: old downloads list, then duplicates, then Windows cleaning.
- "Old" means all signals (see `vision.md`).
- Every option is a slider where it can be one.
- Results need rich filtering (name, size and more) and multi-select.
- Scan scope: the folders the user points to.
- Remember: keep-list, scan history, deletion log, per-folder selections. Must handle very many
  files.
- Delete means Recycle Bin.
- The owner writes no code; Claude writes all of it.

## 2026-11-22

- Hard rule, said emphatically: never copy the older tool's look, feel, layout or UI, and do not
  open it during design or build. Only its functions are inspiration.
- Functions taken from it, as ideas only: one-click accept of exact duplicates; auto-select
  "keep largest / newest / shortest-named"; path wildcards; an ignore list; a dry run; an undo
  log; name search; size and type filters; Shift-click multi-select.

## 2026-11-25

- The app is called Sift (picked from a round of five names). The repository is SiftNoMore.
- Design only for now: nothing is built until the owner says so.

## Proposed, not settled

- Stack: Rust with Tauri (a Rust scan core, a web UI for the filterable grid), SQLite for what
  it remembers. The owner was leaning towards it; not confirmed.

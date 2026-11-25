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

- Later the same day: build. The owner handed four things over ("you figure out", "you do it",
  "pick one for now"): the menu structure and layout ("a logical way to move around it ... It's
  a tool. It doesn't have to look fancy ... a lick of paint never hurt anyone"), the stack
  (Rust with Tauri, SQLite: confirmed), the slider defaults ("I'll just play around with it"),
  and the first slice: old downloads and duplicates together, "because they go hand in hand",
  with fuzzy duplicates: installer versions, a "1" behind the name, "(1)", and similar telltales.

## Layout and menus (no rounds yet; Claude's own proposal, built)

What was built, for the owner to try and overrule:
- A sidebar: Scan button with the last scan time on top; "Clean up" with Old downloads and
  Duplicates (Windows cleaning joins here later); "Sift" with Where to look, History, Settings.
- Each result page: search, filter chips with counts, a size slider, a list with checkboxes,
  click / Shift-click / Ctrl+A, and a bar at the bottom: selection size, select by path
  pattern, Keep, Move to Recycle Bin (always a confirmation listing every file).
- Slider defaults: unused 6 months, archives 3 months, duplicates from 1 KB, similar names 90%.
- Calm neutral surfaces, one teal accent, follows Windows light/dark, Segoe UI.

### After the first try on Windows (2026-11-25)

Owner's words: "Colms need to be resizable. Picking what stays needs global handlers (so save
all X). Filters need to be way more complete. Its also way to liberal: not everything with the
same size and extention is the same. Valheim was not on github."
What changed: columns drag to resize (remembered); a row of "keep the newest / oldest / largest /
smallest / shortest name / shortest path / Sift's pick in every group" buttons; filters for type,
extension, folder, origin (each a list with counts), a size range and a date range; same-content
groups are now also compared byte for byte, and show their fingerprint on hover; "From" shows the
full recorded addresses on hover; similar names start at 95%.

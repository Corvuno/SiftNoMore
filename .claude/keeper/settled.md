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

### What a duplicate is (owner, 2026-11-25)

"It should find things that are the same. So exactly the same name and same MD5 with a 1 or
something in it that denotes it's a duplicate, that's a duplicate. Same name with like, same
content, same installer with a different version number, that's the same."
So the Duplicates list holds only: Copies (same bytes AND the same name, copy marks aside) and
Installer versions. Same bytes under unrelated names, the same name with other content, and
similar names are "not sure": hidden until asked for. Unpacked archives say where their contents
are ("Unpacked in <folder>"). Program folders are not skipped (Claude's call, the owner said
"you tell me"); the Folder filter and Skip list cover that.

### Selecting, filtering, bulk (owner, 2026-11-25)

"The interface is clean and non-intrusive, that's good. The selection method, it needs work.
There need to be way more filters to find whatever is there and to sift through it, to not have
to click too much and bulk action it." The older tool was ahead in "all the different ways you
can select, filter, find, group, group select, remove" (functions only; its layout "is horrible").
Built: keep-rule chain in the owner's order (preferred folders, "remove from here first"
folders, no copy mark, Sift's pick, newest, ...), applied to every group shown in one click;
protect by path pattern; invert; only selected / undecided / with a selection; hide a group as
"not duplicates" (remembered); sort groups; Old downloads grouped by folder, origin, type,
extension or reason with one checkbox per group; keyboard review (J/K, 1-9, A, U, N).

### Menu hierarchy (2026-11-26, open, round 0)

Owner's words: "the logic of the menu, is terrible in this application. It makes no sense that
the scan button is outside the folders and filters menu.. It needs a hierarchy".
Status: being understood; questions put to the owner about how a run goes for them. A rebuild
made without asking was set aside (branch claude/project-thread-pmmofg) and is not a proposal.

Owner's answers (2026-11-26), how a run goes:
1. "Select a or multiple folders to scan. (And i wish the once that have been scanned it added to
   stay so i can reselect them. Also a way to order them. After folders comes the filters. What do
   I want found, what granularity."
2. "If I don't get the results I want, I change them. And I'll probably have multiple jobs running
   at once for different folders (combinations) and or configs"
3. Windows cleaning: "Seperate".

Owner's answers, round two (2026-11-26):
1. Jobs: "Presets for sliders and settings would be helpful. And next start the same config helps."
2. Folder order: "Picking what to keep hirarcy" (the order decides which copy is kept).
3. What a job looks for: "All of these. So one could look for both. Other one of the two".
Still open: whether several jobs run at the same time or sit side by side.

Owner's answers, round three (2026-11-26), in short (full words in the backlog item "Jobs, presets and a menu in the order of a run"):
- Sift reopens with the last job. Built-in presets (quick scan, thorough clean, obvious duplicates,
  deeper duplicates, installer leftovers, more Claude finds useful) plus presets you save yourself.
- Folder order is an input: a "keep in order of folders" choice, on by default. When files are
  equal the top folder's copy stays; when not equal it doesn't decide. Filters still work on top.
- Each job sets what it finds (old downloads, duplicates, or both) with a toggle.
- Several jobs can run at once (two or three) and be looked at later. Results are always saved,
  with their state; files removed since are gone from them when you come back.
- Folders: all folders ever added stay available; you tick the active ones and drag them in
  order. Each job has its own folder order.
- Will send screenshots of the old tool's options: take the options and logic, never its look.

Owner's answers on the old tool's options (2026-11-26):
- "If its a option: permenet delete is also good." (Changes the hard line in CLAUDE.md; confirmed as
  part of the proposal before CLAUDE.md is touched.)
- Moving removed / kept files: "Yes, just take all the actions as given in DupeNoMore, that works well."
- Rename the kept file to a clean name: "Yea, good plan!"
- One action per certainty level: "Yea, like dupeNoMore works. Its actualy brillant."
- Reviewed, kept with the saved results: "Yea."
- "ALso filters on visibilty. So only whats visible throuhg filters gets selected by modifiers. - if
  certain files are not seen, selection modifiers are not aplied."
- Proposal approved (2026-11-26): "Yes, sounds good". Permanent delete is a deliberate choice, the
  Recycle Bin stays the default, a permanent delete always asks once more. Next: the layout, in
  words first (design round 0).
- Moments of use confirmed (2026-11-26): "yes". Most time: "Going though the results. Mostlily.
  Have not tried it." No reference program yet ("Dont know so fast..").
- Layout round 1 (2026-11-26), outline sketches: A jobs down the side, B jobs as tabs with steps in
  a row, C results with a side panel, D the job as a sentence (rethink). Page:
  https://claude.ai/artifact/XJkdkUv9cetyZcYtmTqz7C

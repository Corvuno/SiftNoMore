# Where the product stands

The overview every conversation starts from. One screen; what is no longer true is removed.

## Strong

- The idea and its limits are clear and written down (`vision.md`, `settled.md`).
- Building started 2026-11-25. First version of old downloads and duplicates is built: scan,
  every "old" signal, exact, copy-mark, version, same-name and similar-name duplicates, keep-list,
  skip list, Recycle Bin with put back, history, sliders. The owner downloads it from the
  "newest" release on GitHub.

## Weak, in the owner's words

- First try (2026-11-25): "way to liberal", columns not resizable, no global keep, filters not
  complete enough. Addressed the same day; waiting for the owner's next try.

- Jobs as tabs with Set up › Results › Act, presets, folders per job, several scans at once,
  a wide results table with a top bar, and acting per certainty level (move, rename, permanent
  delete, dry run, History per kind) landed 2026-11-26 (#2, #3). Waiting for the owner's try.

## What the owner wants next, in their order

1. Try old downloads and duplicates, and say what is off.
2. Windows cleaning (startup programs, temp files), as a later page under "Clean up".

## Open with the owner

- The layout and slider defaults were Claude's picks, built; the owner judges them in use.

## Noticed, not yet raised or settled

- With "As I selected", a group can lose every copy: Sift warns in the confirmation but does not
  block it (the user decides every removal).
- Old downloads on the Act step start at "Leave alone", so old files selected on Results do
  nothing until that level is switched to "As I selected".

- "Unused" leans on Windows' last-opened date, which Windows doesn't always keep up to date;
  if files show as unused that were opened lately, that is why.
- The app is not code-signed, so Windows warns the first time it runs.
- Remembered results are kept as one block of text; fine for now, may need splitting if a scan
  ever holds hundreds of thousands of findings.

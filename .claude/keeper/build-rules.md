# Build rules

Set 2026-11-25, when the owner said to build and confirmed the stack.

## How Sift is made

- Rust with Tauri 2: a Rust core does the work, a web page is the window. SQLite (bundled into
  the app) holds what Sift remembers.
- `core/`: all scanning and matching (`names` reads file names, `scan` walks folders, `dupes`
  finds duplicates, `old` decides what is old, `plan` works out the Act step: who goes, who stays,
  where moved files land, which kept files are renamed). No window and no Windows-only code, so it is
  tested on any machine. Anything that decides what the user sees belongs here, with a test.
- `app/`: the Tauri shell. `main.rs` holds the commands the window calls, `db.rs` what is
  remembered, `installed.rs` reads installed programs (Windows only).
- `ui/`: plain HTML, CSS and JavaScript, no framework and no build step. Long lists draw only
  the rows in view; keep it that way, the owner's PC has very many files.
- `dev/preview.html` shows the window in a normal browser with made-up files (`dev/mock.js`).
  When a command changes, change the mock with it.

## Lines the code keeps

- Removal goes through the `trash` crate (the Recycle Bin) by default, one file at a time, each
  logged. Moves (`std::fs::rename`, or copy then Recycle Bin for the original across drives),
  renames and permanent delete happen only from the Act step, from a plan made by
  `core/src/plan.rs`, one file at a time, each written in History with its kind (recycled,
  moved, renamed, deleted) and where it went, so it can be undone per kind. Permanent delete
  (`std::fs::remove_file`) is only in the Act step's delete operation and only runs after the
  window has asked a second time, saying it can't be undone; the app refuses it otherwise.
  No `remove_file` anywhere else, and nothing is ever overwritten: a taken name gets " (2)".
- Nothing runs unless the user presses something: no tray, no autostart, no timers, no
  background service. A scan runs only while the window is open.
- Sift's look is its own: design from the product's own pieces, never from the older tool.

## Checks

- Quick, before every push: `cargo test -p sift-core`, `cargo fmt --all --check`,
  `node --check ui/app.js`.
- The app compiles for Windows from Linux too:
  `cargo build -p sift --release --target x86_64-pc-windows-gnu` (needs the mingw-w64 gcc).
- Remote: the "Windows build" workflow (`.claude/keeper/checks-workflow`) tests the core, builds
  the installer and the portable exe, and puts them on the "newest" release, which is where the
  owner downloads Sift.
- A look at the window: open `dev/preview.html` through a local web server, light and dark.

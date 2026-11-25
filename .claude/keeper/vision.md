# Vision

Settled with the owner, Kuno, between 2026-11-20 and 2026-11-25.

## What Sift is

A Windows desktop app for a PC that has been used far too long. Over the years it fills up with
leftovers: downloads nobody opened again, installers for programs already installed, archives
already unpacked, old PDFs, saves, the same file downloaded twice. Sift goes through the folders
the user points it at, finds that clutter, says where each file came from (the program or the
website, through the download mark Windows keeps on a file) or groups it sensibly, and shows it
so the user can decide what goes. Later it also lightens what Windows loads at startup and in the
background (startup programs, temp files). It is not a speed tuner.

## Who it is for

The owner first, on their own PC. Later the public.

## How it should feel

- Something you open now and then to clear out, on purpose. It never runs by itself, never
  nags, never schedules.
- It shows; you decide. Nothing goes without the user's say, and what goes lands in the Recycle
  Bin. Duplicates are the delicate part; temp files are easier.
- Every option that can be a slider is a slider.
- It copes with very large numbers of files.
- Its look is its own, designed fresh. The older tool's functions are inspiration; its look,
  feel and layout are not (see `CLAUDE.md`).

## Where it is heading

One desktop app that remembers its state, in this order:

1. Old downloads: a list of what is likely stale. "Old" uses every signal together: untouched
   for X months, installer of a program that is installed, archive that was unpacked, archive
   older than X, installer superseded by a newer version.
2. Duplicates: same content (MD5), same name, and near names ("setup (1).exe", a newer
   installer version).
3. Windows cleaning, as a later tab.

Results can be filtered richly (name, size, type and more) and selected many at a time. Sift
remembers a keep-list, the scan history, a log of what was removed, and the choices per folder.

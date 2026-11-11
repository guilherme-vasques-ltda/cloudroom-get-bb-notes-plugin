Browse and edit a folder of notes right inside Cloudroom. **Notes** adds a page to the left
sidebar with the full folder tree, a visual (WYSIWYG) Markdown editor for people who do not know
Markdown, and safe handling of HTML and images. The files stay ordinary files on disk; the disk is
always the source of truth.

## What you get

- A folder tree with search by file name and by content, sorting, create, rename, move (drag and
  drop) and a trash. Nothing is ever deleted: removal moves the item to `.lixeira` after a
  confirmation, and it can be restored.
- A formatted editor with a toolbar (headings, bold, lists, tasks, quotes, links, tables, images)
  and a plain Markdown mode. Unedited blocks are saved byte for byte, and YAML frontmatter is
  preserved. Autosave and undo are built in.
- Per-project notes: pick a Cloudroom project to focus on its folder, such as `Notes/Project`.
- Live updates when a file changes on disk, and a Keep mine or Use theirs choice when it changes
  while you have unsaved edits. The other version is kept in the trash.
- HTML files render in a sandboxed frame with no scripts and no network by default.
- A `room-cli notes` command and skill so agents can list, read and write notes, with a version
  check on every write.

## Safety

The plugin reads and writes only inside the folder you configure. Path traversal, absolute paths,
hidden folders and symlinks that point outside the folder are refused. It makes no network calls,
sends no telemetry and stores no secrets.

## Setup

Set the folder once, then reload:

```
room-cli plugin config notes set root ~/Notes
room-cli plugin reload notes
```

The interface is in Portuguese (pt-BR).

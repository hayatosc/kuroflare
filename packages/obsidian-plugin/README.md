# Kuroflare Obsidian Plugin

This package is an Obsidian plugin prototype for validating:

- CodeMirror 6 editor binding through `Compartment.reconfigure`
- Yjs binding through `y-codemirror.next` with the Y undo plugin disabled
- `EditorView` access from an active `MarkdownView`
- `Y.Text` persistence through `y-indexeddb` before disk seeding
- watcher hash-gating with SHA-256 canonical text hashes
- disk-to-`Y.Text` imports using a minimal middle replacement
- materialize compare-and-swap before writing to disk

It is intentionally scoped to one active Markdown file and does not talk to a
backend. The first file you bind becomes the target for that plugin session;
other active files are ignored to avoid writing the fixed editor buffer into the
wrong note.

## Build

```bash
pnpm --filter @kuroflare/obsidian-plugin build
```

The build writes `main.js` next to `manifest.json`.

## Manual Install

From this repository:

```bash
mkdir -p /path/to/vault/.obsidian/plugins/kuroflare
cp packages/obsidian-plugin/manifest.json /path/to/vault/.obsidian/plugins/kuroflare/
cp packages/obsidian-plugin/versions.json /path/to/vault/.obsidian/plugins/kuroflare/
cp packages/obsidian-plugin/main.js /path/to/vault/.obsidian/plugins/kuroflare/
```

Then enable `Kuroflare` from Obsidian's Community plugins settings.

## Smoke Test

1. Open a Markdown file.
2. Run `Kuroflare spike: bind active editor`.
3. Edit the file and run `Kuroflare spike: log state`.
4. Run `Kuroflare spike: simulate remote insert`.
5. Run `Kuroflare spike: flush YText to disk`.
6. Edit the same file from an external editor and confirm the plugin imports it.
7. Change only CRLF/LF or the final newline externally and confirm it does not
   create repeated conflict copies.
8. Restart Obsidian and confirm the previous YText state loads before disk seeding.
9. To test the CAS path, edit the file externally after binding, then run
   `Kuroflare spike: flush YText to disk`. It should create a conflict copy
   instead of overwriting the external edit.

Use a disposable vault. This spike deliberately exercises write paths.

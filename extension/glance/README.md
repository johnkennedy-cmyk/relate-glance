# glance — a relate extension

One-line, read-only stats summary of a relate store, mounted as
`relate run glance`. Companion to the full
[relate-glance](https://github.com/johnkennedy-cmyk/relate-glance) terminal
dashboard (the TUI can't live inside the extension contract — extension
stdin/stdout are the MCP wire — so this is the in-CLI entry point).

```
$ relate run glance -d ~/.relate/memory
glance: 330 Entity · 202 Episode · 92 Fact · 1011 rels · last write 2026-11-11T18:00:13Z
```

Writes nothing. Works on any store; when the store is a relate agent-memory
graph (Episode/Fact labels) the summary includes the newest write, and the
starters pull the latest episodes and facts into the interactive shell.

## Install

```sh
# pinned GitHub release (SHA256-verified)
relate extension install glance --github johnkennedy-cmyk/relate-glance@v0.1.0

# or from a checkout
relate extension install glance --from extension/glance
```

Runtime: Node 22.18+ (the executable is type-stripped TypeScript, no
dependencies).

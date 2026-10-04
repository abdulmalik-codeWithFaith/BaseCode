# B Code (Base Code)

An AI-powered, collaborative code editor for the web. **Milestone 1** delivers the core workspace:
code editor, file explorer, integrated terminal and live preview. The AI agent (Gemini, behind an
adapter layer), Git and collaboration come in later milestones (see `docs/` / the product spec).

## What works in Milestone 1

- **Editor**: Monaco (the VS Code engine), multi-file tabs, syntax highlighting, autocomplete,
  unsaved-change markers, `Ctrl+S` to save.
- **Explorer**: create / rename / delete files and folders, auto-refresh when the shell changes files.
- **Search**: project-wide text search, click a hit to jump to the line.
- **Terminal**: real PTY shell (`node-pty` + xterm.js), multiple terminals, resizable.
- **Preview**: static preview of project files (auto-reloads on save) or any local dev server by
  port (`:3000`) through a built-in reverse proxy, including WebSocket/HMR.
- **Layout**: resizable sidebar / preview / terminal. `Ctrl+B` sidebar, `` Ctrl+` `` terminal.

## Run it

```bash
npm install            # if node-pty fails to build offline, see Troubleshooting
npm run dev            # server on :4000, web on http://localhost:5173
```

Production-style:

```bash
npm run build
npm start              # serves API + built web app on http://127.0.0.1:4000
```

Your project lives in `./workspace` (override with `BCODE_WORKSPACE=/path/to/project`).

## Layout

```
server/   Express + ws + node-pty. Path-safe workspace API, terminal sockets, preview proxy
web/      Vite + React + TypeScript UI (Monaco, xterm.js)
workspace/ The default project the editor opens
```

## Security notes (important before any multi-user use)

- The server binds to `127.0.0.1` only. **Anyone who can reach it gets a shell** on the host, so do
  not expose it to a network until auth + sandboxed (container) workspaces exist (planned Phase 4/6).
- All file paths are resolved against the workspace root and rejected if they escape it.
- The preview iframe is sandboxed *without* `allow-same-origin`, so previewed project code cannot
  call the IDE's API or terminal. Trade-off: previewed apps that use `localStorage` may not work
  until previews move to a separate origin.

## Troubleshooting

- `node-pty` needs a C++ toolchain. If `node-gyp` cannot download Node headers (restricted network):
  `npm_config_nodedir=$(dirname $(dirname $(which node))) npm install`.

## Roadmap

1. **M1 (this)**: editor, explorer, terminal, preview
2. **M2**: Git (status, diff, commit, branches, push/pull)
3. **M3**: AI agent: tool system (read/create/edit/delete/search/run), context manager, Gemini adapter
4. **M4**: external AI chat/response ingestion via the adapter layer
5. **M5**: real-time collaboration (Yjs), presence, permissions
6. **M6**: voice/video, cloud workspaces, remote access

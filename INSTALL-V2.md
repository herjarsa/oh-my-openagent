# Install the V2 port (proven 2026-09-25, v2.0.16 + 1.18.32)

1. Build once at the fork root: `bun run build`
   (emits `dist/index.js` whose default export is `{id, server, setup}`).
2. Single file `~/.config/opencode/plugins/omo-fork.js`:
   `export { default } from "file:///D:/GITHUB/oh-my-openagent-v2-port/dist/index.js";`
   Discovered automatically, no config entry needed.
3. Restart the server. Verify: `plugin list` shows the ID,
   `debug agents` shows all 10 OMO agents.

Same file serves the 1.18 CLI (V1 `.server`) and v2 (`.setup`).
Rebuild + restart after pulling new commits.

Rejected: bare/dir/file:// config entries (ignored), plugins-dir
junction (ignored), `plugin add` git spec (npm install fails).

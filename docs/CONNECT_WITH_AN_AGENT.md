# Connect Codex Canvas with an agent

The intended setup is agent-operated. A person should not need to discover ports, copy two credentials, or understand the sidecar protocol.

Repository: [github.com/adamholter/tldraw-codex-canvas](https://github.com/adamholter/tldraw-codex-canvas)

## Prompt to give an agent

Paste this into a local coding agent that can use the terminal:

> Set up Codex Canvas from https://github.com/adamholter/tldraw-codex-canvas. Clone or update it, install its dependencies, run `npm run setup`, then start `codex-canvas` in a retained terminal session. Keep the connector running, open the complete pairing URL it prints in an isolated browser tab, and verify the status says Live. If an older sidecar owns the default port, reuse it when it belongs to this project or choose the next free port. Do not ask me to manually copy a token unless automatic pairing fails.

The agent can verify the connector without opening a browser by checking the printed sidecar URL's `/health` endpoint. The complete pairing URL carries both the public sidecar address and the random token in its URL fragment, so the hosted site never receives the token in an HTTP request.

## One-time installation

```bash
npm install
npm run setup
```

After that, the command works from any directory:

```bash
codex-canvas
```

It will:

1. Reuse a healthy Codex Canvas sidecar or start one on the next available local port.
2. Create an HTTPS/WSS tunnel for the hosted canvas.
3. Print the pairing token clearly.
4. Print and copy the complete auto-pairing URL.

Keep the command running while using the canvas. `Ctrl-C` closes the tunnel and any sidecar started by that command.

## Development mode

For local web development, run the web client and raw sidecar separately:

```bash
npm run dev
npm run sidecar:local
```

The normal `codex-canvas` and `npm run sidecar` commands target the hosted client and do not require the local web development server.

# Codex Canvas

A local-first tldraw canvas with a small Codex sidecar. The browser streams live canvas state to the sidecar; Codex can inspect and change the canvas through a CLI or arbitrary JavaScript against tldraw's full `Editor` API.

Hosted client: [codex-canvas.adamholter.chatgpt.site](https://codex-canvas.adamholter.chatgpt.site)

## Install once

Requires Node 22+, the `codex` CLI, and an authenticated local Codex installation.

```bash
npm install
npm run setup
```

After that, start the complete connector from any terminal:

```bash
codex-canvas
```

It starts or reuses the local sidecar, creates the web tunnel, prints the pairing token, and copies a complete auto-pairing URL to the clipboard. Keep it running while using the canvas. The token stays in the URL fragment and browser storage; it is not sent to the web host.

`npm run sidecar` is the equivalent project-local command. It does not require `npm run dev`.

For local web development, use `npm run dev` and `npm run sidecar:local` in separate terminals.

## Production tldraw license

tldraw 4+ requires a tldraw SDK license key on production HTTPS domains. Without one, the SDK intentionally hides the editor after five seconds. Local HTTP development does not require a key.

Get a [trial, hobby, or commercial key](https://tldraw.dev/sdk-features/license-key), then configure it before building:

```bash
cp .env.example .env.local
# Add your public, domain-bound key as VITE_TLDRAW_LICENSE_KEY
npm run build
```

The key is compiled into the browser bundle by design; tldraw documents these keys as safe to expose because they are validated client-side and restricted by license terms and allowed domains. Every downstream production deployment must use its own valid tldraw license.

## Use the hosted canvas with your local Codex

Keep this running:

```bash
npm run sidecar:web -- --web-url https://YOUR-DEPLOYED-CANVAS.example
```

Open the `Hosted canvas:` URL it prints. The helper creates an ephemeral HTTPS/WSS tunnel to the token-protected local sidecar. It prefers `cloudflared` when installed and falls back to an SSH Serveo tunnel if the anonymous Cloudflare service is unavailable. Both paths support WebSockets. Closing the command closes both the sidecar and tunnel.

For agent-operated installation and a copy-paste prompt, see [Connect Codex Canvas with an agent](./docs/CONNECT_WITH_AN_AGENT.md).

## Give an agent canvas access

Codex processes launched by the sidecar receive `CANVAS_SIDECAR_URL`, `CANVAS_TOKEN`, and this project's `bin` directory on `PATH`. The included [AGENTS.md](./AGENTS.md) teaches the agent the interface.

The small command surface covers common actions:

```bash
canvasctl snapshot
canvasctl create '{"type":"note","x":100,"y":100,"props":{"text":"Hello"}}'
canvasctl image /absolute/path/image.png --x 100 --y 100
canvasctl zoomToFit
```

The escape hatch is intentionally broad:

```bash
canvasctl eval 'editor.createShape({type:"geo",x:50,y:50,props:{geo:"ellipse",w:240,h:160}}); return {ok:true}'
canvasctl eval --file /absolute/path/to/script.js
```

`eval` runs async JavaScript in the connected browser with access to the live tldraw `editor`. That means an agent is not limited to a fixed list of tools and can use new tldraw capabilities without changing the sidecar protocol.

## HTTP interface

Every API call requires `Authorization: Bearer $CANVAS_TOKEN`.

- `GET /api/snapshot` — compact current page state
- `GET /api/snapshot?full=1` — complete tldraw store snapshot
- `POST /api/command` — `{ "action": "create|update|delete|image|eval|clear|zoomToFit", "payload": ... }`
- `POST /api/assets` — upload a base64-encoded image for placement

The canvas and Codex WebSocket paths include the random pairing token, and browser origins are allowlisted. Do not publish or commit pairing URLs.

## Embed it elsewhere

The chat panel is the actual complete `CodexChatEmbed` from `t3-code-ultralight-browser-fork`, not a local transcript approximation. It preserves separate Codex messages, image upload/paste/drop, sent-image previews, message copy, reasoning, tool calls, approvals, Markdown, streaming, and the T3-derived composer while the connector supplies token-scoped transport paths.

An existing web app can reuse the same component and copy the small canvas connection module from `app/canvas-app.tsx`, then keep its own canvas, voice controls, or surrounding layout. Canvas operations remain framework-independent HTTP/WebSocket messages.

This project's integration code is MIT licensed. The tldraw SDK dependency remains under the separate [tldraw SDK license](https://tldraw.dev/community/license); it is source-available rather than MIT-licensed.

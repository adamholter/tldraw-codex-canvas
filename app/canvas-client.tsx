"use client";

import dynamic from "next/dynamic";

function CanvasLoading() {
  return (
    <main className="app-shell" aria-label="Loading Codex Canvas">
      <section className="canvas-stage">
        <div className="canvas-loading" role="status" aria-label="Loading canvas" />
      </section>
      <aside className="sidecar-panel" />
    </main>
  );
}

const ClientOnlyCanvasApp = dynamic(
  () => import("./canvas-app").then((module) => ({ default: module.CanvasApp })),
  { ssr: false, loading: CanvasLoading },
);

export function CanvasClient() {
  return <ClientOnlyCanvasApp />;
}

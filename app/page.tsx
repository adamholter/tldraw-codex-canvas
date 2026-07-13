import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Codex Canvas",
  description: "A live tldraw canvas connected to your local Codex.",
};

export default function Home() {
  return (
    <iframe
      className="app-frame"
      src="/canvas-frame/index.html"
      title="Codex Canvas"
      allow="clipboard-read; clipboard-write"
    />
  );
}

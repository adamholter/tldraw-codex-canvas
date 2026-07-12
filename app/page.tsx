import type { Metadata } from "next";
import { CanvasApp } from "./canvas-app";

export const metadata: Metadata = {
  title: "Codex Canvas",
  description: "A live tldraw canvas connected to your local Codex.",
};

export default function Home() {
  return <CanvasApp />;
}

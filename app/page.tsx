import type { Metadata } from "next";
import { CanvasClient } from "./canvas-client";

export const metadata: Metadata = {
  title: "Codex Canvas",
  description: "A live tldraw canvas connected to your local Codex.",
};

export default function Home() {
  return <CanvasClient />;
}

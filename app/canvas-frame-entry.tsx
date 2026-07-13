import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CanvasApp } from "./canvas-app";
import "./globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Canvas frame root was not found");

createRoot(root).render(
  <StrictMode>
    <CanvasApp />
  </StrictMode>,
);

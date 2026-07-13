import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/canvas-frame/",
  root: "frame",
  envDir: "..",
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: "../public/canvas-frame",
    emptyOutDir: true,
  },
});

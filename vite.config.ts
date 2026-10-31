import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ command, isPreview }) => ({
  plugins: [react()],
  server: {
    proxy: {
      "/api/discovery": "http://127.0.0.1:3002",
      "/api/music": "http://127.0.0.1:3002",
    },
  },
  base:
    process.env.VITE_BASE_PATH ||
    (command === "build" || isPreview ? "/NoteSound/" : "/"),
  build: { target: "es2022", chunkSizeWarningLimit: 600 },
}));

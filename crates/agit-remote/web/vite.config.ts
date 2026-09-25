import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The relay serves the built files under /console/ and embeds them in its binary.
export default defineConfig({
  base: "/console/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1024,
  },
});

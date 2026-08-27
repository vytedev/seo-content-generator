import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { LOCAL_API_ORIGIN, LOCAL_FRONTEND_PORT } from "./src/shared/local-runtime.js";

function conciseDevOutput(): Plugin {
  let watchBuild = false;
  return {
    name: "mm03-concise-dev-output",
    configResolved(config) {
      watchBuild = Boolean(config.build.watch);
    },
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        console.log("Frontend:    http://127.0.0.1:5173/");
      });
    },
    buildStart() {
      if (watchBuild) console.log("Watching client files for changes…");
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), conciseDevOutput()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/client", import.meta.url)),
    },
  },
  build: { outDir: "dist/client", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: LOCAL_FRONTEND_PORT,
    strictPort: true,
    proxy: { "/api": LOCAL_API_ORIGIN },
  },
});

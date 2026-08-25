import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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

const rawContainerDev = process.env.CONTAINER_DEV?.trim().toLowerCase();
if (rawContainerDev && !new Set(["true", "false"]).has(rawContainerDev)) {
  throw new Error("CONTAINER_DEV must be exactly 'true' or 'false' when set.");
}
const containerDev = rawContainerDev === "true";

export default defineConfig({
  plugins: [react(), tailwindcss(), conciseDevOutput()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/client", import.meta.url)),
    },
  },
  build: { outDir: "dist/client", emptyOutDir: true },
  server: {
    host: containerDev ? "0.0.0.0" : "127.0.0.1",
    port: containerDev ? 3000 : 5173,
    strictPort: true,
    allowedHosts: containerDev ? ["content-generator.vyte.dev"] : [],
    ...(containerDev
      ? {
          hmr: {
            protocol: "wss" as const,
            host: "content-generator.vyte.dev",
            clientPort: 443,
          },
        }
      : {}),
    proxy: { "/api": "http://127.0.0.1:3100" },
  },
});

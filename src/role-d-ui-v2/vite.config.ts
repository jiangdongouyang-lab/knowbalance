import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

const orchestratorTarget = "http://127.0.0.1:8787"

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: {
    proxy: {
      "/health": orchestratorTarget,
      "/orchestrator": orchestratorTarget,
    },
  },
  preview: {
    proxy: {
      "/health": orchestratorTarget,
      "/orchestrator": orchestratorTarget,
    },
  },
  build: {
    outDir: resolve(__dirname, "../../dist/role-d-ui-v2"),
    emptyOutDir: true,
  },
})

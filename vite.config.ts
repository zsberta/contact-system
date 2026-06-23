import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig(() => ({
  server: {
    // Bind to loopback only — exposes the dev server to localhost, not the LAN.
    // The old `host: "::"` was convenient but dangerous on shared Wi-Fi.
    host: "127.0.0.1",
    port: 8080,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.headers["x-xsrf-token"]) {
              proxyReq.setHeader("X-XSRF-TOKEN", req.headers["x-xsrf-token"]);
            }
          });
        },
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));

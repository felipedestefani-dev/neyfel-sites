import { defineConfig, loadEnv } from "vite";

function normalizeTarget(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/\/+$/u, "");
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = normalizeTarget(env.VITE_SUPABASE_URL);
  const useDevProxy = mode === "development" && /^https:\/\/.+\.supabase\.co$/iu.test(target);

  return {
    root: ".",
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    server: {
      proxy: useDevProxy
        ? {
            "/__supabase": {
              target,
              changeOrigin: true,
              secure: true,
              rewrite: (path) => path.replace(/^\/__supabase/, "") || "/",
              configure(proxy) {
                const k = env.VITE_SUPABASE_ANON_KEY?.trim();
                if (!k) return;
                proxy.on("proxyReq", (proxyReq) => {
                  if (!proxyReq.getHeader("apikey")) {
                    proxyReq.setHeader("apikey", k);
                  }
                });
              },
            },
          }
        : {},
    },
  };
});

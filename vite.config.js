import fs from "node:fs";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * When AGENTFLOW_DEV_SAVE_DIR is set (e.g. in .env.local), GET/POST /__agentflow/file
 * reads and writes markdown under that folder via the dev server (no browser file picker).
 */
function attachAgentflowDevRoutes(middlewares, rootRaw) {
  const trimmed = String(rootRaw || "").trim();
  const root = trimmed ? path.resolve(trimmed) : "";
  const valid = Boolean(root && fs.existsSync(root) && fs.statSync(root).isDirectory());

  if (!valid) {
    middlewares.use((req, res, next) => {
      const pathname = (req.url || "").split("?")[0];
      if (pathname === "/__agentflow/status" && req.method === "GET") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ enabled: false }));
        return;
      }
      next();
    });
    return;
  }

  function resolveSafe(name) {
    const stripped = path.basename(String(name || "AGENTS.md")).replace(/[^\w.\-]/g, "");
    const n = stripped || "AGENTS.md";
    if (!/\.(md|txt)$/i.test(n)) {
      throw new Error("only .md or .txt files are allowed");
    }
    const full = path.resolve(path.join(root, n));
    const rel = path.relative(root, full);
    if (rel.startsWith(".." + path.sep) || rel === ".." || path.isAbsolute(rel)) {
      throw new Error("invalid path");
    }
    return full;
  }

  middlewares.use((req, res, next) => {
    const rawUrl = req.url || "";
    const pathname = rawUrl.split("?")[0];

    if (pathname === "/__agentflow/status" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ enabled: true, root: path.basename(root) }));
      return;
    }

    if (pathname === "/__agentflow/file" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      try {
        const q = new URL(rawUrl, "http://vite.local").searchParams.get("name");
        const fp = resolveSafe(q || "AGENTS.md");
        let content = "";
        if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          content = fs.readFileSync(fp, "utf8");
        }
        res.end(JSON.stringify({ content, name: path.basename(fp) }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
      return;
    }

    if (pathname === "/__agentflow/file" && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = raw ? JSON.parse(raw) : {};
          const fp = resolveSafe(body.name);
          fs.writeFileSync(fp, body.content ?? "", "utf8");
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String((e && e.message) || e) }));
        }
      });
      req.on("error", () => {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "request error" }));
        }
      });
      return;
    }

    next();
  });
}

function agentflowDevSavePlugin(rootDir) {
  const raw = (rootDir || "").trim();
  return {
    name: "agentflow-dev-save",
    configureServer(server) {
      attachAgentflowDevRoutes(server.middlewares, raw);
      const abs = raw ? path.resolve(raw) : "";
      if (raw && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        server.config.logger.info("[agentflow] dev disk save on (from env AGENTFLOW_DEV_SAVE_DIR)");
      } else if (raw) {
        server.config.logger.warn("[agentflow] AGENTFLOW_DEV_SAVE_DIR is set but not a valid directory");
      }
    },
    configurePreviewServer(server) {
      attachAgentflowDevRoutes(server.middlewares, raw);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), agentflowDevSavePlugin(env.AGENTFLOW_DEV_SAVE_DIR || "")],
    base: "./",
  };
});

# Agents.md Flowchart

Visual editor for **AGENTS.md**-style agent workflows: graph nodes, condition branches, and markdown round-trip (parse and serialize).

Built with **Vite**, **React**, and **React Flow (xyflow)**. Layout uses **Dagre**.

## Run locally

```bash
npm ci
npm run dev
```

Then open the URL Vite prints (default `http://localhost:5173`).

## Optional: save markdown to a folder in dev

Set `AGENTFLOW_DEV_SAVE_DIR` in `.env.local` to an absolute path of a directory. The dev server exposes read/write helpers under `/__agentflow/` (see `vite.config.js`). Without it, use **Open** / **Save as** in the app (browser file access where supported).

## Scripts

- `npm run dev` — dev server
- `npm run build` — production build to `dist/`
- `npm run preview` — preview production build

## License

Use and modify at your own discretion unless a `LICENSE` file is added later.

import dagre from "dagre";

const NODE_W = 200;
const NODE_H = 72;

export function layoutNodes(nodes, transitions) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 64 });

  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  }
  for (const e of transitions) {
    if (e.source && e.target && nodes.some((n) => n.id === e.source) && nodes.some((n) => n.id === e.target)) {
      g.setEdge(e.source, e.target);
    }
  }

  dagre.layout(g);

  const positions = {};
  for (const n of nodes) {
    const node = g.node(n.id);
    if (node) {
      positions[n.id] = {
        x: node.x - NODE_W / 2,
        y: node.y - NODE_H / 2,
      };
    } else {
      positions[n.id] = { x: 0, y: 0 };
    }
  }

  for (const n of nodes) {
    if (n.type !== "condition") continue;
    const trueTarget = (n.transitions || []).find((t) => t.kind === "if" && t.target)?.target;
    const falseTarget = (n.transitions || []).find((t) => t.kind === "else" && t.target)?.target;
    if (!trueTarget || !falseTarget || trueTarget === falseTarget) continue;
    const truePos = positions[trueTarget];
    const falsePos = positions[falseTarget];
    if (!truePos || !falsePos) continue;
    if (falsePos.x > truePos.x) {
      const tx = truePos.x;
      truePos.x = falsePos.x;
      falsePos.x = tx;
    }
  }

  return positions;
}

export function transitionsToEdges(nodes) {
  const edges = [];
  let ei = 0;
  for (const n of nodes) {
    for (const t of n.transitions || []) {
      if (!t.target || t.target === n.id) continue;
      if (!nodes.some((x) => x.id === t.target)) continue;
      const short =
        t.kind === "if"
          ? `true -> ${t.target}`
          : t.kind === "else"
            ? `false -> ${t.target}`
            : t.kind === "next"
              ? `next -> ${t.target}`
              : `${t.kind} -> ${t.target}`;
      const cond = String(t.condition || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
      edges.push({
        id: `e:${n.id}:${t.target}:${t.kind}:${cond}:${ei++}`,
        source: n.id,
        sourceHandle: t.kind === "if" ? "true" : t.kind === "else" ? "false" : undefined,
        target: t.target,
        targetHandle: "in",
        label: short,
        data: { kind: t.kind, condition: t.condition || "" },
      });
    }
  }
  return edges;
}

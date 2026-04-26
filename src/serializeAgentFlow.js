/**
 * Serialize preamble + nodes back to AGENTS.md style.
 */

function transitionsToMd(node) {
  const lines = [];
  const { transitions = [] } = node;

  const nexts = transitions.filter((t) => t.kind === "next");
  const ifs = transitions.filter((t) => t.kind === "if");
  const elses = transitions.filter((t) => t.kind === "else");
  const gotos = transitions.filter((t) => t.kind === "goto");

  for (const t of ifs) {
    lines.push("");
    lines.push(`**If** ${t.condition || "condition"}:`);
    lines.push("");
    lines.push(`Go to \`${t.target}\`.`);
  }
  if (elses.length) {
    lines.push("");
    lines.push("**Else:**");
    lines.push("");
    for (const t of elses) {
      lines.push(`Go to \`${t.target}\`.`);
    }
  }
  for (const t of nexts) {
    lines.push("");
    lines.push(`**Next:** \`${t.target}\``);
  }
  for (const t of gotos) {
    if (ifs.some((x) => x.target === t.target)) continue;
    if (elses.some((x) => x.target === t.target)) continue;
    if (nexts.some((x) => x.target === t.target)) continue;
    lines.push("");
    lines.push(`Go to \`${t.target}\`.`);
  }

  return lines.join("\n");
}

export function serializeAgentFlow({ preamble, nodes }) {
  const parts = [];
  parts.push(preamble.trimEnd());
  if (nodes.length) parts.push("");
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    parts.push(`## NODE: ${n.id}`);
    parts.push("");
    parts.push(`**Type:** ${n.type || "action"}`);
    parts.push("");
    parts.push("**Instruction:**");
    parts.push("");
    parts.push((n.instruction || "").trim());
    parts.push(transitionsToMd(n));
    parts.push("");
    parts.push("---");
    if (i < nodes.length - 1) parts.push("");
  }
  return parts.join("\n").replace(/\n---\n$/s, "").trimEnd() + "\n";
}

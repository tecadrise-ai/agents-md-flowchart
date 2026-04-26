/**
 * Parse MD-native agent flow: preamble + ## NODE: ID blocks.
 */

function extractInstruction(block) {
  const m = block.match(
    /\*\*Instruction:\*\*\s*([\s\S]*?)(?=\n---\n|\n## NODE:|\*\*(?:If|Else|Next):|\n(?!\s*\d+\.\s)\s*\*\*If\*\*|\n\*\*Else:|\n\*\*Next:|\s*$)/i
  );
  if (m) return m[1].trim();
  const m2 = block.match(/\*\*Instruction:\*\*\s*([\s\S]+)/i);
  return m2 ? m2[1].trim() : "";
}

function extractTransitions(block) {
  const transitions = [];
  const nextM = block.match(/\*\*Next:\*\*\s*`([^`]+)`/i);
  if (nextM) transitions.push({ kind: "next", target: nextM[1].trim() });

  const ifBlockRe =
    /(?:^|\n)(?!\s*\d+\.\s)\s*\*\*If\*\*([\s\S]*?)(?=\n\s*(?!\d+\.\s)\*\*If\*\*|\n\s*\*\*Else:|\n---\n|\n## NODE:|$)/gi;
  for (const im of block.matchAll(ifBlockRe)) {
    const chunk = im[1];
    if (!chunk || !chunk.trim()) continue;
    const condLine = chunk.match(/^\s*(.+?)(?:\n|$)/);
    const condition = condLine ? condLine[1].trim() : "";
    const go = [...chunk.matchAll(/Go to `([^`]+)`/g)];
    for (const g of go) {
      transitions.push({ kind: "if", condition, target: g[1].trim() });
    }
  }

  const numberedIfRe = /\n\s*\d+\.\s*\*\*If\*\*(.+?)Go to `([^`]+)`/gi;
  for (const im of block.matchAll(numberedIfRe)) {
    const condition = im[1].trim();
    const target = im[2].trim();
    const dup = transitions.some((x) => x.kind === "if" && x.target === target && x.condition === condition);
    if (!dup) transitions.push({ kind: "if", condition, target });
  }

  const elseM = block.match(/\*\*Else:\*\*\s*([\s\S]*?)(?=\n---\n|\n## NODE:|\*\*If|\*\*Next:|\n\*\*If|\n\*\*Next|$)/i);
  if (elseM) {
    const chunk = elseM[1];
    const go = [...chunk.matchAll(/Go to `([^`]+)`/g)];
    for (const g of go) {
      transitions.push({ kind: "else", target: g[1].trim() });
    }
  }

  const bareGo = [...block.matchAll(/(?:^|\n)(?!\s*\d+\.\s)\s*Go to `([^`]+)`\s*\.?/gm)];
  for (const g of bareGo) {
    const t = g[1].trim();
    const covered = transitions.some(
      (x) => x.target === t && (x.kind === "if" || x.kind === "else" || x.kind === "next")
    );
    if (covered) continue;
    if (!transitions.some((x) => x.target === t && x.kind === "goto")) {
      transitions.push({ kind: "goto", target: t });
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const tr of transitions) {
    const key = `${tr.kind}|${tr.condition || ""}|${tr.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tr);
  }
  return deduped;
}

export function parseAgentFlow(md) {
  const text = md.replace(/\r\n/g, "\n");
  const re = /^## NODE:\s*(.+)\s*$/gm;
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push({ index: m.index, id: m[1].trim() });
  }
  if (hits.length === 0) {
    return { preamble: text.trimEnd(), nodes: [] };
  }
  const preamble = text.slice(0, hits[0].index).trimEnd();
  const nodes = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    const block = text.slice(start, end);
    const id = hits[i].id;
    const typeM = block.match(/\*\*Type:\*\*\s*(\S+)/i);
    const type = typeM ? typeM[1].trim() : "action";
    const instruction = extractInstruction(block);
    const transitions = extractTransitions(block);
    nodes.push({ id, type, instruction, transitions });
  }
  return { preamble, nodes };
}

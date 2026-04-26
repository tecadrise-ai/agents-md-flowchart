import { useCallback, useMemo, useState, useRef, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  applyNodeChanges,
  applyEdgeChanges,
  MarkerType,
  Position,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { parseAgentFlow } from "./parseAgentFlow";
import { serializeAgentFlow } from "./serializeAgentFlow";
import { layoutNodes, transitionsToEdges } from "./layoutGraph";
import "./App.css";

/** In-memory handle; mirrored to IndexedDB and to Vite HMR state (module scope resets on every HMR). */
let diskFileHandle = null;

const viteHot = typeof import.meta !== "undefined" && import.meta.hot;
if (viteHot?.data?.diskFileHandle) {
  diskFileHandle = viteHot.data.diskFileHandle;
}

function setDiskHandle(handle) {
  diskFileHandle = handle;
  if (viteHot) {
    viteHot.data.diskFileHandle = handle;
  }
}

const IDB_NAME = "agentflow-editor-v1";
const IDB_STORE = "kv";
const IDB_HANDLE_KEY = "diskFileHandle";
const SESSION_DRAFT_KEY = "agentflow-editor-v1-session-draft";

function readSessionDraftParsed() {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_DRAFT_KEY);
    if (raw == null || raw === "") return null;
    return parseAgentFlow(raw);
  } catch {
    return null;
  }
}

function mergeWithSessionIfDiskEmpty(parsedFromDisk) {
  const hasDisk =
    (parsedFromDisk.nodes && parsedFromDisk.nodes.length > 0) ||
    String(parsedFromDisk.preamble || "").trim().length > 0;
  if (hasDisk) return parsedFromDisk;
  const s = readSessionDraftParsed();
  if (s && ((s.nodes && s.nodes.length > 0) || String(s.preamble || "").trim().length > 0)) return s;
  return parsedFromDisk;
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function persistDiskFileHandle(handle) {
  if (!handle || typeof indexedDB === "undefined") return;
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(handle, IDB_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

async function loadDiskFileHandleFromDb() {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await idbOpen();
    const h = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const r = tx.objectStore(IDB_STORE).get(IDB_HANDLE_KEY);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return h;
  } catch {
    return null;
  }
}

async function clearDiskFileHandleFromDb() {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(IDB_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

/** Write markdown to disk; on open-picker handles read is granted first, so createWritable may need permission. */
async function writeMarkdownToDisk(handle, md) {
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  let writable;
  try {
    writable = await handle.createWritable();
  } catch (first) {
    const n = first && first.name;
    if (n !== "NotAllowedError" && n !== "SecurityError") throw first;
    if (typeof handle.requestPermission !== "function") throw first;
    const st = await handle.requestPermission({ mode: "readwrite" });
    if (st !== "granted") throw first;
    writable = await handle.createWritable();
  }
  try {
    await writable.write(blob);
    await writable.close();
  } catch (e) {
    try {
      await writable.close();
    } catch {
      /* ignore */
    }
    throw e;
  }
}

const proOptionsStatic = { hideAttribution: true };

const filePickerId = "agentflow-editor-md";

const markdownPickerTypes = [
  {
    description: "Markdown",
    accept: { "text/markdown": [".md"], "text/plain": [".md", ".txt"] },
  },
];

function downloadMarkdownBlob(fileName, md) {
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName || "AGENTS.md";
  a.click();
  URL.revokeObjectURL(a.href);
}

const defaultEdgeOptions = {
  labelStyle: { fontSize: 11, fontWeight: 500, fill: "#333" },
  labelBgPadding: [4, 6],
  labelBgBorderRadius: 4,
  labelBgStyle: { fill: "#fff", fillOpacity: 0.95 },
};

function FlowNode({ data }) {
  const isCondition = data.nodeType === "condition";
  return (
    <div className={`flow-node ${isCondition ? "flow-node-condition" : ""}`}>
      <Handle id="in" type="target" position={Position.Top} />
      <div className="flow-node-label">{data.label}</div>
      {isCondition ? (
        <div className="condition-ports" aria-hidden="true">
          <span>False</span>
          <span>True</span>
        </div>
      ) : null}
      {isCondition ? (
        <>
          <Handle id="false" type="source" position={Position.Bottom} className="condition-handle false-handle" />
          <Handle id="true" type="source" position={Position.Bottom} className="condition-handle true-handle" />
        </>
      ) : (
        <Handle id="out" type="source" position={Position.Bottom} />
      )}
    </div>
  );
}

const nodeTypes = { agentNode: FlowNode };

function docToRfNodes(doc) {
  return doc.nodes.map((n, i) => ({
    id: n.id,
    type: "agentNode",
    position: { x: n.x ?? (i % 4) * 260, y: n.y ?? Math.floor(i / 4) * 120 },
    data: { label: n.id, nodeType: n.type, instruction: n.instruction || "" },
  }));
}

function docToRfEdges(doc) {
  return transitionsToEdges(doc.nodes).map((e) => ({
    ...e,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
}

function buildNodesFromDoc(doc, prevRf) {
  const posById = new Map(prevRf.map((n) => [n.id, n.position]));
  return doc.nodes.map((n, i) => ({
    id: n.id,
    type: "agentNode",
    position: posById.get(n.id) ?? { x: n.x ?? (i % 4) * 260, y: n.y ?? Math.floor(i / 4) * 120 },
    data: { label: n.id, nodeType: n.type, instruction: n.instruction || "" },
  }));
}

function mergeRfPositionsIntoDoc(doc, rfNodes) {
  const posById = new Map(rfNodes.map((n) => [n.id, n.position]));
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      const p = posById.get(n.id);
      return p ? { ...n, x: p.x, y: p.y } : n;
    }),
  };
}

function applyLayoutToDoc(doc) {
  const pos = layoutNodes(doc.nodes, transitionsToEdges(doc.nodes));
  return {
    ...doc,
    nodes: doc.nodes.map((n) => ({
      ...n,
      x: pos[n.id]?.x ?? n.x ?? 0,
      y: pos[n.id]?.y ?? n.y ?? 0,
    })),
  };
}

function graphStructureKey(doc) {
  return doc.nodes.map((n) => `${n.id}:${n.type}:${JSON.stringify(n.transitions || [])}`).join("|");
}

function nextNodeId(existingIds, nextSeqRef) {
  let seq = Math.max(1, nextSeqRef.current || 1);
  let id = `NODE_${seq}`;
  while (existingIds.has(id)) {
    seq += 1;
    id = `NODE_${seq}`;
  }
  nextSeqRef.current = seq + 1;
  return id;
}

function NodeConfigModal({ nodeId, doc, onClose, onUpdateNode, onDeleteNode, onRenameNode }) {
  const node = doc.nodes.find((n) => n.id === nodeId);
  const [draftId, setDraftId] = useState(node?.id || "");

  useEffect(() => {
    if (node) setDraftId(node.id);
  }, [nodeId, node?.id]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!nodeId || !node) return null;

  const transitions = node.transitions || [];

  const setTransitions = (next) => {
    onUpdateNode(nodeId, { transitions: next });
  };

  const updateTransition = (index, patch) => {
    const next = transitions.map((t, i) => (i === index ? { ...t, ...patch } : t));
    setTransitions(next);
  };

  const removeTransition = (index) => {
    setTransitions(transitions.filter((_, i) => i !== index));
  };

  const addTransition = () => {
    const others = doc.nodes.filter((n) => n.id !== node.id).map((n) => n.id);
    const fallback = others[0] || "";
    setTransitions([...transitions, { kind: "next", target: fallback }]);
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-config-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="node-config-title">Configure task</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="modal-body">
          <label>
            Node ID
            <input
              type="text"
              value={draftId}
              onChange={(e) => setDraftId(e.target.value.replace(/\s+/g, "_"))}
              onBlur={() => {
                const nid = draftId.trim();
                if (!nid || nid === node.id) return;
                onRenameNode(node.id, nid);
              }}
            />
          </label>
          <label>
            Type
            <select value={node.type} onChange={(e) => onUpdateNode(node.id, { type: e.target.value })}>
              <option value="start">start</option>
              <option value="action">action</option>
              <option value="command">command</option>
              <option value="condition">condition</option>
              <option value="loop">loop</option>
              <option value="retry">retry</option>
              <option value="stop">stop</option>
            </select>
          </label>
          <label>
            {node.type === "condition" ? "Condition text" : "Instruction (task text for this step)"}
            <textarea
              className="modal-instruction"
              rows={14}
              value={node.instruction}
              onChange={(e) => onUpdateNode(node.id, { instruction: e.target.value })}
            />
          </label>
          <fieldset className="transitions-fieldset">
            <legend>Outgoing transitions</legend>
            <p className="hint">These match arrows from this node. You can also draw arrows on the canvas.</p>
            {transitions.length === 0 ? (
              <p className="muted">No transitions yet. Add one or connect on the canvas.</p>
            ) : (
              <ul className="transition-list">
                {transitions.map((t, i) => (
                  <li key={`${i}-${t.target}-${t.kind}`} className="transition-row">
                    <select
                      value={t.kind}
                      onChange={(e) => {
                        const kind = e.target.value;
                        const patch = { kind };
                        if (kind !== "if") patch.condition = undefined;
                        else if (!t.condition) patch.condition = "condition";
                        updateTransition(i, patch);
                      }}
                    >
                      <option value="next">next</option>
                      <option value="if">if</option>
                      <option value="else">else</option>
                      <option value="goto">goto</option>
                    </select>
                    {t.kind === "if" && (
                      <input
                        type="text"
                        className="transition-condition"
                        placeholder="Condition"
                        value={t.condition || ""}
                        onChange={(e) => updateTransition(i, { condition: e.target.value })}
                      />
                    )}
                    <select value={t.target} onChange={(e) => updateTransition(i, { target: e.target.value })}>
                      <option value="">Select target</option>
                      {doc.nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.id}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="btn-small" onClick={() => removeTransition(i)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" onClick={addTransition} disabled={doc.nodes.length < 2}>
              Add transition
            </button>
          </fieldset>
        </div>
        <div className="modal-footer">
          <button type="button" className="danger btn-modal-delete" onClick={() => onDeleteNode(node.id)}>
            Delete this node
          </button>
          <button type="button" className="btn-modal-save" onClick={onClose}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function FileViewerModal({ fileName, content, source, onClose, onSave }) {
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyS") {
        e.preventDefault();
        void saveDraft();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, draft]);

  const saveDraft = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } catch (e) {
      window.alert(`Save failed: ${String((e && e.message) || e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal file-viewer-modal" role="dialog" aria-modal="true" aria-labelledby="file-viewer-title">
        <div className="modal-header">
          <div>
            <h2 id="file-viewer-title">{fileName || "AGENTS.md"}</h2>
            <p className="hint file-viewer-source">{source}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="modal-body file-viewer-body">
          <textarea className="file-viewer-text" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        </div>
        <div className="modal-footer file-viewer-footer">
          <button type="button" className="btn-modal-save" onClick={() => void saveDraft()} disabled={saving}>
            {saving ? "Saving..." : "Save file"}
          </button>
        </div>
      </div>
    </div>
  );
}

function InnerEditor({ fileName, setFileName }) {
  const [doc, setDoc] = useState({ preamble: "", nodes: [] });
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [modalNodeId, setModalNodeId] = useState(null);
  const fileInputRef = useRef(null);
  const [devWorkspaceSave, setDevWorkspaceSave] = useState(false);
  const [saveHint, setSaveHint] = useState("");
  const [saveFeedbackType, setSaveFeedbackType] = useState("info");
  const [fileViewer, setFileViewer] = useState(null);
  const devWsRef = useRef(false);
  devWsRef.current = devWorkspaceSave;
  const docRef = useRef(doc);
  docRef.current = doc;
  const positionSyncTimerRef = useRef(null);
  const pendingRfNodesRef = useRef(null);
  const nextNodeSeqRef = useRef(1);
  const saveFeedbackTimerRef = useRef(null);
  const { fitView } = useReactFlow();

  const structureKey = useMemo(() => graphStructureKey(doc), [doc.nodes]);

  const flashSaveFeedback = useCallback((message, type = "info", delay = 3000) => {
    if (saveFeedbackTimerRef.current) {
      clearTimeout(saveFeedbackTimerRef.current);
      saveFeedbackTimerRef.current = null;
    }
    setSaveFeedbackType(type);
    setSaveHint(message);
    if (delay > 0) {
      saveFeedbackTimerRef.current = setTimeout(() => {
        setSaveHint("");
        saveFeedbackTimerRef.current = null;
      }, delay);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (saveFeedbackTimerRef.current) {
        clearTimeout(saveFeedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const maxNumericId = doc.nodes.reduce((max, n) => {
      const m = /^NODE_(\d+)$/.exec(n.id);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    nextNodeSeqRef.current = Math.max(nextNodeSeqRef.current, maxNumericId + 1);
  }, [doc.nodes]);

  useEffect(() => {
    let live = true;
    fetch("/__agentflow/status")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((j) => {
        if (live) setDevWorkspaceSave(!!j.enabled);
      })
      .catch(() => {
        if (live) setDevWorkspaceSave(false);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!devWorkspaceSave) return;
    setDiskHandle(null);
    void clearDiskFileHandleFromDb();
  }, [devWorkspaceSave]);

  const clearPositionSyncTimer = useCallback(() => {
    if (positionSyncTimerRef.current) {
      clearTimeout(positionSyncTimerRef.current);
      positionSyncTimerRef.current = null;
    }
    pendingRfNodesRef.current = null;
  }, []);

  useEffect(() => {
    clearPositionSyncTimer();
    const d = docRef.current;
    setNodes((prev) => buildNodesFromDoc(d, prev));
    setEdges(docToRfEdges(d));
  }, [structureKey, clearPositionSyncTimer]);

  useEffect(() => {
    return () => clearPositionSyncTimer();
  }, [clearPositionSyncTimer]);

  useEffect(() => {
    setSelectedId((id) => {
      if (!id) return id;
      return docRef.current.nodes.some((n) => n.id === id) ? id : null;
    });
    setModalNodeId((id) => {
      if (!id) return id;
      return docRef.current.nodes.some((n) => n.id === id) ? id : null;
    });
  }, [structureKey]);

  const scheduleDocPositionSync = useCallback((rfNodes) => {
    pendingRfNodesRef.current = rfNodes;
    if (positionSyncTimerRef.current) {
      clearTimeout(positionSyncTimerRef.current);
    }
    positionSyncTimerRef.current = setTimeout(() => {
      positionSyncTimerRef.current = null;
      const latest = pendingRfNodesRef.current;
      pendingRfNodesRef.current = null;
      if (!latest || latest.length === 0) return;
      setDoc((d) => mergeRfPositionsIntoDoc(d, latest));
    }, 150);
  }, []);

  const replaceLaidOutDoc = useCallback(
    (nextDoc) => {
      clearPositionSyncTimer();
      const laid = applyLayoutToDoc(nextDoc);
      setDoc(laid);
      setNodes(docToRfNodes(laid));
      setEdges(docToRfEdges(laid));
      setTimeout(() => fitView({ padding: 0.2 }), 0);
    },
    [fitView, clearPositionSyncTimer]
  );

  useEffect(() => {
    if (devWorkspaceSave) return;
    let cancelled = false;
    void (async () => {
      if (navigator.storage?.persist) {
        void navigator.storage.persist();
      }
      const h = await loadDiskFileHandleFromDb();
      if (!h || typeof h.createWritable !== "function") return;
      if (cancelled || devWsRef.current) return;
      setDiskHandle(h);
      try {
        const f = await h.getFile();
        if (cancelled || devWsRef.current) return;
        setFileName(f.name);
        const text = await f.text();
        if (cancelled || devWsRef.current) return;
        const parsed = parseAgentFlow(text);
        const merged = mergeWithSessionIfDiskEmpty(parsed);
        replaceLaidOutDoc({ preamble: merged.preamble, nodes: merged.nodes });
      } catch {
        setDiskHandle(null);
        await clearDiskFileHandleFromDb();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setFileName, devWorkspaceSave, replaceLaidOutDoc]);

  const replaceDocFromMarkdownPreservingView = useCallback(
    (text) => {
      clearPositionSyncTimer();
      const parsed = parseAgentFlow(text);
      const positioned = mergeRfPositionsIntoDoc(docRef.current, nodes);
      const posById = new Map(positioned.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
      const nextDoc = {
        preamble: parsed.preamble,
        nodes: parsed.nodes.map((n, i) => {
          const p = posById.get(n.id);
          return {
            ...n,
            x: p?.x ?? (i % 4) * 260,
            y: p?.y ?? Math.floor(i / 4) * 120,
          };
        }),
      };
      setDoc(nextDoc);
      setNodes(docToRfNodes(nextDoc));
      setEdges(docToRfEdges(nextDoc));
    },
    [clearPositionSyncTimer, nodes]
  );

  const loadFromDevServer = useCallback(async () => {
    const name = fileName || "AGENTS.md";
    const r = await fetch(`/__agentflow/file?name=${encodeURIComponent(name)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText || "load failed");
    const parsed = parseAgentFlow(j.content != null ? String(j.content) : "");
    const merged = mergeWithSessionIfDiskEmpty(parsed);
    replaceLaidOutDoc({ preamble: merged.preamble, nodes: merged.nodes });
    if (j.name) setFileName(String(j.name));
  }, [fileName, replaceLaidOutDoc, setFileName]);

  const devDiskBootRef = useRef(false);
  useEffect(() => {
    if (!devWorkspaceSave || devDiskBootRef.current) return;
    devDiskBootRef.current = true;
    void loadFromDevServer().catch((e) => {
      console.error(e);
      devDiskBootRef.current = false;
    });
  }, [devWorkspaceSave, loadFromDevServer]);

  const onNodesChange = useCallback(
    (changes) => {
      setNodes((nds) => {
        const next = applyNodeChanges(changes, nds);
        scheduleDocPositionSync(next);
        return next;
      });
    },
    [scheduleDocPositionSync]
  );

  const onEdgesChange = useCallback((changes) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  const getMarkdown = useCallback(() => {
    clearPositionSyncTimer();
    const withPos = mergeRfPositionsIntoDoc(doc, nodes);
    const cleanNodes = withPos.nodes.map(({ x, y, ...rest }) => rest);
    return serializeAgentFlow({ preamble: withPos.preamble, nodes: cleanNodes });
  }, [doc, nodes, clearPositionSyncTimer]);

  const getMarkdownRef = useRef(getMarkdown);
  getMarkdownRef.current = getMarkdown;

  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    const has =
      (doc.nodes && doc.nodes.length > 0) || String(doc.preamble || "").trim().length > 0;
    if (!has) return;
    const t = setTimeout(() => {
      try {
        sessionStorage.setItem(SESSION_DRAFT_KEY, getMarkdownRef.current());
      } catch {
        /* ignore */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [doc, nodes]);

  const openFileViewer = useCallback(async () => {
    const name = fileName || "AGENTS.md";
    try {
      if (devWorkspaceSave) {
        const r = await fetch(`/__agentflow/file?name=${encodeURIComponent(name)}`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || r.statusText || "could not read file");
        setFileViewer({
          fileName: j.name ? String(j.name) : name,
          content: j.content != null ? String(j.content) : "",
          source: "Actual file from dev-server disk save.",
        });
        return;
      }

      let handle = diskFileHandle;
      if (!handle) {
        handle = await loadDiskFileHandleFromDb();
        if (handle) setDiskHandle(handle);
      }
      if (handle && typeof handle.getFile === "function") {
        const file = await handle.getFile();
        setFileViewer({
          fileName: file.name || name,
          content: await file.text(),
          source: "Actual file from browser file handle.",
        });
        return;
      }

      setFileViewer({
        fileName: name,
        content: getMarkdown(),
        source: "Current generated markdown preview. No direct disk file is attached.",
      });
    } catch (e) {
      flashSaveFeedback(`Could not open file viewer: ${String((e && e.message) || e)}`, "error", 6000);
    }
  }, [devWorkspaceSave, fileName, flashSaveFeedback, getMarkdown]);

  const saveFileViewerContent = useCallback(
    async (content) => {
      const name = fileViewer?.fileName || fileName || "AGENTS.md";
      if (devWorkspaceSave) {
        const r = await fetch("/__agentflow/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, content }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || r.statusText || "save failed");
        setFileName(name);
        replaceDocFromMarkdownPreservingView(content);
        setFileViewer((v) => (v ? { ...v, content, fileName: name, source: "Actual file from dev-server disk save." } : v));
        flashSaveFeedback(`Saved ${name}.`, "success");
        return;
      }

      let handle = diskFileHandle;
      if (!handle) {
        handle = await loadDiskFileHandleFromDb();
        if (handle) setDiskHandle(handle);
      }
      if (handle && typeof handle.createWritable === "function") {
        await writeMarkdownToDisk(handle, content);
        setDiskHandle(handle);
        await persistDiskFileHandle(handle);
        const file = typeof handle.getFile === "function" ? await handle.getFile() : null;
        const savedName = file?.name || name;
        setFileName(savedName);
        replaceDocFromMarkdownPreservingView(content);
        setFileViewer((v) => (v ? { ...v, content, fileName: savedName, source: "Actual file from browser file handle." } : v));
        flashSaveFeedback(`Saved ${savedName}.`, "success");
        return;
      }

      replaceDocFromMarkdownPreservingView(content);
      setFileViewer((v) => (v ? { ...v, content, source: "Current generated markdown preview. No direct disk file is attached." } : v));
      flashSaveFeedback("Applied markdown to current diagram. No direct disk file is attached.", "info", 5000);
    },
    [devWorkspaceSave, fileName, fileViewer?.fileName, flashSaveFeedback, replaceDocFromMarkdownPreservingView, setFileName]
  );

  const saveAsPickerOrDownload = useCallback(async () => {
    const md = getMarkdown();
    const suggested = fileName || "AGENTS.md";
    if (devWorkspaceSave) {
      const next = window.prompt("File name (.md or .txt)", suggested);
      if (!next || !String(next).trim()) return;
      const name = String(next).trim().replace(/[^\w.\-]/g, "") || suggested;
      try {
        const r = await fetch("/__agentflow/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, content: md }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || r.statusText || "save failed");
        setFileName(name);
        setSaveHint("Saved to disk.");
        setTimeout(() => setSaveHint(""), 2500);
      } catch (e) {
        console.error(e);
        window.alert(String((e && e.message) || e));
      }
      return;
    }
    if ("showSaveFilePicker" in window) {
      try {
        const handle = await window.showSaveFilePicker({
          id: filePickerId,
          suggestedName: suggested,
          types: markdownPickerTypes,
        });
        setFileName(handle.name);
        await writeMarkdownToDisk(handle, md);
        setDiskHandle(handle);
        await persistDiskFileHandle(handle);
      } catch (e) {
        if (e && e.name === "AbortError") return;
        setDiskHandle(null);
        await clearDiskFileHandleFromDb();
        downloadMarkdownBlob(suggested, md);
      }
    } else {
      downloadMarkdownBlob(suggested, md);
    }
  }, [devWorkspaceSave, fileName, getMarkdown]);

  const saveFile = useCallback(async () => {
    const md = getMarkdown();
    flashSaveFeedback("Saving...", "info", 0);
    if (devWorkspaceSave) {
      try {
        const r = await fetch("/__agentflow/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: fileName || "AGENTS.md", content: md }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || r.statusText || "save failed");
        flashSaveFeedback(`Saved ${fileName || "AGENTS.md"} to disk.`, "success");
      } catch (e) {
        console.error(e);
        flashSaveFeedback(`Save failed: ${String((e && e.message) || e)}`, "error", 6000);
      }
      return;
    }
    let handle = diskFileHandle;
    if (!handle) {
      handle = await loadDiskFileHandleFromDb();
      if (handle) setDiskHandle(handle);
    }
    if (handle && typeof handle.createWritable === "function") {
      try {
        await writeMarkdownToDisk(handle, md);
        setDiskHandle(handle);
        await persistDiskFileHandle(handle);
        flashSaveFeedback(`Saved ${fileName || "AGENTS.md"}.`, "success");
        return;
      } catch (e) {
        const name = e && e.name;
        if (name === "NotAllowedError" || name === "SecurityError" || name === "InvalidStateError") {
          setDiskHandle(null);
          await clearDiskFileHandleFromDb();
        } else {
          console.error("Save failed (file handle kept):", e);
          flashSaveFeedback(`Save failed: ${String((e && e.message) || e)}`, "error", 6000);
          return;
        }
      }
    }
    flashSaveFeedback("No direct save target. Use Open first, or enable AGENTFLOW_DEV_SAVE_DIR for dev-server disk save.", "error", 6000);
  }, [devWorkspaceSave, fileName, flashSaveFeedback, getMarkdown]);

  const onOpenFileLegacy = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (devWorkspaceSave) return;
    setDiskHandle(null);
    void clearDiskFileHandleFromDb();
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const parsed = parseAgentFlow(text);
      replaceLaidOutDoc({ preamble: parsed.preamble, nodes: parsed.nodes });
    };
    reader.readAsText(f);
    e.target.value = "";
  };

  const onOpenClick = useCallback(async () => {
    if (devWorkspaceSave) {
      try {
        await loadFromDevServer();
        setSaveHint("Reloaded from disk.");
        setTimeout(() => setSaveHint(""), 2500);
      } catch (e) {
        console.error(e);
        window.alert(String((e && e.message) || e));
      }
      return;
    }
    if ("showOpenFilePicker" in window) {
      let handle = null;
      try {
        const picked = await window.showOpenFilePicker({
          id: filePickerId,
          types: markdownPickerTypes,
          multiple: false,
        });
        handle = picked[0];
      } catch (e) {
        if (e && e.name === "AbortError") return;
        try {
          const picked2 = await window.showOpenFilePicker({ id: filePickerId, multiple: false });
          handle = picked2[0];
        } catch (e2) {
          if (e2 && e2.name === "AbortError") return;
          setSaveHint(`Open failed: ${String((e2 && e2.message) || e2 || "browser did not provide a writable file handle")}`);
          setTimeout(() => setSaveHint(""), 6000);
          return;
        }
      }
      if (!handle) {
        setSaveHint("Open failed: browser did not provide a writable file handle.");
        setTimeout(() => setSaveHint(""), 6000);
        return;
      }
      setDiskHandle(handle);
      await persistDiskFileHandle(handle);
      try {
        if (typeof handle.requestPermission === "function") {
          await handle.requestPermission({ mode: "readwrite" });
        }
      } catch {
        /* write permission can be requested again on Save */
      }
      const file = await handle.getFile();
      setFileName(file.name);
      const text = await file.text();
      const parsed = parseAgentFlow(text);
      replaceLaidOutDoc({ preamble: parsed.preamble, nodes: parsed.nodes });
    } else {
      setSaveHint("This browser does not support direct file saving here. Enable AGENTFLOW_DEV_SAVE_DIR or use Chrome/Edge file access.");
      setTimeout(() => setSaveHint(""), 6000);
    }
  }, [devWorkspaceSave, loadFromDevServer, replaceLaidOutDoc]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyS") {
        e.preventDefault();
        e.stopPropagation();
        void saveFile();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [saveFile]);

  const onAutoLayout = () => {
    replaceLaidOutDoc(doc);
  };

  const onConnect = useCallback(
    (params) => {
      setDoc((d) => ({
        ...d,
        nodes: d.nodes.map((n) => {
          if (n.id !== params.source) return n;
          const fromCondition = n.type === "condition";
          const kind = fromCondition
            ? params.sourceHandle === "false"
              ? "else"
              : "if"
            : "next";
          const condition = kind === "if" ? n.instruction : "";
          const t = { kind, target: params.target };
          if (kind === "if") t.condition = condition || "condition";
          const transitions = [...(n.transitions || [])];
          const dup = transitions.some(
            (x) => x.target === params.target && x.kind === kind && (kind !== "if" || x.condition === t.condition)
          );
          if (!dup) transitions.push(t);
          return { ...n, transitions };
        }),
      }));
    },
    []
  );

  const onEdgesDelete = useCallback((deleted) => {
    const keys = new Set(deleted.map((e) => `${e.source}|${e.target}|${e.data?.kind || "next"}|${e.data?.condition || ""}`));
    setDoc((d) => ({
      ...d,
      nodes: d.nodes.map((n) => ({
        ...n,
        transitions: (n.transitions || []).filter((t) => !keys.has(`${n.id}|${t.target}|${t.kind}|${t.condition || ""}`)),
      })),
    }));
  }, []);

  const onNodesDelete = useCallback(
    (deleted) => {
      const ids = new Set(deleted.map((n) => n.id));
      if (!ids.size) return;
      clearPositionSyncTimer();
      setDoc((d) => ({
        ...d,
        nodes: d.nodes
          .filter((n) => !ids.has(n.id))
          .map((n) => ({
            ...n,
            transitions: (n.transitions || []).filter((t) => !ids.has(t.target)),
          })),
      }));
      setSelectedId((sid) => (ids.has(sid) ? null : sid));
      setModalNodeId((mid) => (ids.has(mid) ? null : mid));
    },
    [clearPositionSyncTimer]
  );

  const addNode = useCallback(() => {
    clearPositionSyncTimer();
    const positioned = mergeRfPositionsIntoDoc(docRef.current, nodes);
    const ids = new Set(positioned.nodes.map((n) => n.id));
    const id = nextNodeId(ids, nextNodeSeqRef);
    const maxX = nodes.length ? Math.max(...nodes.map((n) => n.position.x)) : 80;
    const maxY = nodes.length ? Math.max(...nodes.map((n) => n.position.y)) : 80;
    const newNode = {
      id,
      type: "action",
      instruction: "",
      transitions: [],
      x: maxX + 260,
      y: maxY,
    };
    setDoc({ ...positioned, nodes: [...positioned.nodes, newNode] });
  }, [clearPositionSyncTimer, nodes]);

  const updateNode = useCallback((nodeId, patch) => {
    if (!nodeId) return;
    const { id: patchId, ...rest } = patch;
    const oldId = nodeId;
    let newId = oldId;
    if (patchId !== undefined) {
      const nid = String(patchId).trim().replace(/\s+/g, "_");
      if (!nid) return;
      newId = nid;
    }
    if (patchId !== undefined && newId !== oldId) {
      setSelectedId((sid) => (sid === oldId ? newId : sid));
      setModalNodeId((mid) => (mid === oldId ? newId : mid));
    }
    setDoc((d) => {
      let nodes0 = d.nodes.map((n) => {
        if (n.id !== oldId) return n;
        return { ...n, ...rest, ...(patchId !== undefined ? { id: newId } : {}) };
      });
      if (newId !== oldId) {
        nodes0 = nodes0.map((n) => ({
          ...n,
          transitions: (n.transitions || []).map((t) => (t.target === oldId ? { ...t, target: newId } : t)),
        }));
      }
      return { ...d, nodes: nodes0 };
    });
  }, []);

  const renameNode = useCallback(
    (oldId, newId) => {
      if (!newId || oldId === newId) return;
      updateNode(oldId, { id: newId });
    },
    [updateNode]
  );

  const deleteNode = useCallback((nodeId) => {
    if (!nodeId) return;
    clearPositionSyncTimer();
    const currentRfNodes = nodes.filter((n) => n.id !== nodeId);
    setDoc((d) => {
      const positioned = mergeRfPositionsIntoDoc(d, currentRfNodes);
      return {
        ...positioned,
        nodes: positioned.nodes
        .filter((n) => n.id !== nodeId)
        .map((n) => ({
          ...n,
          transitions: (n.transitions || []).filter((t) => t.target !== nodeId),
        })),
      };
    });
    setSelectedId((sid) => (sid === nodeId ? null : sid));
    setModalNodeId((mid) => (mid === nodeId ? null : mid));
  }, [clearPositionSyncTimer, nodes]);

  const closeModal = useCallback(() => setModalNodeId(null), []);

  const onNodeClick = useCallback((_event, node) => {
    setSelectedId(node.id);
  }, []);

  const onNodeDoubleClick = useCallback((_event, node) => {
    setSelectedId(node.id);
    setModalNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedId(null);
  }, []);

  const selected = useMemo(() => doc.nodes.find((n) => n.id === selectedId), [doc.nodes, selectedId]);

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Agents.md Flowchart</h1>
        {devWorkspaceSave ? (
          <p className="hint toolbar-devhint">
            Dev disk save on: Open and Save use the Vite server (set folder in env AGENTFLOW_DEV_SAVE_DIR, see .env.example).
          </p>
        ) : null}
        <div className="toolbar-actions">
          {!devWorkspaceSave ? (
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,text/markdown"
              className="hidden"
              onChange={onOpenFileLegacy}
            />
          ) : null}
          <button type="button" onClick={() => void onOpenClick()}>
            Open
          </button>
          <button type="button" title="Ctrl+S (Cmd+S on Mac)" onClick={() => void saveFile()}>
            Save
          </button>
          <button type="button" onClick={() => void saveAsPickerOrDownload()}>
            Save as
          </button>
          <button type="button" onClick={onAutoLayout}>
            Auto layout
          </button>
          <button type="button" onClick={addNode}>
            Add node
          </button>
          <button type="button" className="filename-display" onClick={() => void openFileViewer()} title="View current file">
            File: {fileName || "AGENTS.md"}
          </button>
        </div>
        <a className="made-by-link" href="https://TecAdRise.ai" target="_blank" rel="noreferrer">
          Made by: TecAdRise.ai
        </a>
      </header>
      {saveHint ? (
        <div className={`save-toast ${saveFeedbackType}`} role="status" aria-live="polite">
          {saveHint}
        </div>
      ) : null}
      <div className="main">
        <div className="canvas-wrap">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onEdgesDelete={onEdgesDelete}
            onNodesDelete={onNodesDelete}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneClick={onPaneClick}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
            nodeTypes={nodeTypes}
            proOptions={proOptionsStatic}
            defaultEdgeOptions={defaultEdgeOptions}
            style={{ width: "100%", height: "100%" }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <aside className="sidebar">
          <h2>Node</h2>
          {selected ? (
            <>
              <label>
                ID
                <input
                  type="text"
                  value={selected.id}
                  onChange={(e) => updateNode(selected.id, { id: e.target.value.trim().replace(/\s+/g, "_") })}
                />
              </label>
              <label>
                Type
                <select value={selected.type} onChange={(e) => updateNode(selected.id, { type: e.target.value })}>
                  <option value="start">start</option>
                  <option value="action">action</option>
                  <option value="command">command</option>
                  <option value="condition">condition</option>
                  <option value="loop">loop</option>
                  <option value="retry">retry</option>
                  <option value="stop">stop</option>
                </select>
              </label>
              <label>
                {selected.type === "condition" ? "Condition text" : "Instruction"}
                <textarea
                  rows={10}
                  value={selected.instruction}
                  onChange={(e) => updateNode(selected.id, { instruction: e.target.value })}
                />
              </label>
              <p className="hint">Double-click a node for the full task editor. Drag handles to connect nodes.</p>
              <button type="button" className="danger" onClick={() => deleteNode(selected.id)}>
                Delete node
              </button>
            </>
          ) : (
            <p className="muted">Select a node, or double-click a node to configure the task.</p>
          )}
          <h2>Preamble</h2>
          <p className="hint">Markdown before the first ## NODE (title, contract, state).</p>
          <textarea
            className="preamble"
            rows={14}
            value={doc.preamble}
            onChange={(e) => setDoc((d) => ({ ...d, preamble: e.target.value }))}
          />
        </aside>
      </div>
      {modalNodeId && (
        <NodeConfigModal
          nodeId={modalNodeId}
          doc={doc}
          onClose={closeModal}
          onUpdateNode={updateNode}
          onDeleteNode={(id) => {
            deleteNode(id);
            closeModal();
          }}
          onRenameNode={renameNode}
        />
      )}
      {fileViewer && (
        <FileViewerModal
          fileName={fileViewer.fileName}
          content={fileViewer.content}
          source={fileViewer.source}
          onClose={() => setFileViewer(null)}
          onSave={saveFileViewerContent}
        />
      )}
    </div>
  );
}

export default function App() {
  const [fileName, setFileName] = useState("AGENTS.md");
  return (
    <ReactFlowProvider>
      <InnerEditor fileName={fileName} setFileName={setFileName} />
    </ReactFlowProvider>
  );
}

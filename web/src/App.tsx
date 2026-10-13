/**
 * R&D Trust Graph — app shell.
 * Clinical chrome (light) wrapping the dark graph canvas. Three beats; Beat 2
 * (deterministic explanation path) is the hero and is fully wired here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GraphPayload, ExplanationPath, GraphNode, GraphEdge, Provenance, ChangeSet, DossierResult } from "@rnd/shared";
import { NODE_COLORS } from "@rnd/shared";
import { api } from "./api.js";
import { log } from "./lib/log.js";
import { verifiedNodeIds } from "./lib/trust.js";
import { MotionContext } from "./lib/motion.js";
import { GraphCanvas } from "./components/GraphCanvas.js";
import { ExplanationBeat } from "./beats/ExplanationBeat.js";
import { RadarBeat } from "./beats/RadarBeat.js";
import { SafetyRadarBeat } from "./beats/SafetyRadarBeat.js";
import { MultimodalBeat } from "./beats/MultimodalBeat.js";
import { ProvenanceDrawer } from "./components/ProvenanceDrawer.js";
import { EdgeDetailPanel } from "./components/EdgeDetailPanel.js";
import { AskDock } from "./components/AskDock.js";
import { CopilotChatBeat } from "./beats/CopilotChatBeat.js";
import { LiveStatusPill } from "./components/LiveStatusPill.js";
import { AdminPanel } from "./admin/AdminPanel.js";
import { HitlPanel } from "./components/HitlPanel.js";
import { ReviewBell } from "./components/ReviewBell.js";
import { CommandPalette, type Command } from "./components/CommandPalette.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { AccountMenu } from "./components/AccountMenu.js";
import { ToolsMenu, type ToolSection } from "./components/ToolsMenu.js";
import { ContextBar } from "./components/ContextBar.js";
import { FinOpsMeter } from "./finops/FinOpsMeter.js";
import { ReviewerSelector } from "./identity/ReviewerSelector.js";
import { FinOpsDashboard } from "./finops/FinOpsDashboard.js";
import { EvalScorecard } from "./eval/EvalScorecard.js";
import { PlaybookPanel } from "./playbooks/PlaybookPanel.js";
import { SavedDashboardsPanel } from "./dashboards/SavedDashboardsPanel.js";
import { DashboardStudio } from "./dashboards/DashboardStudio.js";
import { GenerativeStudio } from "./generative/GenerativeStudio.js";
import { DossierStory } from "./playbooks/DossierStory.js";
import { Toaster } from "./components/ui/sonner.js";
import { Button } from "./components/ui/button.js";
import "./admin/admin.css";

type Beat = "radar" | "safety" | "explanation" | "multimodal" | "conversation" | "studio" | "generative";
type Mode = "scripted" | "live";

/** A governed-change context handed from the HITL audit log to Beat 4: the change
 *  summary, its node(s) (as real GraphNodes for the grounded context), and an
 *  optional question to auto-submit. `nonce` makes each hand-off a distinct event
 *  so the consumer re-applies it even for the same change. */
export interface ConvoSeed {
  change: { id: string; title: string; summary: string; nodeIds: string[] };
  nodes: GraphNode[];
  question?: string;
  nonce: number;
}

/** Distinct node ids a change touches (target + every op's node/endpoints). */
function changeNodeIds(cs: ChangeSet): string[] {
  const ids = new Set<string>();
  if (cs.targetNodeId) ids.add(cs.targetNodeId);
  for (const op of cs.forwardOps) {
    if ("source" in op) {
      ids.add(op.source);
      ids.add(op.target);
    } else {
      ids.add(op.nodeId);
    }
  }
  return [...ids];
}

/** Plain-English summary of a change's forward ops (for the context chip label). */
function summarizeChange(cs: ChangeSet): string {
  return cs.forwardOps
    .map((op) => {
      switch (op.op) {
        case "addEdge":
          return `link ${op.source}→${op.target} (${op.kind})`;
        case "removeEdge":
          return `unlink ${op.source}→${op.target}`;
        case "setProp":
          return `${op.nodeId}.${op.prop}="${op.value}"`;
        case "unsetProp":
          return `clear ${op.nodeId}.${op.prop}`;
        case "setFlagResolved":
          return `resolve "${op.flag}" on ${op.nodeId}`;
        case "clearFlagResolved":
          return `re-open "${op.flag}" on ${op.nodeId}`;
        case "addManualFlag":
          return `flag "${op.flag}" on ${op.nodeId}`;
        case "removeManualFlag":
          return `unflag "${op.flag}" on ${op.nodeId}`;
        case "addProvenance":
          return `+provenance ${op.nodeId}`;
        case "removeProvenance":
          return `−provenance ${op.nodeId}`;
      }
    })
    .join("; ");
}

const BEAT_LABELS: Record<Beat, string> = {
  radar: "1 · Radar",
  safety: "UC4 · Safety",
  explanation: "2 · Explanation",
  multimodal: "3 · Multimodal",
  conversation: "4 · Conversation",
  studio: "✨ Dashboard Studio",
  generative: "✨ Generative Studio",
};

/**
 * Persist a theme toggle to localStorage so the presenter's chosen look survives
 * a reload mid-demo. First load (no stored value) falls back to `fallback` — so
 * the out-of-the-box default stays war-room / comfortable. Storage access is
 * wrapped: a private-mode / disabled-storage failure must never break the demo,
 * it just degrades to non-persistent toggling.
 */
function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode, quota) — toggling stays in-memory only */
  }
}

export function App() {
  const [mode, setMode] = useState<Mode>("live");
  const [adminOpen, setAdminOpen] = useState(false); // Phase 3b admin surface
  const [finopsOpen, setFinopsOpen] = useState(false); // FinOps dashboard surface
  const [evalOpen, setEvalOpen] = useState(false); // Answer-quality eval scorecard surface
  const [competitiveOpen, setCompetitiveOpen] = useState(false); // F8 synthetic competitive overlay
  const [competitiveOverlay, setCompetitiveOverlay] = useState<GraphPayload>({ nodes: [], edges: [] });
  const [playbookOpen, setPlaybookOpen] = useState(false); // F5 safety-dossier playbooks
  const [savedDashOpen, setSavedDashOpen] = useState(false); // Phase 3 saved dashboards (F9+F10)
  const [storyDossier, setStoryDossier] = useState<DossierResult | null>(null); // full-width narrated story
  const [hitlOpen, setHitlOpen] = useState(false); // HITL mutate+revert surface
  const [paletteOpen, setPaletteOpen] = useState(false); // ⌘K command palette
  const [helpOpen, setHelpOpen] = useState(false); // ? help / shortcuts overlay
  // Bump to force the beats (RadarBeat/ExplanationBeat) to refetch graph+risk
  // after a governed HITL apply/revert mutates the graph.
  const [graphVersion, setGraphVersion] = useState(0);
  const [lightCanvas, setLightCanvas] = useState(false); // projector-survival toggle
  // Two-axis theme — persisted to localStorage so a presenter's choice survives
  // reload. First-ever load defaults to war-room / comfortable (the shipped look).
  const [skin, setSkin] = useState<"warroom" | "boardroom">(() =>
    readStored("rtg.skin", ["warroom", "boardroom"] as const, "warroom"),
  );
  const [density, setDensity] = useState<"comfortable" | "compact">(() =>
    readStored("rtg.density", ["comfortable", "compact"] as const, "comfortable"),
  );
  // Signature graph flow. App-level toggle (default ON) that OVERRIDES the OS
  // reduce-motion policy — locked-down machines report "reduce" and would
  // otherwise hide the flowing edges everywhere. Persisted like the theme axes.
  const [motion, setMotion] = useState<boolean>(
    () => readStored("rtg.motion", ["on", "off"] as const, "on") === "on",
  );
  const [beat, setBeat] = useState<Beat>("explanation");
  const [health, setHealth] = useState<{ ok: boolean; liveMode: boolean; model: string }>();
  const [graph, setGraph] = useState<GraphPayload>({ nodes: [], edges: [] });
  const [path, setPath] = useState<ExplanationPath>();

  // Provenance drawer
  const [drawer, setDrawer] = useState<{ node: GraphNode; prov: Provenance | null } | null>(null);
  // The edge whose detail/tag panel is open (mirror of `drawer` for relationships).
  const [edgeDrawer, setEdgeDrawer] = useState<GraphEdge | null>(null);
  // Nodes clicked on the canvas, accumulated as the floating AskDock's context
  // (a removable chip each + grounded question pills). Independent of the drawer so
  // dismissing a dock chip doesn't close the provenance drawer, and vice-versa.
  const [dockNodes, setDockNodes] = useState<GraphNode[]>([]);
  // A governed-change context handed from the HITL audit log to Beat 4 (the
  // grounded conversation). Bumping `nonce` re-triggers the consumer each hand-off.
  const [convoSeed, setConvoSeed] = useState<ConvoSeed | null>(null);

  // Human-verified node ids (incident HUMAN_APPROVED edges) — drives the dossier's
  // verified chip. Derived purely from the served graph payload.
  const verifiedSet = useMemo(() => verifiedNodeIds(graph), [graph]);

  // Live-readiness snapshot. Fetched on mount AND re-fetched whenever the
  // presenter flips Mode back to "live", so the toggle reflects current
  // reality instead of the boot snapshot (the "stuck on scripted" bug).
  const refreshHealth = useCallback(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false, liveMode: false, model: "" }));
  }, []);
  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  // Graph + explanation path: refetched on mount AND after any HITL apply/revert
  // (graphVersion bump) so a governed mutation is reflected on the canvas live.
  useEffect(() => {
    api.graph("hero").then(setGraph).catch((e) => log.error("graph(hero) load failed:", e));
    api.explain().then(setPath).catch((e) => log.error("explain() load failed:", e));
  }, [graphVersion]);

  // F8 — fetch the synthetic competitive overlay lazily the first time it's toggled
  // on. It's a SEPARATE payload, merged client-side below; it never enters the
  // grounding allow-list (those ids are not in Neo4j), so it can never be cited.
  useEffect(() => {
    if (competitiveOpen && competitiveOverlay.nodes.length === 0) {
      api.competitiveOverlay().then(setCompetitiveOverlay).catch((e) => log.error("competitiveOverlay() load failed:", e));
    }
  }, [competitiveOpen, competitiveOverlay.nodes.length]);

  // The graph passed to the canvas-bearing beats. When the overlay is on, synthetic
  // nodes are merged CLIENT-SIDE (tagged synthetic) and rendered dashed; the agent's
  // grounding set is unaffected because it reads Neo4j, not this display payload.
  const displayGraph = useMemo<GraphPayload>(() => {
    if (!competitiveOpen || competitiveOverlay.nodes.length === 0) return graph;
    return {
      nodes: [...graph.nodes, ...competitiveOverlay.nodes.map((n) => ({ ...n, synthetic: true }))],
      edges: [...graph.edges, ...competitiveOverlay.edges],
    };
  }, [graph, competitiveOverlay, competitiveOpen]);

  /** Re-pull the graph payload everywhere after a governed HITL mutation. */
  function refreshGraph() {
    setGraphVersion((v) => v + 1);
  }

  // Persist theme choices whenever they change (survives reload mid-presentation).
  useEffect(() => writeStored("rtg.skin", skin), [skin]);
  useEffect(() => writeStored("rtg.density", density), [density]);
  useEffect(() => writeStored("rtg.motion", motion ? "on" : "off"), [motion]);

  // W3C/RDF cameo — fetch the live hero subgraph as Turtle and download it.
  async function exportRdf() {
    try {
      const turtle = await api.rdf();
      const url = URL.createObjectURL(new Blob([turtle], { type: "text/turtle" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "hero.ttl";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* never break the demo: a failed export is a no-op */
    }
  }

  // STABLE identity (useCallback, [] deps). This callback flows into
  // CopilotChatBeat's `renderToolCalls` memo, which is a prop on
  // <CopilotKitProvider>. A fresh function each render rebuilt that memo on every
  // node click → the provider re-initialized → the whole chat subtree remounted
  // (the "chat reloads on click" bug). Only stable setters + module-level `api`
  // are used here, so [] deps are correct.
  const onNodeClick = useCallback(async (node: GraphNode) => {
    // Toggle the node in/out of the AskDock's accumulating conversation context.
    setDockNodes((prev) =>
      prev.some((p) => p.id === node.id) ? prev.filter((p) => p.id !== node.id) : [...prev, node],
    );
    let prov: Provenance | null = null;
    try {
      prov = await api.provenance(node.id);
    } catch {
      prov = node.provenance ?? null;
    }
    setDrawer({ node, prov });
  }, []);

  // Stable (see onNodeClick note): open the edge detail / tag panel on edge click.
  const onEdgeClick = useCallback((edge: GraphEdge) => {
    setEdgeDrawer(edge);
  }, []);

  // Stable too — passed to CopilotChatBeat (same renderToolCalls memo dep).
  // Used by the Beat-4 Send→Review path: open the panel AND bump graphVersion so
  // the ReviewBell (refreshKey={graphVersion}) re-pulls its count immediately
  // rather than lagging up to one 8s poll behind the just-enqueued item.
  const openHitl = useCallback(() => {
    setHitlOpen(true);
    setGraphVersion((v) => v + 1);
  }, []);

  // Audit log → "ask about this change": resolve the change's node(s) to real
  // GraphNodes (hero-graph match when present, else a minimal stand-in carrying the
  // id), package them with the change summary as a Beat-4 seed, switch to the
  // conversation surface, and close the panel. The grounded agent answers from the
  // live graph (which already reflects an applied change) — no new answer path.
  const handleAuditToContext = useCallback(
    (cs: ChangeSet, question?: string) => {
      const ids = changeNodeIds(cs);
      const nodes: GraphNode[] = ids.map(
        (id) =>
          graph.nodes.find((n) => n.id === id) ?? { id, kind: "Concept", label: id },
      );
      setConvoSeed((prev) => ({
        change: { id: cs.id, title: cs.title, summary: summarizeChange(cs), nodeIds: ids },
        nodes,
        question,
        nonce: (prev?.nonce ?? 0) + 1,
      }));
      setBeat("conversation");
      setHitlOpen(false);
    },
    [graph],
  );

  // Global shortcuts: ⌘K / Ctrl+K toggles the command palette; "?" opens help
  // (ignored while typing in an input/textarea so it never hijacks search/chat).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        // The command palette, help overlay, and provenance drawer each own their
        // Esc handling — defer to them so dismissing the top overlay doesn't also
        // close a heavyweight panel underneath it.
        if (paletteOpen || helpOpen || drawer) return;
        // Otherwise close the heavyweight overlays (HITL / Admin / FinOps / Eval),
        // which have no Esc handler of their own. Idempotent, so harmless when
        // nothing is open.
        setHitlOpen(false);
        setAdminOpen(false);
        setFinopsOpen(false);
        setEvalOpen(false);
        setCompetitiveOpen(false);
        setPlaybookOpen(false);
        setStoryDossier(null);
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "?" && !typing) {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, helpOpen, drawer]);

  // Command palette entries — the beats + the same actions the header buttons run.
  const commands = useMemo<Command[]>(() => {
    const goto: Command[] = (["radar", "safety", "explanation", "multimodal", "conversation", "studio", "generative"] as Beat[]).map(
      (b) => ({ id: `goto-${b}`, group: "Go to", label: `Go to ${BEAT_LABELS[b]}`, run: () => setBeat(b) }),
    );
    const actions: Command[] = [
      { id: "hitl", group: "Actions", label: "Open HITL review queue", run: () => setHitlOpen(true) },
      { id: "admin", group: "Actions", label: "Open Admin panel", run: () => setAdminOpen(true) },
      { id: "finops", group: "Actions", label: "Open FinOps dashboard", run: () => setFinopsOpen(true) },
      { id: "eval", group: "Actions", label: "Open answer-quality scorecard", run: () => setEvalOpen(true) },
      { id: "competitive", group: "Actions", label: "Toggle competitive-pipeline overlay (synthetic)", hint: competitiveOpen ? "on" : "off", run: () => setCompetitiveOpen((v) => !v) },
      { id: "playbooks", group: "Actions", label: "Run a scientific playbook (safety dossier)", run: () => setPlaybookOpen(true) },
      { id: "story", group: "Actions", label: "Open the safety-dossier visual story", run: () => window.open("/safety-dossier-story.html", "_blank", "noopener,noreferrer") },
      { id: "export", group: "Actions", label: "Export hero subgraph to RDF (W3C)", run: () => void exportRdf() },
      { id: "canvas", group: "Actions", label: "Toggle canvas theme (light/dark)", hint: lightCanvas ? "light" : "dark", run: () => setLightCanvas((v) => !v) },
      { id: "skin", group: "Actions", label: "Toggle chrome skin (war-room/boardroom)", hint: skin, run: () => setSkin((s) => (s === "warroom" ? "boardroom" : "warroom")) },
      { id: "density", group: "Actions", label: "Toggle layout density", hint: density, run: () => setDensity((d) => (d === "comfortable" ? "compact" : "comfortable")) },
      { id: "mode", group: "Actions", label: "Toggle mode (scripted/live)", hint: mode, run: () => setMode((m) => (m === "scripted" ? "live" : "scripted")) },
      { id: "help", group: "Actions", label: "Show help & keyboard shortcuts", hint: "?", run: () => setHelpOpen(true) },
    ];
    return [...goto, ...actions];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightCanvas, skin, density, mode, competitiveOpen]);

  // The conversation beat fills the viewport so its inner panes (history list,
  // chat, right column) scroll independently instead of growing the whole page.
  const fullHeight = beat === "conversation" || beat === "studio" || beat === "generative";

  // Header IA: the many control buttons that used to wrap across four rows now
  // live in one "⚙ Tools" menu, grouped into VIEW toggles and PANELS actions.
  // Each item runs the exact same handler as before — this is navigation only.
  const toolSections: ToolSection[] = [
    {
      heading: "View",
      items: [
        {
          label: `Mode: ${mode}`,
          kind: "toggle",
          on: mode === "live",
          title: "Switch between scripted (recorded fallback) and live (real Claude Code). Returning to live re-checks readiness.",
          onClick: () => {
            const next = mode === "scripted" ? "live" : "scripted";
            setMode(next);
            if (next === "live") refreshHealth();
          },
        },
        {
          label: "Competitive overlay",
          kind: "toggle",
          on: competitiveOpen,
          title: "Overlay synthetic competitor pipelines (clearly labelled, dashed, never citable)",
          onClick: () => setCompetitiveOpen((v) => !v),
        },
        {
          label: `Motion: ${motion ? "on" : "off"}`,
          kind: "toggle",
          on: motion,
          title: "Toggle the graph's flowing-edge animation. Defaults on and overrides the OS reduce-motion setting.",
          onClick: () => setMotion((v) => !v),
        },
        {
          label: `Canvas: ${lightCanvas ? "light" : "dark"}`,
          kind: "toggle",
          on: lightCanvas,
          title: "Switch the graph canvas to a light theme for bright rooms / weak projectors",
          onClick: () => setLightCanvas((v) => !v),
        },
        {
          label: `Skin: ${skin === "warroom" ? "war-room" : "boardroom"}`,
          kind: "toggle",
          on: skin === "boardroom",
          title: "Switch the chrome between the deep-navy war-room skin and a light, print/projector-friendly boardroom skin",
          onClick: () => setSkin((s) => (s === "warroom" ? "boardroom" : "warroom")),
        },
        {
          label: `Density: ${density}`,
          kind: "toggle",
          on: density === "compact",
          title: "Switch layout density between comfortable and a denser exec-dashboard rhythm",
          onClick: () => setDensity((d) => (d === "comfortable" ? "compact" : "comfortable")),
        },
      ],
    },
    {
      heading: "Panels & tools",
      items: [
        {
          label: "Quality scorecard",
          kind: "action",
          icon: "✓",
          title: "Answer-quality scorecard — faithfulness, context-recall, relevancy (observability only)",
          onClick: () => setEvalOpen(true),
        },
        {
          label: "Playbooks",
          kind: "action",
          icon: "▶",
          title: "Run a scientific playbook — assemble a grounded safety dossier with reviewer checkpoints",
          onClick: () => setPlaybookOpen(true),
        },
        {
          label: "Saved dashboards",
          kind: "action",
          icon: "🗂",
          title: "Open, re-run, or review the generative dashboards you saved from chat, and their scheduled snapshot briefs",
          onClick: () => setSavedDashOpen(true),
        },
        {
          label: "Dossier story",
          kind: "action",
          icon: "📖",
          title: "Open the narrated visual story of the safety-dossier playbook (disproportionality, mechanism, evidence)",
          onClick: () => window.open("/safety-dossier-story.html", "_blank", "noopener,noreferrer"),
        },
        {
          label: "HITL review queue",
          kind: "action",
          icon: "⚖",
          title: "Open the human-in-the-loop panel — approve governed, reversible graph changes (mutate + revert)",
          onClick: () => setHitlOpen(true),
        },
        {
          label: "Admin (prompts & guardrails)",
          kind: "action",
          icon: "⚙",
          title: "Open the prompt & guardrail admin panel — tune prompts/thresholds live; grounding stays locked",
          onClick: () => setAdminOpen(true),
        },
        {
          label: "Export to RDF (W3C)",
          kind: "action",
          icon: "⤓",
          title: "W3C/RDF-first by design — download the live hero subgraph as W3C RDF (Turtle)",
          onClick: exportRdf,
        },
        {
          label: "Help & shortcuts",
          kind: "action",
          icon: "?",
          title: "Help & keyboard shortcuts (?)",
          onClick: () => setHelpOpen(true),
        },
      ],
    },
  ];

  return (
    <MotionContext.Provider value={motion}>
    <div
      data-skin={skin}
      data-density={density}
      style={fullHeight ? { height: "100vh", overflow: "hidden", display: "flex", flexDirection: "column" } : undefined}
    >
      <header className="app-header">
        <strong>R&amp;D Trust Graph</strong>
        <nav style={{ display: "flex", gap: 8 }}>
          {(["radar", "safety", "explanation", "multimodal", "conversation", "studio", "generative"] as Beat[]).map((b) => (
            <Button
              key={b}
              variant="nav"
              size="brand"
              aria-current={beat === b}
              onClick={() => setBeat(b)}
            >
              {BEAT_LABELS[b]}
            </Button>
          ))}
        </nav>
        <span style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0 }}>
          <LiveStatusPill />
          <ReviewBell onOpen={() => setHitlOpen(true)} refreshKey={graphVersion} />
          <ReviewerSelector />
          <FinOpsMeter onOpen={() => setFinopsOpen(true)} />
          <ToolsMenu sections={toolSections} />
          <AccountMenu health={health} />
        </span>
      </header>

      <ContextBar
        beatLabel={BEAT_LABELS[beat]}
        selectedNode={drawer?.node ?? null}
        contextCount={dockNodes.length}
        onClearContext={() => setDockNodes([])}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <main
        style={{
          display: "grid",
          gridTemplateColumns:
            beat === "conversation" || beat === "studio" || beat === "generative"
              ? "1fr"
              : density === "compact"
                ? "1fr 320px"
                : "1fr 360px",
          gap: "var(--gap)",
          padding: "var(--gap)",
          // Conversation beat: consume the remaining viewport so the page doesn't
          // grow (lets the sidebar/chat/right panes scroll internally instead).
          ...(fullHeight ? { flex: 1, minHeight: 0, overflow: "hidden" } : null),
        }}
      >
        <section
          className="graph-canvas"
          style={fullHeight ? { padding: 8, minHeight: 0, height: "100%", overflow: "hidden" } : { padding: 8, minHeight: 580 }}
        >
          {beat === "explanation" && path && (
            <ExplanationBeat
              graph={displayGraph}
              path={path}
              mode={mode}
              liveMode={health?.liveMode ?? false}
              lightCanvas={lightCanvas}
              refreshKey={graphVersion}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
            />
          )}
          {beat === "radar" && (
            <RadarBeat
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              lightCanvas={lightCanvas}
              refreshKey={graphVersion}
              onOpenHitl={() => setHitlOpen(true)}
            />
          )}
          {beat === "safety" && <SafetyRadarBeat lightCanvas={lightCanvas} />}
          {beat === "multimodal" && (
            <MultimodalBeat onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} lightCanvas={lightCanvas} refreshKey={graphVersion} />
          )}
          {beat === "conversation" && (
            <CopilotChatBeat
              graph={displayGraph}
              lightCanvas={lightCanvas}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onOpenHitl={openHitl}
              refreshKey={graphVersion}
              seed={convoSeed}
            />
          )}
          {beat === "studio" && (
            <DashboardStudio
              graph={displayGraph}
              lightCanvas={lightCanvas}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onOpenHitl={openHitl}
              refreshKey={graphVersion}
            />
          )}
          {beat === "generative" && (
            <GenerativeStudio
              graph={displayGraph}
              lightCanvas={lightCanvas}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onOpenHitl={openHitl}
              refreshKey={graphVersion}
            />
          )}
        </section>

        {/* The conversation beat (CopilotKit chat), the dashboard studio, and the
            generative studio are full-width and carry their own composer/chat — no
            separate AskPanel/Legend aside (avoids double Ask UIs). */}
        {beat !== "conversation" && beat !== "studio" && beat !== "generative" && (
          <aside className="panel" style={{ padding: 16 }}>
            {beat === "radar" && <BeatPlaceholder n="1" title="Data-Readiness / FAIR Integrity Radar" />}
            {beat === "safety" && (
              <div>
                <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)" }}>
                  Use Case 4
                </div>
                <h3>Data-Quality &amp; Patient-Safety Risk Radar</h3>
                <p style={{ color: "var(--frame-text-muted)", fontSize: 13, lineHeight: 1.6 }}>
                  Detects where poor data-quality <i>relationships</i> create clinical, operational or
                  AI-safety risk on trial-subject data. Each risk is SHACL-grounded and opens its evidence
                  path: subject → relationship → gap → safety rule → risk → source systems.
                </p>
              </div>
            )}
            {beat === "explanation" && path && <ScenarioCard path={path} />}
            {beat === "multimodal" && <BeatPlaceholder n="3" title="Multimodal resolve" />}
            {beat !== "safety" && <Legend beat={beat} />}
          </aside>
        )}
      </main>

      {drawer && (
        <ProvenanceDrawer
          node={drawer.node}
          prov={drawer.prov}
          verified={verifiedSet.has(drawer.node.id)}
          model={health?.model}
          onChanged={refreshGraph}
          onClose={() => setDrawer(null)}
        />
      )}

      {edgeDrawer && (
        <EdgeDetailPanel
          edge={edgeDrawer}
          nodeLabel={(id) => displayGraph.nodes.find((n) => n.id === id)?.label ?? id}
          onChanged={refreshGraph}
          onClose={() => setEdgeDrawer(null)}
        />
      )}

      {/* Phase 3b admin surface — mounted only when opened so its Tailwind scope
          (.admin-root) is inert for the rest of the demo. */}
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
      {/* HITL mutate + revert surface — governed, reversible graph writes through
          the authorized writer. After any apply/revert it refreshes the graph so
          the canvas/radar reflect the change live. */}
      {hitlOpen && (
        <HitlPanel
          onClose={() => setHitlOpen(false)}
          onChanged={refreshGraph}
          onAddToContext={handleAuditToContext}
        />
      )}
      {/* FinOps dashboard — token spend observability. Same scoped-Tailwind sheet
          idiom as the admin panel; mounted only when opened. */}
      {finopsOpen && <FinOpsDashboard onClose={() => setFinopsOpen(false)} />}

      {/* Answer-quality scorecard — RAGAS-style observability. Same scoped-Tailwind
          sheet pattern; observability only, never gates the model. */}
      {evalOpen && <EvalScorecard onClose={() => setEvalOpen(false)} />}
      {/* F5 — scientific playbooks / safety dossier. Orchestration over the real
          grounded agent; checkpoints enqueue an async HITL review. */}
      {playbookOpen && (
        <PlaybookPanel
          graph={displayGraph}
          onOpenHitl={() => setHitlOpen(true)}
          onOpenStory={(d) => setStoryDossier(d)}
          onClose={() => setPlaybookOpen(false)}
        />
      )}
      {/* Phase 3 — saved generative dashboards (F10) + scheduled snapshot briefs (F9).
          Re-opens a saved board through the same trusted DashboardCanvas over the
          live graph; nothing here is a new answer source. */}
      {savedDashOpen && (
        <SavedDashboardsPanel
          graph={displayGraph}
          onFocusNode={onNodeClick}
          onClose={() => setSavedDashOpen(false)}
        />
      )}
      {/* Dedicated full-width narrated dossier story — the boardroom surface for the
          post-run visuals. Same grounded DossierStory, wider layout + print-friendly. */}
      {storyDossier && (
        <div className="admin-root fixed inset-0 z-[1001] flex flex-col bg-background">
          <div className="flex items-center justify-between border-b px-6 py-4">
            <div>
              <div className="text-lg font-semibold text-foreground">{storyDossier.title}</div>
              <p className="text-xs text-muted-foreground">
                Narrated safety dossier — every figure grounded in the run's real citations.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setStoryDossier(null)} aria-label="Close story">
              Close
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <DossierStory
              steps={storyDossier.steps}
              graph={displayGraph}
              layout="full"
              onOpenHitl={() => {
                setStoryDossier(null);
                setHitlOpen(true);
              }}
            />
          </div>
        </div>
      )}
      {/* Global command palette (⌘K) — jump to any beat, action, or node. Nodes
          come from the already-fetched hero graph; selecting one opens its dossier. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        nodes={graph.nodes}
        onSelectNode={(n) => onNodeClick(n)}
      />
      {/* Help / keyboard-shortcuts overlay (header "?" button or the "?" key). */}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      {/* Floating, minimizable "Ask the graph" dock — available on every beat
          except the full conversation surface (Beat 4), where it would duplicate
          the chat. Reuses the SAME grounded Copilot Runtime; "open full" hands
          off to Beat 4. Replaces the old inline AskPanel aside. */}
      {beat !== "conversation" && beat !== "studio" && beat !== "generative" && (
        <AskDock
          onOpenFull={() => setBeat("conversation")}
          contextNodes={dockNodes}
          onRemoveContext={(id) => setDockNodes((prev) => prev.filter((p) => p.id !== id))}
          onClearContext={() => setDockNodes([])}
        />
      )}
      <Toaster position="bottom-right" richColors />
    </div>
    </MotionContext.Provider>
  );
}

function ScenarioCard({ path }: { path: ExplanationPath }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)" }}>
        Hero scenario {path.deductive && "· deductive · auto-accept"}
      </div>
      <h3 style={{ margin: "6px 0" }}>{path.scenario}</h3>
      <p style={{ color: "var(--frame-text-muted)", fontSize: 14 }}>
        A deterministic multi-hop path the graph computes — and a vector DB cannot. Click any node
        for ALCOA+ provenance.
      </p>
    </div>
  );
}

/** Persistent encoding key — execs won't ask what a colour means, they'll disengage. */
function Legend({ beat }: { beat: Beat }) {
  const NODE_LABELS: Record<string, string> = {
    AdverseEvent: "Adverse event",
    Drug: "Drug",
    BiologicalTarget: "Target",
    Pathway: "Pathway",
    SignalStat: "Signal stat",
    Evidence: "Evidence",
    Patient: "Patient",
    PathologyImage: "Pathology image",
    OmicsProfile: "Omics profile",
    Concept: "Ontology concept",
    LiteratureAbstract: "Literature abstract",
    ClinicalTrial: "Clinical trial",
    OntologySlice: "Ontology slice",
    RegulatoryDoc: "Regulatory doc",
    GeneticAssociation: "Genetic association",
  };
  // Robust colour fallbacks for kinds not yet present in shared NODE_COLORS.
  const NODE_COLOR_FALLBACK: Record<string, string> = {
    RegulatoryDoc: "#e3b341",
    GeneticAssociation: "#7ee787",
  };
  const keys =
    beat === "multimodal"
      ? [
          "PathologyImage",
          "OmicsProfile",
          "Concept",
          "LiteratureAbstract",
          "ClinicalTrial",
          "OntologySlice",
          "RegulatoryDoc",
          "GeneticAssociation",
          "AdverseEvent",
          "Drug",
        ]
      : [
          "AdverseEvent",
          "Drug",
          "BiologicalTarget",
          "Pathway",
          "SignalStat",
          "Evidence",
          "RegulatoryDoc",
          "GeneticAssociation",
        ];
  return (
    <div style={{ margin: "14px 0", paddingTop: 12, borderTop: "1px solid var(--frame-border)" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)" }}>
        Legend
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", marginTop: 6 }}>
        {keys.map((k) => (
          <span key={k} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: NODE_COLORS[k] ?? NODE_COLOR_FALLBACK[k] ?? "#8b949e",
                display: "inline-block",
              }}
            />
            {NODE_LABELS[k] ?? k}
          </span>
        ))}
      </div>
      {beat === "radar" && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--frame-text-muted)" }}>
          Readiness 0–100 — colour <i>plus</i> ring thickness <i>plus</i> on-node number
          (thicker ring = lower readiness). Redundant so it survives projection & colour-blindness.
        </div>
      )}
      {beat === "explanation" && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--frame-text-muted)" }}>
          Bright thick edge = the active hop. Dim edges = revealed prior hops (kept for context).
        </div>
      )}
    </div>
  );
}

function BeatPlaceholder({ n, title }: { n: string; title: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)" }}>
        Beat {n}
      </div>
      <h3>{title}</h3>
      <p style={{ color: "var(--frame-text-muted)", fontSize: 14 }}>Wires in its build phase.</p>
    </div>
  );
}

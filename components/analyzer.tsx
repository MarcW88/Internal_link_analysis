'use client';

import { upload } from "@vercel/blob/client";
import { useState, useEffect, useRef, type ChangeEvent } from "react";

type Cannibal = { type: string; label: string; urls: string[]; score: number };
type Recommendation = { source: string; target: string; anchor: string; passage: string; score: number; direction?: string };

type RunState = {
  status: "pending" | "preparing" | "enriching" | "done" | "not_found" | "error";
  phase?: string;
  progress?: number;
  summary?: Record<string, number>;
  raw?: { source: string; target: string; score: number; reasons: string[]; type: string }[];
  recommendations?: Recommendation[];
  conflicts?: { anchor: string; targets: string[] }[];
  cannibalization?: Cannibal[];
  scrapeErrors?: string[];
};

type FileState = {
  file: File | null;
  url: string;
  state: "idle" | "uploading" | "complete" | "error";
  message: string;
};

export function Analyzer() {
  const [result, setResult] = useState<RunState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");

  const [inlinks, setInlinks] = useState<FileState>({ file: null, url: "", state: "idle", message: "" });
  const [crawl, setCrawl] = useState<FileState>({ file: null, url: "", state: "idle", message: "" });
  const [mapping, setMapping] = useState<FileState>({ file: null, url: "", state: "idle", message: "" });
  const [target, setTarget] = useState("");

  const pollRef = useRef<number | null>(null);

  async function uploadCsv(file: File, setFile: (value: FileState) => void) {
    setFile({ file, url: "", state: "uploading", message: "Chargement…" });
    try {
      const blob = await upload(`imports/${crypto.randomUUID()}-${file.name}`, file, { access: "private", handleUploadUrl: "/api/uploads", multipart: true });
      setFile({ file, url: blob.url, state: "complete", message: "Chargé" });
    } catch (cause) {
      setFile({ file, url: "", state: "error", message: cause instanceof Error ? cause.message : "Échec du chargement" });
    }
  }

  function onChangeInlinks(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (file) uploadCsv(file, setInlinks);
  }

  function onChangeCrawl(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (file) uploadCsv(file, setCrawl);
  }

  function onChangeMapping(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (file) uploadCsv(file, setMapping);
  }

  function stopPolling() {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function updateProgress(state: RunState) {
    switch (state.status) {
      case "pending": setProgress(5); setStatus("Démarrage du moteur…"); break;
      case "preparing":
        setProgress(20);
        setStatus(`Préparation du graphe — ${state.summary?.pages ?? "—"} pages modélisées`);
        break;
      case "enriching":
      case "done":
        setProgress(100);
        setStatus("Analyse terminée");
        break;
      default:
        setProgress(0);
        setStatus("");
    }
  }

  async function poll(runId: string) {
    try {
      const response = await fetch(`/api/analyses/${runId}`);
      if (!response.ok) throw new Error("Statut introuvable");
      const state = (await response.json()) as RunState;
      setResult(state);
      updateProgress(state);

      if (state.status === "done" || state.status === "error" || state.status === "not_found") {
        stopPolling();
        setLoading(false);
        if (state.status === "error" || state.status === "not_found") {
          setError(state.phase || "Analyse interrompue");
        }
      }
    } catch (cause) {
      stopPolling();
      setLoading(false);
      setError(cause instanceof Error ? cause.message : "Erreur de suivi");
    }
  }

  async function analyze() {
    if (!inlinks.url || !crawl.url) return;
    stopPolling();
    setLoading(true);
    setError("");
    setResult(null);
    setProgress(2);
    setStatus("Envoi des fichiers…");

    try {
      const targetUrls = target.split(/[\n,]+/).map((url) => url.trim()).filter(Boolean);
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inlinksUrl: inlinks.url, crawlUrl: crawl.url, targetUrls: targetUrls.length ? targetUrls : undefined, mappingUrl: mapping.url || undefined }),
      });
      const data = (await response.json()) as { runId?: string; error?: string };
      if (!response.ok || !data.runId) throw new Error(data.error ?? "Analyse impossible");

      const runId = data.runId;
      setStatus("Analyse lancée — récupération du statut…");
      await poll(runId);
      pollRef.current = window.setInterval(() => poll(runId), 3000);
    } catch (cause) {
      setLoading(false);
      setError(cause instanceof Error ? cause.message : "Analyse impossible");
    }
  }

  useEffect(() => () => stopPolling(), []);

  const canAnalyze = inlinks.state === "complete" && crawl.state === "complete" && (mapping.state === "idle" || mapping.state === "complete");

  const summary = result?.summary;
  const recommendations = result?.recommendations || [];
  const conflicts = result?.conflicts || [];
  const cannibalization = result?.cannibalization || [];

  return <>
    <div className="uploadPanel">
      <div>
        <label>All Inlinks CSV</label>
        <input name="inlinks" type="file" accept=".csv,text/csv" onChange={onChangeInlinks} disabled={inlinks.state === "uploading"} />
        {inlinks.state !== "idle" && <span className={`badge ${inlinks.state}`}>{inlinks.message}</span>}
      </div>
      <div>
        <label>Internal HTML CSV</label>
        <input name="crawl" type="file" accept=".csv,text/csv" onChange={onChangeCrawl} disabled={crawl.state === "uploading"} />
        {crawl.state !== "idle" && <span className={`badge ${crawl.state}`}>{crawl.message}</span>}
      </div>
      <div>
        <label>Mapping HUB/SPOKE (optionnel)</label>
        <input name="mapping" type="file" accept=".csv,text/csv" onChange={onChangeMapping} disabled={mapping.state === "uploading"} />
        {mapping.state !== "idle" && <span className={`badge ${mapping.state}`}>{mapping.message}</span>}
        <small>URL, Keyword, Role (Hub/Spoke), Hub_URL, Cluster</small>
      </div>
      <div>
        <label>URL cible (optionnel)</label>
        <textarea value={target} onChange={(e) => setTarget(e.currentTarget.value)} disabled={loading} rows={3} placeholder="https://exemple.fr/page\n(ou plusieurs URLs séparées par virgule)" />
      </div>
      <button onClick={analyze} disabled={!canAnalyze || loading}>{loading ? "Analyse en cours…" : "Lancer l’analyse"}</button>
    </div>
    {(loading || progress > 0) && <div className="progressPanel" aria-live="polite">
      <div className="progressMeta"><b>{status}</b><span>{progress}%</span></div>
      <div className="progressTrack" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><div style={{ width: `${progress}%` }} /></div>
      {loading && <small>L’analyse est maintenant exécutée en arrière-plan. Les recommandations apparaissent au fur et à mesure.</small>}
    </div>}
    {error && <div className="error">{error}</div>}
    {!result && !error && !loading && progress === 0 && <div className="empty"><b>Sélectionne les deux CSV</b><p>Le mapping HUB/SPOKE est optionnel. Le bouton d’analyse devient actif quand les fichiers requis sont chargés.</p></div>}

    {result && result.status !== "done" && (
      <div className="panel">
        <div className="panelHeader"><div><p className="eyebrow">En cours</p><h2>{result.phase ?? result.status}</h2></div></div>
        {result.raw && <p>{result.raw.length} opportunités identifiées, enrichissement en attente…</p>}
        {result.scrapeErrors && result.scrapeErrors.length > 0 && <div className="error"><b>Erreurs de scraping :</b> {result.scrapeErrors.length}</div>}
      </div>
    )}

    {result && result.status === "done" && summary && <>
      <div className="metrics">
        {Object.entries(summary).map(([label, value]) => <article key={label}><p>{label.replace(/([A-Z])/g, " $1")}</p><strong>{value}</strong></article>)}
      </div>
      <div className="panel">
        <div className="panelHeader"><div><p className="eyebrow">Résultats réels</p><h2>Liens internes recommandés</h2></div><span>{recommendations.length} opportunités</span></div>
        <div className="row head"><span>Source → cible</span><span>Ancre et passage</span><span>Score</span></div>
        {recommendations.map((item) => <div className="row" key={`${item.source}|${item.target}|${item.anchor}`}><span><b>{item.source}</b><small>→ {item.target}</small></span><span><b>{item.anchor}</b><small>{item.passage?.slice(0, 180)}…</small></span><span><em>{item.score}</em><small>{item.direction === "outgoing" ? "lien sortant" : "lien entrant"}</small></span></div>)}
        {!recommendations.length && <div className="empty">Aucune opportunité fiable trouvée après exclusions.</div>}
      </div>
      {conflicts.length > 0 && <div className="panel conflicts"><div className="panelHeader"><div><p className="eyebrow">Contrôle</p><h2>Conflits d’ancres existants</h2></div></div>{conflicts.slice(0, 50).map((item) => <div className="conflict" key={item.anchor}><b>{item.anchor}</b><span>{item.targets.join(" · ")}</span></div>)}</div>}
      {cannibalization.length > 0 && <div className="panel cannibalization"><div className="panelHeader"><div><p className="eyebrow">Contrôle</p><h2>Cannibalisation sémantique</h2></div></div>{cannibalization.slice(0, 50).map((item) => <div className="conflict" key={`${item.type}|${item.label}`}><b>{item.type.toUpperCase()}</b><span>{item.label}</span><span>{item.urls.join(" · ")}</span></div>)}</div>}
    </>}
  </>;
}

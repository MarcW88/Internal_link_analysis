'use client';

import { upload } from "@vercel/blob/client";
import { useState, type ChangeEvent } from "react";

type Cannibal = { type: string; label: string; urls: string[]; score: number };
type Result = {
  summary: { pages: number; links: number; contextualLinks: number; excludedPages: number; conflicts: number; cannibalization: number; recommendations: number };
  conflicts: { anchor: string; targets: string[] }[];
  cannibalization: Cannibal[];
  recommendations: { source: string; target: string; anchor: string; passage: string; score: number; direction?: string }[];
};

type FileState = {
  file: File | null;
  url: string;
  state: "idle" | "uploading" | "complete" | "error";
  message: string;
};

export function Analyzer() {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");

  const [inlinks, setInlinks] = useState<FileState>({ file: null, url: "", state: "idle", message: "" });
  const [crawl, setCrawl] = useState<FileState>({ file: null, url: "", state: "idle", message: "" });
  const [mapping, setMapping] = useState<FileState>({ file: null, url: "", state: "idle", message: "" });
  const [target, setTarget] = useState("");

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

  async function analyze() {
    if (!inlinks.url || !crawl.url) return;
    setLoading(true); setProgress(2); setStatus("Préparation de l’analyse…"); setError(""); setResult(null);
    let timer: number | undefined;
    try {
      setProgress(10); setStatus("Analyse du graphe et scoring…");
      timer = window.setInterval(() => setProgress((current) => Math.min(current + 1, 99)), 1500);
      const targetUrls = target.split(/[\n,]+/).map((url) => url.trim()).filter(Boolean);
      const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inlinksUrl: inlinks.url, crawlUrl: crawl.url, targetUrls: targetUrls.length ? targetUrls : undefined, mappingUrl: mapping.url || undefined }) });
      setStatus("Finalisation des recommandations…");
      const text = await response.text();
      const data = text.startsWith("{") ? JSON.parse(text) : { error: text || `Erreur HTTP ${response.status}` };
      if (!response.ok) throw new Error(data.error ?? "Analyse impossible");
      setProgress(100); setStatus("Analyse terminée"); setResult(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Analyse impossible"); setStatus("Analyse interrompue"); }
    finally { if (timer) window.clearInterval(timer); setLoading(false); }
  }

  const canAnalyze = inlinks.state === "complete" && crawl.state === "complete" && (mapping.state === "idle" || mapping.state === "complete");

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
      {loading && <small>Le scraping Jina peut prendre plusieurs minutes selon le nombre de pages candidates.</small>}
    </div>}
    {error && <div className="error">{error}</div>}
    {!result && !error && !loading && progress === 0 && <div className="empty"><b>Sélectionne les deux CSV</b><p>Le mapping HUB/SPOKE est optionnel. Le bouton d’analyse devient actif quand les fichiers requis sont chargés.</p></div>}
    {result && <>
      <div className="metrics">
        {Object.entries(result.summary).map(([label, value]) => <article key={label}><p>{label.replace(/([A-Z])/g, " $1")}</p><strong>{value}</strong></article>)}
      </div>
      <div className="panel">
        <div className="panelHeader"><div><p className="eyebrow">Résultats réels</p><h2>Liens internes recommandés</h2></div><span>{result.recommendations.length} opportunités</span></div>
        <div className="row head"><span>Source → cible</span><span>Ancre et passage</span><span>Score</span></div>
        {result.recommendations.map((item) => <div className="row" key={`${item.source}|${item.target}|${item.anchor}`}><span><b>{item.source}</b><small>→ {item.target}</small></span><span><b>{item.anchor}</b><small>{item.passage.slice(0, 180)}…</small></span><span><em>{item.score}</em><small>{item.direction === "outgoing" ? "lien sortant" : "lien entrant"}</small></span></div>)}
        {!result.recommendations.length && <div className="empty">Aucune opportunité fiable trouvée après exclusions.</div>}
      </div>
      {result.conflicts.length > 0 && <div className="panel conflicts"><div className="panelHeader"><div><p className="eyebrow">Contrôle</p><h2>Conflits d’ancres existants</h2></div></div>{result.conflicts.slice(0, 50).map((item) => <div className="conflict" key={item.anchor}><b>{item.anchor}</b><span>{item.targets.join(" · ")}</span></div>)}</div>}
      {result.cannibalization.length > 0 && <div className="panel cannibalization"><div className="panelHeader"><div><p className="eyebrow">Contrôle</p><h2>Cannibalisation sémantique</h2></div></div>{result.cannibalization.slice(0, 50).map((item) => <div className="conflict" key={`${item.type}|${item.label}`}><b>{item.type.toUpperCase()}</b><span>{item.label}</span><span>{item.urls.join(" · ")}</span></div>)}</div>}
    </>}
  </>;
}

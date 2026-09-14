import { Analyzer } from "@/components/analyzer";

export default function Home() {
  return <main>
    <aside>
      <div className="brand">Internal Link<br />Analysis <span>V3</span></div>
      <nav><a className="active" href="#analyse">Analyse</a><a href="#recommendations">Recommandations</a><a href="#conflicts">Conflits</a></nav>
      <div className="status"><i /> Neon + Jina + Blob</div>
    </aside>
    <section className="content" id="analyse">
      <header><div><p className="eyebrow">Decision engine</p><h1>Maillage interne SEO</h1><p className="intro">Analyse le graphe contextuel, élimine les liens existants et les risques de cannibalisation, puis trouve l’ancre exacte dans le contenu avec Jina Reader.</p></div></header>
      <Analyzer />
    </section>
  </main>;
}

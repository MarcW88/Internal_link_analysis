# Project guidance

- `main` contient la V2 Streamlit historique ; la migration Next.js/Vercel se fait sur `vercel-v3`.
- Vérification locale : `npm run typecheck` puis `npm run build`.
- Déploiement cible : Vercel, équipe `marc-williame-s-projects`.
- Persistance : Neon PostgreSQL avec `pgvector`; fichiers d’import : Vercel Blob privé.
- Migration SQL principale : `db/migrations/0001_initial_schema.sql`.
- Les exports Screaming Frog `All Inlinks` et `Internal HTML` sont les sources principales ; Jina Reader récupère le contenu des seules pages candidates.
- Le graphe contextuel doit distinguer BODY/CONTENT, NAVIGATION, BREADCRUMB et FOOTER.
- Les exclusions (noindex, canonical externe, langue différente, lien contextuel existant) précèdent toujours le scoring.
- Score : page 30 %, paragraphe 25 %, opportunité cible 15 %, graphe 15 %, architecture 10 %, ancre 5 %.
- Ne jamais exposer `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `FIRECRAWL_API_KEY` ou une clé AI côté client.

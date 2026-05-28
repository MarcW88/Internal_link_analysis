---
title: Internal Link Analyzer
emoji: 🔗
colorFrom: blue
colorTo: indigo
sdk: docker
pinned: false
---

# 🔗 Internal Link Analyzer

Analysez votre maillage interne avec les exports Screaming Frog.

## Features

- **Anchor Map**: Tous les anchors par URL
- **Conflicts**: Même anchor → plusieurs URLs (cannibalisation)
- **Underlinked**: Pages avec ≤5 liens internes
- **Relevance**: Score de similarité Anchor ↔ Title

## How to use

1. Export **Inlinks** depuis Screaming Frog (Bulk Export → Links → All Inlinks)
2. Optionnellement export **Crawl** pour le scoring de relevance
3. Upload et cliquez Analyser

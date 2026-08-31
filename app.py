# app.py — Internal Link Analyzer v2 (Decision Engine)
import os
os.environ["MPLCONFIGDIR"] = "/tmp/matplotlib"
os.environ["XDG_CACHE_HOME"] = "/tmp"

import time
import re
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from urllib.parse import urlparse, urljoin

import requests
from bs4 import BeautifulSoup

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from sklearn.feature_extraction.text import CountVectorizer
from sklearn.metrics.pairwise import cosine_similarity

import streamlit as st


# ------------------------
# Scraping Engine (Firecrawl + BS4 fallback)
# ------------------------

def _get_firecrawl_key():
    """Read Firecrawl key from Streamlit secrets or env."""
    try:
        key = st.secrets.get("FIRECRAWL_API_KEY", "")
        if key:
            return str(key)
    except Exception:
        pass
    return os.getenv("FIRECRAWL_API_KEY", "")


def scrape_firecrawl(url: str, api_key: str, max_chars: int = 12_000) -> str | None:
    """Scrape a page via Firecrawl v1, return markdown text or None on failure."""
    try:
        resp = requests.post(
            "https://api.firecrawl.dev/v1/scrape",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"url": url, "formats": ["markdown"], "onlyMainContent": True},
            timeout=30,
        )
        resp.raise_for_status()
        text = resp.json().get("data", {}).get("markdown", "")
        return text[:max_chars] if text else None
    except Exception:
        return None


def scrape_bs4(url: str, max_chars: int = 12_000) -> str | None:
    """Fallback: requests + BeautifulSoup."""
    try:
        r = requests.get(
            url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; InternalLinkAnalyzer/2.0)"},
            timeout=20,
        )
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header"]):
            tag.decompose()
        text = soup.get_text(separator="\n", strip=True)
        return text[:max_chars] if text else None
    except Exception:
        return None


def scrape_page(url: str, api_key: str = "", max_chars: int = 12_000) -> str:
    """Firecrawl first, BS4 as fallback. Returns empty string on total failure."""
    if api_key:
        text = scrape_firecrawl(url, api_key, max_chars)
        if text:
            return text
    return scrape_bs4(url, max_chars) or ""


def find_anchor_in_content(anchor: str, content: str, context_chars: int = 120):
    """
    Look for the anchor text (case-insensitive) in the scraped content.
    Returns (found: bool, snippet: str)
    """
    if not anchor or not content:
        return False, ""
    pattern = re.compile(re.escape(anchor.strip()), re.IGNORECASE)
    m = pattern.search(content)
    if not m:
        return False, ""
    start = max(0, m.start() - context_chars)
    end   = min(len(content), m.end() + context_chars)
    raw   = content[start:end].replace("\n", " ").strip()
    # highlight the match
    snippet = ("\u2026" if start > 0 else "") + raw + ("\u2026" if end < len(content) else "")
    return True, snippet


def enrich_recommendations_with_content(df_recs: "pd.DataFrame", scraped: dict) -> "pd.DataFrame":
    """
    For each row in df_recs, check if Recommended_Anchor exists in the
    scraped content of Source_URL.
    Adds columns: Anchor_In_Content, Content_Snippet, Content_Action.
    """
    if df_recs.empty or not scraped:
        return df_recs
    df = df_recs.copy()
    found_list, snippet_list, action_list = [], [], []
    for _, row in df.iterrows():
        content = scraped.get(url_key(row["Source_URL"]), "")
        if content:
            found, snippet = find_anchor_in_content(row["Recommended_Anchor"], content)
        else:
            found, snippet = False, ""
        found_list.append("✅ Oui" if found else "❌ Non")
        snippet_list.append(snippet)
        if found and row["Link_Exists"] == "✅ Oui":
            action_list.append("✓ Déjà lié")
        elif found:
            action_list.append("🔗 Ajouter le lien sur l’ancre existante")
        elif row["Link_Exists"] == "✅ Oui":
            action_list.append("⚠️ Lien OK mais ancre différente dans le texte")
        else:
            action_list.append("✏️ Intégrer l’ancre + lien dans le contenu")
    df["Anchor_In_Content"] = found_list
    df["Content_Snippet"]   = snippet_list
    df["Content_Action"]    = action_list
    return df

# ------------------------
# Column Mapping
# ------------------------

def clean_columns(df):
    df.columns = df.columns.str.strip()
    mapping = {
        # Destination
        'destination': 'To', 'to': 'To', 'target': 'To', 'address': 'To',
        # Source
        'source': 'From', 'from': 'From', 'origin': 'From', 'origine': 'From',
        # Anchor
        'anchor': 'Anchor', 'anchor text': 'Anchor', 'anchortext': 'Anchor',
        'link text': 'Anchor', 'texte d\'ancre': 'Anchor', 'ancrage': 'Anchor',
        # Title
        'title 1': 'Title', 'title': 'Title', 'titre': 'Title',
        # Type
        'type': 'Type',
        # Position du lien
        'position du lien': 'Position', 'link position': 'Position', 'position': 'Position',
        # Origine du lien
        'origine du lien': 'LinkOrigin', 'link origin': 'LinkOrigin',
        # Suivre
        'suivre': 'Follow', 'follow': 'Follow',
        # Code de statut
        'code de statut': 'StatusCode', 'status code': 'StatusCode', 'status': 'StatusCode',
    }
    for col in df.columns:
        col_lower = col.lower().strip()
        if col_lower in mapping:
            df = df.rename(columns={col: mapping[col_lower]})
    return df


def read_file(uploaded_file):
    if uploaded_file is None:
        return None
    name = uploaded_file.name.lower()
    if name.endswith(('.xlsx', '.xls')):
        return pd.read_excel(uploaded_file)
    for enc in ['utf-8-sig', 'utf-8', 'latin-1', 'cp1252']:
        for sep in [',', ';', '\t']:
            try:
                uploaded_file.seek(0)
                df = pd.read_csv(uploaded_file, encoding=enc, sep=sep)
                if len(df.columns) > 1:
                    return df
            except:
                continue
    uploaded_file.seek(0)
    return pd.read_csv(uploaded_file)


def get_domain(url):
    try:
        return urlparse(str(url)).netloc.lower().replace('www.', '')
    except:
        return ''


def normalize_url(url, base_url=None):
    try:
        value = str(url).strip()
        if not value or value.lower() == 'nan':
            return ''
        if base_url and not urlparse(value).netloc:
            value = urljoin(str(base_url).strip(), value)
        parsed = urlparse(value)
        if not parsed.scheme and parsed.netloc:
            value = f"https:{value}" if value.startswith("//") else f"https://{value}"
        return value.rstrip('/') if value != '/' else value
    except:
        return str(url).strip()


def url_key(url):
    try:
        return normalize_url(url).lower()
    except:
        return str(url).strip().lower().rstrip('/')


def to_number(value, default=0):
    try:
        if pd.isna(value):
            return default
        return float(str(value).replace(',', '.').strip())
    except:
        return default


def to_text(value):
    if pd.isna(value):
        return ''
    return str(value).strip()


def detect_language(url, language_value=None):
    lang_text = to_text(language_value).lower()
    if lang_text:
        if lang_text.startswith('fr'):
            return 'fr'
        if lang_text.startswith('nl'):
            return 'nl'
        if lang_text.startswith('de'):
            return 'de'
        if lang_text.startswith('en'):
            return 'en'
    try:
        first_part = urlparse(str(url)).path.strip('/').split('/')[0].lower()
        return first_part if first_part in {'fr', 'nl', 'de', 'en'} else ''
    except:
        return ''


def is_low_value_linking_page(url):
    path = urlparse(str(url)).path.lower()
    low_value_terms = [
        'privacy', 'politique-cookies', 'cookies', 'cookie', 'confidentialite',
        'datenschutz', 'mentions-legales', 'legal', 'conditions', 'terms',
        'sitemap', 'wp-', 'cdn-cgi'
    ]
    return any(term in path for term in low_value_terms)


def compute_similarity(anchor, title):
    if not anchor or not title or pd.isna(anchor) or pd.isna(title):
        return 0.0
    try:
        vectorizer = CountVectorizer().fit([str(anchor).lower(), str(title).lower()])
        vectors = vectorizer.transform([str(anchor).lower(), str(title).lower()])
        return round(cosine_similarity(vectors[0], vectors[1])[0][0], 3)
    except:
        return 0.0


def classify_anchor(anchor):
    """Classify anchor type: exact, partial, generic, naked_url, image, other"""
    if not anchor or pd.isna(anchor):
        return 'empty'
    
    anchor = str(anchor).strip().lower()
    
    # Generic anchors
    generic_terms = ['cliquez ici', 'click here', 'ici', 'hier', 'lire la suite', 'en savoir plus',
                     'plus', 'voir', 'lien', 'link', 'more', 'read more', 'découvrir', 'ontdek',
                     'learn more', 'details', 'détails', 'suite', 'continuer']
    if anchor in generic_terms or any(anchor == g for g in generic_terms):
        return 'generic'
    
    # Naked URL
    if anchor.startswith('http') or anchor.startswith('www.') or '://' in anchor:
        return 'naked_url'
    
    # Image (often empty or contains img)
    if '<img' in anchor or anchor == '' or anchor == 'image':
        return 'image'
    
    # Short anchors (likely navigation)
    if len(anchor) <= 2:
        return 'navigation'
    
    return 'descriptive'


# ------------------------
# Main Processing
# ------------------------

def process_files(inlinks_file, crawl_file=None, target_domain=None, target_language='Toutes'):
    if inlinks_file is None:
        return None, "Veuillez uploader un fichier Inlinks"
    
    try:
        df = read_file(inlinks_file)
        df = clean_columns(df)
    except Exception as e:
        return None, f"Erreur lecture: {e}"
    
    # Load crawl data if provided
    crawl_data = {}
    df_crawl = None
    if crawl_file is not None:
        try:
            df_crawl = read_file(crawl_file)
            df_crawl = clean_columns(df_crawl)
            # Map crawl columns
            crawl_col_map = {
                'adresse': 'Address', 'address': 'Address', 'url': 'Address',
                'title 1': 'Title', 'title': 'Title', 'titre': 'Title', 'titre 1': 'Title',
                'meta description 1': 'MetaDesc', 'meta description': 'MetaDesc',
                'indexabilité': 'Indexability', 'indexability': 'Indexability',
                'h1-1': 'H1', 'h1': 'H1',
                'nombre de mots': 'WordCount', 'word count': 'WordCount',
                'profondeur de crawl': 'CrawlDepth', 'crawl profondeur': 'CrawlDepth', 'crawl depth': 'CrawlDepth',
                'language': 'Language', 'langue': 'Language',
            }
            for col in df_crawl.columns:
                col_lower = col.lower().strip()
                if col_lower in crawl_col_map:
                    df_crawl = df_crawl.rename(columns={col: crawl_col_map[col_lower]})
            
            # Build lookup dict
            if 'Address' in df_crawl.columns:
                for _, row in df_crawl.iterrows():
                    url = normalize_url(row['Address'])
                    detected_lang = detect_language(url, row.get('Language', ''))
                    if target_language and target_language != 'Toutes' and detected_lang != target_language:
                        continue
                    crawl_data[url_key(url)] = {
                        'Title': to_text(row.get('Title', '')),
                        'H1': to_text(row.get('H1', '')),
                        'MetaDesc': to_text(row.get('MetaDesc', '')),
                        'Indexability': to_text(row.get('Indexability', '')),
                        'WordCount': to_number(row.get('WordCount', 0)),
                        'CrawlDepth': to_number(row.get('CrawlDepth', 0)),
                        'Language': detected_lang,
                    }
        except Exception as e:
            st.warning(f"Erreur lecture crawl: {e}")
    
    # Check required columns
    if 'To' not in df.columns:
        return None, f"Colonne 'To/Destination' manquante. Colonnes trouvées: {list(df.columns)}"
    
    # Ensure Anchor column exists
    if 'Anchor' not in df.columns:
        df['Anchor'] = ''
    
    # Clean data
    if 'From' in df.columns:
        df['From'] = df['From'].astype(str).str.strip()
    df['To'] = df.apply(
        lambda row: normalize_url(row['To'], row['From'] if 'From' in df.columns else None),
        axis=1
    )
    df['Anchor'] = df['Anchor'].fillna('').astype(str).str.strip()
    if 'From' in df.columns:
        df['From'] = df['From'].apply(normalize_url)
    
    # Extract domains
    df['ToDomain'] = df['To'].apply(get_domain)
    if 'From' in df.columns:
        df['FromDomain'] = df['From'].apply(get_domain)

    df['ToLanguage'] = df['To'].apply(detect_language)
    if 'From' in df.columns:
        df['FromLanguage'] = df['From'].apply(detect_language)
    else:
        df['FromLanguage'] = ''

    if target_language and target_language != 'Toutes':
        df = df[(df['ToLanguage'] == target_language) | (df['FromLanguage'] == target_language)].copy()
    
    # Auto-detect target domain if not provided
    if not target_domain and 'FromDomain' in df.columns:
        target_domain = df['FromDomain'].mode().iloc[0] if not df['FromDomain'].mode().empty else ''
    elif not target_domain:
        target_domain = df['ToDomain'].mode().iloc[0] if not df['ToDomain'].mode().empty else ''
    
    target_domain = target_domain.lower().replace('www.', '')
    
    # ------------------------
    # SCOPE ANALYSIS
    # ------------------------
    
    total_rows = len(df)
    scope = {
        'total': total_rows,
        'excluded': {},
        'kept': 0
    }
    
    # Mark exclusions
    df['ExcludeReason'] = ''
    
    # 1. External links
    if target_domain:
        external_mask = ~df['ToDomain'].str.contains(target_domain, case=False, na=False)
        df.loc[external_mask, 'ExcludeReason'] = 'External'
        scope['excluded']['External'] = external_mask.sum()
    
    # 2. Non-hyperlinks (Canonical, Hreflang, Image, Sitemap, etc.)
    if 'Type' in df.columns:
        non_link_types = ['canonique', 'canonical', 'hreflang', 'image', 'sitemap', 'divers', 
                         'css', 'javascript', 'js', 'font', 'police', 'video', 'audio', 'iframe',
                         'rel prev', 'rel next', 'redirection']
        for t in non_link_types:
            mask = df['Type'].str.lower().str.contains(t, na=False) & (df['ExcludeReason'] == '')
            df.loc[mask, 'ExcludeReason'] = f'Type:{t.title()}'
            scope['excluded'][f'Type:{t.title()}'] = mask.sum()
    
    # 3. Position-based classification
    if 'Position' in df.columns:
        df['LinkPosition'] = df['Position'].fillna('Unknown').astype(str).str.strip()
    else:
        df['LinkPosition'] = 'Unknown'
    
    # Create filtered datasets
    df_all = df[df['ExcludeReason'] == ''].copy()
    scope['kept'] = len(df_all)
    
    # Separate by position
    content_positions = ['contenu', 'content', 'body', 'article', 'main']
    nav_positions = ['navigation', 'nav', 'menu', 'header', 'tête', 'head']
    footer_positions = ['pied de page', 'footer', 'bas de page']
    
    df_all['PositionType'] = 'Other'
    for pos in content_positions:
        df_all.loc[df_all['LinkPosition'].str.lower().str.contains(pos, na=False), 'PositionType'] = 'Content'
    for pos in nav_positions:
        df_all.loc[df_all['LinkPosition'].str.lower().str.contains(pos, na=False), 'PositionType'] = 'Navigation'
    for pos in footer_positions:
        df_all.loc[df_all['LinkPosition'].str.lower().str.contains(pos, na=False), 'PositionType'] = 'Footer'
    
    df_content = df_all[df_all['PositionType'] == 'Content'].copy()
    df_nav = df_all[df_all['PositionType'] == 'Navigation'].copy()
    df_footer = df_all[df_all['PositionType'] == 'Footer'].copy()
    
    # ------------------------
    # PAGE ANALYSIS
    # ------------------------
    
    # Classify anchors
    df_all['AnchorType'] = df_all['Anchor'].apply(classify_anchor)
    df_content['AnchorType'] = df_content['Anchor'].apply(classify_anchor)
    
    # Build page metrics
    pages = {}
    for url in df_all['To'].unique():
        url_all = df_all[df_all['To'] == url]
        url_content = df_content[df_content['To'] == url] if not df_content.empty else pd.DataFrame()
        url_nav = df_nav[df_nav['To'] == url] if not df_nav.empty else pd.DataFrame()
        url_footer = df_footer[df_footer['To'] == url] if not df_footer.empty else pd.DataFrame()
        
        # Count links by position
        total_links = len(url_all)
        content_links = len(url_content)
        nav_links = len(url_nav)
        footer_links = len(url_footer)
        
        # Unique sources
        unique_sources_all = url_all['From'].nunique() if 'From' in url_all.columns else 0
        unique_sources_content = url_content['From'].nunique() if 'From' in url_content.columns and not url_content.empty else 0
        
        # Sitewide dependency
        sitewide_ratio = (nav_links + footer_links) / total_links if total_links > 0 else 0
        
        # Anchor analysis
        anchors = url_all['Anchor'].tolist()
        anchor_types = url_all['AnchorType'].value_counts().to_dict()
        
        pages[url] = {
            'URL': url,
            'Total_Links': total_links,
            'Content_Links': content_links,
            'Navigation_Links': nav_links,
            'Footer_Links': footer_links,
            'Unique_Sources': unique_sources_all,
            'Unique_Sources_Content': unique_sources_content,
            'Sitewide_Ratio': round(sitewide_ratio, 2),
            'Descriptive_Anchors': anchor_types.get('descriptive', 0),
            'Generic_Anchors': anchor_types.get('generic', 0),
            'Empty_Anchors': anchor_types.get('empty', 0) + anchor_types.get('image', 0),
        }
    
    df_pages = pd.DataFrame(pages.values())
    
    # ------------------------
    # SCORING
    # ------------------------
    
    if not df_pages.empty:
        # Normalize metrics for scoring
        df_pages['Score_Content'] = df_pages['Content_Links'] / df_pages['Content_Links'].max() if df_pages['Content_Links'].max() > 0 else 0
        df_pages['Score_Sources'] = df_pages['Unique_Sources_Content'] / df_pages['Unique_Sources_Content'].max() if df_pages['Unique_Sources_Content'].max() > 0 else 0
        df_pages['Score_Sitewide'] = 1 - df_pages['Sitewide_Ratio']  # Lower sitewide = better
        df_pages['Score_Anchors'] = df_pages['Descriptive_Anchors'] / (df_pages['Total_Links'] + 1)
        
        # Composite score (0-100)
        df_pages['SEO_Score'] = (
            df_pages['Score_Content'] * 30 +
            df_pages['Score_Sources'] * 30 +
            df_pages['Score_Sitewide'] * 20 +
            df_pages['Score_Anchors'] * 20
        ).round(1)
        
        # Priority classification
        df_pages['Priority'] = 'OK'
        df_pages.loc[df_pages['Content_Links'] <= 2, 'Priority'] = 'HIGH'
        df_pages.loc[(df_pages['Content_Links'] <= 5) & (df_pages['Priority'] != 'HIGH'), 'Priority'] = 'MEDIUM'
        df_pages.loc[df_pages['Sitewide_Ratio'] >= 0.9, 'Priority'] = 'HIGH'
    
    # ------------------------
    # CONFLICTS
    # ------------------------
    
    # Same anchor -> multiple URLs (content links only)
    conflicts = []
    if not df_content.empty:
        anchor_urls = df_content.groupby('Anchor')['To'].apply(lambda x: list(x.unique())).reset_index()
        conflicts_raw = anchor_urls[anchor_urls['To'].apply(len) > 1]
        for _, row in conflicts_raw.iterrows():
            if row['Anchor'].strip():  # Skip empty anchors
                for url in row['To']:
                    others = [u for u in row['To'] if u != url][:3]
                    conflicts.append({
                        'Anchor': row['Anchor'],
                        'URL': url,
                        'Conflicts_With': ', '.join(others),
                        'Conflict_Count': len(row['To'])
                    })
    df_conflicts = pd.DataFrame(conflicts)
    
    # ------------------------
    # ANCHOR MAP
    # ------------------------
    
    anchor_map = df_all.groupby(['To', 'Anchor', 'PositionType']).size().reset_index(name='Count')
    anchor_map = anchor_map.sort_values(['To', 'Count'], ascending=[True, False])
    
    # ------------------------
    # ADVANCED PAGE ANALYSIS
    # ------------------------
    
    # Build comprehensive page analysis
    page_analysis = {}
    for url in df_all['To'].unique():
        page_analysis[url] = {
            'incoming_links': len(df_all[df_all['To'] == url]),
            'content_incoming': len(df_content[df_content['To'] == url]),
            'nav_incoming': len(df_nav[df_nav['To'] == url]),
            'footer_incoming': len(df_footer[df_footer['To'] == url]),
        }
        
        # Add crawl data
        crawl_match = crawl_data.get(url_key(url))
        if crawl_match:
            page_analysis[url].update(crawl_match)
        else:
            page_analysis[url].update({
                'Title': '', 'WordCount': 0, 'Indexability': '', 
                'CrawlDepth': 0, 'H1': '', 'MetaDesc': ''
            })

    for url, data in crawl_data.items():
        if url not in page_analysis:
            page_analysis[url] = {
                'incoming_links': len(df_all[df_all['To'].apply(url_key) == url_key(url)]),
                'content_incoming': len(df_content[df_content['To'].apply(url_key) == url_key(url)]),
                'nav_incoming': len(df_nav[df_nav['To'].apply(url_key) == url_key(url)]),
                'footer_incoming': len(df_footer[df_footer['To'].apply(url_key) == url_key(url)]),
                **data
            }
    
    # Build outgoing links map
    outgoing_map = {}
    if 'From' in df_content.columns:
        for url in df_content['From'].unique():
            outgoing_map[url] = {
                'outgoing_content': len(df_content[df_content['From'] == url]),
                'targets': df_content[df_content['From'] == url]['To'].tolist() if 'To' in df_content.columns else [],
            }
    
    # ------------------------
    # INTELLIGENT PAGE CLASSIFICATION
    # ------------------------
    
    def classify_page_type(url, analysis):
        """Classify pages into strategic categories"""
        incoming = analysis['incoming_links']
        content_in = analysis['content_incoming']
        word_count = analysis['WordCount']
        indexable = analysis['Indexability'].lower() == 'indexable' if analysis['Indexability'] else False
        depth = analysis['CrawlDepth']
        
        # Pages HUB candidates (rich content, already linking out)
        if (word_count > 200 and url in outgoing_map and 
            outgoing_map[url]['outgoing_content'] >= 2 and indexable):
            return 'HUB'

        if (word_count >= 800 and indexable and not is_low_value_linking_page(url)):
            return 'HUB'
        
        # Pages to BOOST (good content but few links)
        if (word_count > 150 and content_in <= 5 and indexable):
            return 'BOOST'
        
        # Pages ORPHAN (indexable but no incoming)
        if (indexable and incoming == 0 and word_count > 30):
            return 'ORPHAN'
        
        # Also consider pages with high incoming but low content links as BOOST candidates
        if (word_count > 200 and content_in <= 10 and incoming > 50 and indexable):
            return 'BOOST'
        
        # Pages WEAK (little content, few links)
        if (word_count < 50 or not indexable):
            return 'WEAK'
        
        return 'NORMAL'
    
    # Classify all pages
    for url in page_analysis:
        page_analysis[url]['PageType'] = classify_page_type(url, page_analysis[url])
    
    # ------------------------
    # ADVANCED THEMATIC SCORING
    # ------------------------
    
    def get_thematic_score(source_url, target_url):
        """Calculate thematic relevance score without AI"""
        score = 0
        reasons = []
        
        source = page_analysis[source_url]
        target = page_analysis[target_url]
        
        # 1. Same directory/section (+30)
        source_path = urlparse(source_url).path.lower()
        target_path = urlparse(target_url).path.lower()
        source_parts = [p for p in source_path.split('/') if p]
        target_parts = [p for p in target_path.split('/') if p]
        
        if source_parts and target_parts and source_parts[0] == target_parts[0]:
            score += 30
            reasons.append(f"Même section /{source_parts[0]}/")
        
        # 2. Keyword overlap in titles/H1 (+40)
        source_text = (source.get('Title', '') + ' ' + source.get('H1', '')).lower()
        target_text = (target.get('Title', '') + ' ' + target.get('H1', '')).lower()
        
        if source_text and target_text:
            # Extract meaningful words (3+ chars)
            source_words = set(w for w in source_text.split() if len(w) >= 3)
            target_words = set(w for w in target_text.split() if len(w) >= 3)
            
            if source_words and target_words:
                overlap = len(source_words & target_words)
                total_unique = len(source_words | target_words)
                if total_unique > 0:
                    overlap_ratio = overlap / total_unique
                    score += overlap_ratio * 40
                    if overlap_ratio > 0.3:
                        common_words = list(source_words & target_words)[:3]
                        reasons.append(f"Mots-clés communs: {', '.join(common_words)}")
        
        # 3. Content complementarity (+20)
        source_wc = source.get('WordCount', 0)
        target_wc = target.get('WordCount', 0)
        
        if source_wc > 500 and target_wc < 300:
            score += 20
            reasons.append(f"Contenu riche ({source_wc} mots) → page à booster ({target_wc} mots)")
        elif source_wc > 300 and target_wc > 300 and abs(source_wc - target_wc) < 200:
            score += 15
            reasons.append(f"Contenus complémentaires ({source_wc} vs {target_wc} mots)")
        
        # 4. Strategic linking (+10)
        if (source.get('PageType') == 'HUB' and target.get('PageType') == 'BOOST'):
            score += 10
            reasons.append("Page hub → page à booster")
        
        # 5. Depth balance (+10)
        source_depth = source.get('CrawlDepth', 0)
        target_depth = target.get('CrawlDepth', 0)
        
        if source_depth < target_depth and source_depth >= 1:
            score += 10
            reasons.append(f"Équilibre profondeur (niv{source_depth} → niv{target_depth})")
        
        return score, reasons
    
    # ------------------------
    # INTELLIGENT RECOMMENDATIONS ENGINE
    # ------------------------
    
    def generate_intelligent_recommendations():
        recommendations = []
        
        # 1. BOOST pages recommendations
        boost_pages = [url for url, data in page_analysis.items() if data['PageType'] == 'BOOST']
        hub_pages = [url for url, data in page_analysis.items() if data['PageType'] == 'HUB']
        
        for target_url in boost_pages[:20]:  # Top 20 boost pages
            target_data = page_analysis[target_url]
            existing_sources = df_content[df_content['To'] == target_url]['From'].tolist() if 'From' in df_content.columns else []
            
            # Find best sources
            source_candidates = []
            for source_url in hub_pages:
                if source_url != target_url and source_url not in existing_sources:
                    score, reasons = get_thematic_score(source_url, target_url)
                    if score > 20:  # Lower minimum threshold
                        source_candidates.append({
                            'url': source_url,
                            'score': score,
                            'reasons': reasons
                        })
            
            # Sort by score
            source_candidates.sort(key=lambda x: x['score'], reverse=True)
            
            if source_candidates:
                best_source = source_candidates[0]
                reasons_str = ' | '.join(best_source['reasons'][:2])
                
                recommendations.append({
                    'Type': 'BOOST',
                    'Target_URL': target_url,
                    'Target_Title': target_data.get('Title', '')[:50],
                    'Source_URL': best_source['url'],
                    'Source_Title': page_analysis[best_source['url']].get('Title', '')[:50],
                    'Score': best_source['score'],
                    'Reason': f"Lier depuis page hub vers page à booster. {reasons_str}",
                    'Current_State': f"{target_data['content_incoming']} liens contenu / {target_data['WordCount']} mots",
                    'Priority': 'HIGH'
                })
        
        # 2. ORPHAN pages recommendations
        orphan_pages = [url for url, data in page_analysis.items() if data['PageType'] == 'ORPHAN']
        
        for target_url in orphan_pages[:15]:  # Top 15 orphans
            target_data = page_analysis[target_url]
            
            # Find any good source (not just hubs)
            source_candidates = []
            for source_url in page_analysis:
                if (source_url != target_url and 
                    page_analysis[source_url]['PageType'] in ['HUB', 'NORMAL', 'BOOST']):
                    
                    score, reasons = get_thematic_score(source_url, target_url)
                    if score > 15:  # Even lower threshold for orphans
                        source_candidates.append({
                            'url': source_url,
                            'score': score,
                            'reasons': reasons
                        })
            
            source_candidates.sort(key=lambda x: x['score'], reverse=True)
            
            if source_candidates:
                best_source = source_candidates[0]
                reasons_str = ' | '.join(best_source['reasons'][:2])
                
                recommendations.append({
                    'Type': 'ORPHAN',
                    'Target_URL': target_url,
                    'Target_Title': target_data.get('Title', '')[:50],
                    'Source_URL': best_source['url'],
                    'Source_Title': page_analysis[best_source['url']].get('Title', '')[:50],
                    'Score': best_source['score'],
                    'Reason': f"Créer premier lien interne. {reasons_str}",
                    'Current_State': f"0 liens entrants / {target_data['WordCount']} mots",
                    'Priority': 'HIGH'
                })
        
        # 3. HUB optimization recommendations
        for hub_url in hub_pages[:10]:
            hub_data = page_analysis[hub_url]
            outgoing = outgoing_map.get(hub_url, {}).get('outgoing_content', 0)
            
            # Hubs with too few outgoing links
            if outgoing < 3 and hub_data['WordCount'] > 500:
                # Find BOOST pages to link to
                boost_candidates = []
                for boost_url in boost_pages:
                    if boost_url not in outgoing_map.get(hub_url, {}).get('targets', []):
                        score, reasons = get_thematic_score(hub_url, boost_url)
                        if score > 20:  # Lower threshold for hub optimization
                            boost_candidates.append({
                                'url': boost_url,
                                'score': score,
                                'reasons': reasons
                            })
                
                boost_candidates.sort(key=lambda x: x['score'], reverse=True)
                
                if boost_candidates:
                    best_boost = boost_candidates[0]
                    reasons_str = ' | '.join(best_boost['reasons'][:2])
                    
                    recommendations.append({
                        'Type': 'HUB_OPTIMIZE',
                        'Target_URL': best_boost['url'],
                        'Target_Title': page_analysis[best_boost['url']].get('Title', '')[:50],
                        'Source_URL': hub_url,
                        'Source_Title': hub_data.get('Title', '')[:50],
                        'Score': best_boost['score'],
                        'Reason': f"Page hub sous-utilisée. {reasons_str}",
                        'Current_State': f"{outgoing} liens sortants / {hub_data['WordCount']} mots",
                        'Priority': 'MEDIUM'
                    })
        
        # Sort by score and priority
        recommendations.sort(key=lambda x: (x['Priority'] != 'HIGH', -x['Score']))
        
        return recommendations
    
    # Generate intelligent recommendations
    recommendations = generate_intelligent_recommendations()
    df_recommendations = pd.DataFrame(recommendations)
    
    # ------------------------
    # KPIs
    # ------------------------
    
    kpi = {
        'total_links': scope['kept'],
        'excluded_links': scope['total'] - scope['kept'],
        'total_pages': len(df_pages),
        'content_links': len(df_content),
        'nav_links': len(df_nav),
        'footer_links': len(df_footer),
        'high_priority': len(df_pages[df_pages['Priority'] == 'HIGH']) if not df_pages.empty else 0,
        'conflicts': df_conflicts['Anchor'].nunique() if not df_conflicts.empty else 0,
        'avg_content_links': df_pages['Content_Links'].mean() if not df_pages.empty else 0,
        'avg_seo_score': df_pages['SEO_Score'].mean() if not df_pages.empty else 0,
    }
    
    results = {
        'scope': scope,
        'kpi': kpi,
        'pages': df_pages,
        'conflicts': df_conflicts,
        'anchor_map': anchor_map,
        'recommendations': df_recommendations,
        'crawl_data': crawl_data,
        'page_analysis': page_analysis,
        'df_content': df_content,
        'position_breakdown': {
            'Content': len(df_content),
            'Navigation': len(df_nav),
            'Footer': len(df_footer),
            'Other': len(df_all) - len(df_content) - len(df_nav) - len(df_footer)
        }
    }
    
    return results, None


# ------------------------
# UI Components
# ------------------------

def inject_css():
    st.markdown("""
    <style>
      .stApp { background: #F7F4EB; }
      [data-testid="stSidebar"] { background: #fff !important; border-right: 1px solid #E8E5DA; }
      .kpi { border-radius:16px; background:#fff; border:1px solid #E8E5DA; padding:14px 16px; margin-bottom:8px;}
      .kpi h4 { margin:0; font-size:11px; color:#666; font-weight:600; text-transform:uppercase; }
      .kpi .val { font-size:26px; font-weight:800; margin-top:2px; color:#111;}
      .kpi .sub { font-size:11px; color:#888; margin-top:2px;}
      .void-container { background:#fff; border:1px solid #E8E5DA; border-radius:16px; padding:14px; margin-bottom:12px;}
      .priority-high { background:#FEE2E2; color:#DC2626; padding:2px 8px; border-radius:4px; font-weight:600; }
      .priority-medium { background:#FEF3C7; color:#D97706; padding:2px 8px; border-radius:4px; font-weight:600; }
      .priority-ok { background:#D1FAE5; color:#059669; padding:2px 8px; border-radius:4px; font-weight:600; }
      #MainMenu {visibility:hidden;} footer {visibility:hidden;}
      .block-container {padding-top: 1.0rem;}
    </style>
    """, unsafe_allow_html=True)


def kpi_card(title, value, subtitle=None, color="#111"):
    sub_html = f'<div class="sub">{subtitle}</div>' if subtitle else ''
    st.markdown(f"""
      <div class="kpi">
        <h4>{title}</h4>
        <div class="val" style="color:{color}">{value}</div>
        {sub_html}
      </div>
    """, unsafe_allow_html=True)


def plot_position_pie(breakdown):
    fig, ax = plt.subplots(figsize=(6, 4))
    labels = [k for k, v in breakdown.items() if v > 0]
    sizes = [v for v in breakdown.values() if v > 0]
    colors = ['#10B981', '#3B82F6', '#8B5CF6', '#6B7280']
    ax.pie(sizes, labels=labels, autopct='%1.0f%%', colors=colors[:len(labels)])
    ax.set_title('Répartition par emplacement')
    return fig


def plot_priority_bar(df_pages):
    fig, ax = plt.subplots(figsize=(6, 4))
    if df_pages.empty:
        ax.text(0.5, 0.5, "No data", ha="center", va="center")
        return fig
    priority_counts = df_pages['Priority'].value_counts()
    colors = {'HIGH': '#DC2626', 'MEDIUM': '#D97706', 'OK': '#059669'}
    bars = ax.bar(priority_counts.index, priority_counts.values, 
                  color=[colors.get(p, '#6B7280') for p in priority_counts.index])
    ax.set_title('Pages par priorité')
    ax.set_ylabel('Nombre de pages')
    return fig


def plot_score_distribution(df_pages):
    fig, ax = plt.subplots(figsize=(6, 4))
    if df_pages.empty or 'SEO_Score' not in df_pages.columns:
        ax.text(0.5, 0.5, "No data", ha="center", va="center")
        return fig
    ax.hist(df_pages['SEO_Score'], bins=20, color='#3B82F6', edgecolor='white')
    ax.axvline(df_pages['SEO_Score'].mean(), color='#DC2626', linestyle='--', label=f"Moyenne: {df_pages['SEO_Score'].mean():.1f}")
    ax.set_title('Distribution des scores SEO')
    ax.set_xlabel('Score SEO')
    ax.set_ylabel('Nombre de pages')
    ax.legend()
    return fig


# ------------------------
# Keyword Mapping Engine
# ------------------------

def parse_mapping(mapping_file):
    """
    Parse a keyword mapping CSV/Excel.
    Expected columns (flexible):
      URL | Keyword (primary) | Role (Hub/Spoke/Pillar/Article) | Hub_URL (optional)
    Returns a list of dicts.
    """
    if mapping_file is None:
        return []
    df = read_file(mapping_file)
    if df is None or df.empty:
        return []
    df.columns = df.columns.str.strip()

    # Flexible column detection
    col_map = {}
    for col in df.columns:
        cl = col.lower().strip()
        if cl in ('url', 'adresse', 'address', 'page', 'page url', 'lien', 'link'):
            col_map['URL'] = col
        elif cl in ('keyword', 'mot-clé', 'mot cle', 'primary keyword', 'mot-clé principal',
                    'kw', 'cible', 'target keyword', 'ancre recommandée', 'ancre'):
            col_map['Keyword'] = col
        elif cl in ('role', 'rôle', 'type', 'page type', 'page role', 'niveau', 'level',
                    'hub', 'catégorie', 'category', 'cluster'):
            col_map['Role'] = col
        elif cl in ('hub_url', 'hub url', 'parent', 'parent url', 'pillar url',
                    'hub', 'pilier', 'parent page'):
            col_map['Hub_URL'] = col
        elif cl in ('secondary keyword', 'mot-clé secondaire', 'secondary', 'kw2', 'ancre 2'):
            col_map['Keyword2'] = col
        elif cl in ('cluster', 'groupe', 'group', 'thématique', 'thematique', 'topic'):
            col_map['Cluster'] = col

    if 'URL' not in col_map:
        # Try first column as URL fallback
        col_map['URL'] = df.columns[0]
    if 'Keyword' not in col_map and len(df.columns) > 1:
        col_map['Keyword'] = df.columns[1]

    rows = []
    for _, r in df.iterrows():
        url = normalize_url(to_text(r.get(col_map.get('URL', ''), '')))
        if not url:
            continue
        keyword = to_text(r.get(col_map.get('Keyword', ''), ''))
        role = to_text(r.get(col_map.get('Role', ''), '')).upper()
        hub_url = normalize_url(to_text(r.get(col_map.get('Hub_URL', ''), '')))
        keyword2 = to_text(r.get(col_map.get('Keyword2', ''), ''))
        cluster = to_text(r.get(col_map.get('Cluster', ''), ''))

        # Normalize role
        if any(x in role for x in ('HUB', 'PILIER', 'PILLAR', 'CLUSTER', 'CATEGOR')):
            role = 'HUB'
        elif any(x in role for x in ('SPOKE', 'ARTICLE', 'SOUS', 'CHILD', 'DETAIL', 'BLOG')):
            role = 'SPOKE'
        else:
            role = role or 'SPOKE'

        rows.append({
            'URL': url,
            'Keyword': keyword,
            'Keyword2': keyword2,
            'Role': role,
            'Hub_URL': hub_url,
            'Cluster': cluster,
        })

    return rows


def build_hub_recommendations(mapping_rows, existing_links_df):
    """
    Given the keyword mapping and the existing inlinks dataframe,
    generate anchor recommendations for all missing hub<->spoke links.

    Logic:
    - Hub → Spoke:  hub page should link to each spoke using spoke’s keyword as anchor
    - Spoke → Hub:  each spoke should link back to its hub using hub’s keyword as anchor
    - Spoke → Spoke (same hub): cross-linking within same cluster
    """
    if not mapping_rows:
        return pd.DataFrame()

    # Build fast lookup: url_key -> mapping row
    url_to_map = {url_key(r['URL']): r for r in mapping_rows if r['URL']}
    keyword_of = {url_key(r['URL']): r['Keyword'] for r in mapping_rows if r['URL']}
    role_of = {url_key(r['URL']): r['Role'] for r in mapping_rows if r['URL']}
    cluster_of = {url_key(r['URL']): r['Cluster'] for r in mapping_rows if r['URL']}

    # Build existing links set: (from_key, to_key) -> anchor
    existing = set()
    anchor_existing = {}
    if not existing_links_df.empty and 'From' in existing_links_df.columns and 'To' in existing_links_df.columns:
        for _, row in existing_links_df.iterrows():
            fk = url_key(row['From'])
            tk = url_key(row['To'])
            existing.add((fk, tk))
            anchor_existing[(fk, tk)] = to_text(row.get('Anchor', ''))

    # Group spokes by their hub
    hub_spokes = {}  # hub_key -> [spoke row]
    for r in mapping_rows:
        hub_k = url_key(r['Hub_URL']) if r['Hub_URL'] else None
        self_k = url_key(r['URL'])
        if r['Role'] == 'HUB':
            if self_k not in hub_spokes:
                hub_spokes[self_k] = []
        if hub_k and hub_k != self_k:
            hub_spokes.setdefault(hub_k, []).append(r)

    # Also group by cluster name for cross-spoke recommendations
    cluster_groups = {}
    for r in mapping_rows:
        cl = r['Cluster'] or r.get('Hub_URL', '')
        if cl:
            cluster_groups.setdefault(cl, []).append(r)

    recommendations = []

    def add_rec(source_url, target_url, anchor, link_type, reason):
        fk = url_key(source_url)
        tk = url_key(target_url)
        already = (fk, tk) in existing
        current_anchor = anchor_existing.get((fk, tk), '') if already else ''
        anchor_ok = current_anchor.lower().strip() == anchor.lower().strip() if already else False
        recommendations.append({
            'Type': link_type,
            'Source_URL': source_url,
            'Source_Role': role_of.get(fk, ''),
            'Target_URL': target_url,
            'Target_Role': role_of.get(tk, ''),
            'Recommended_Anchor': anchor,
            'Current_Anchor': current_anchor,
            'Link_Exists': '✅ Oui' if already else '❌ Manquant',
            'Anchor_OK': '✅ OK' if (already and anchor_ok) else ('⚠️ À corriger' if already else '—'),
            'Priority': 'OK' if (already and anchor_ok) else ('HIGH' if not already else 'MEDIUM'),
            'Reason': reason,
        })

    # 1. Hub → each of its spokes
    for hub_k, spokes in hub_spokes.items():
        hub_map = url_to_map.get(hub_k)
        if not hub_map:
            continue
        hub_url = hub_map['URL']
        for spoke in spokes:
            anchor = spoke['Keyword'] or spoke['URL'].split('/')[-1]
            add_rec(
                source_url=hub_url,
                target_url=spoke['URL'],
                anchor=anchor,
                link_type='HUB → SPOKE',
                reason=f"Le hub doit linker vers ce spoke avec l'ancre exacte du mot-clé cible",
            )

    # 2. Spoke → its Hub (back-link)
    for r in mapping_rows:
        if r['Role'] == 'SPOKE' and r['Hub_URL']:
            hub_k = url_key(r['Hub_URL'])
            hub_map = url_to_map.get(hub_k)
            hub_anchor = keyword_of.get(hub_k, '') or (hub_map['URL'].split('/')[-1] if hub_map else '')
            if hub_map:
                add_rec(
                    source_url=r['URL'],
                    target_url=hub_map['URL'],
                    anchor=hub_anchor,
                    link_type='SPOKE → HUB',
                    reason="Le spoke doit linker vers son hub (signal thématique)",
                )

    # 3. Cross-spokes within same cluster (top semantic neighbors only)
    for cl, pages in cluster_groups.items():
        spokes = [p for p in pages if p['Role'] == 'SPOKE']
        for i, src in enumerate(spokes):
            for tgt in spokes[i+1:i+4]:  # max 3 cross-links per spoke
                if url_key(src['URL']) == url_key(tgt['URL']):
                    continue
                anchor = tgt['Keyword'] or tgt['URL'].split('/')[-1]
                add_rec(
                    source_url=src['URL'],
                    target_url=tgt['URL'],
                    anchor=anchor,
                    link_type='SPOKE → SPOKE',
                    reason=f"Maill. croisé au sein du cluster \u00ab{cl}\u00bb",
                )

    df_rec = pd.DataFrame(recommendations)
    if not df_rec.empty:
        priority_order = {'HIGH': 0, 'MEDIUM': 1, 'OK': 2}
        df_rec['_prio_n'] = df_rec['Priority'].map(priority_order)
        df_rec = df_rec.sort_values(['_prio_n', 'Type']).drop(columns=['_prio_n'])
    return df_rec


# ------------------------
# Main UI
# ------------------------

st.set_page_config(page_title="Internal Link Analyzer v2", page_icon="🔗", layout="wide")
inject_css()

st.title("🔗 Internal Link Analyzer v2")
st.caption("Analysez votre maillage interne avec une approche orientée décision SEO")

# File upload
col1, col2 = st.columns(2)
with col1:
    inlinks_file = st.file_uploader("📄 Export Inlinks Screaming Frog", type=["csv", "xlsx", "xls"])
with col2:
    crawl_file = st.file_uploader("📄 Export Crawl (optionnel)", type=["csv", "xlsx", "xls"])

with st.expander("� Clé API Firecrawl (scraping de contenu)", expanded=False):
    st.markdown("""
    Optionnel — si renseignée, l’outil scrape le contenu de chaque page source pour détecter
    si l’ancre recommandée est **déjà présente dans le texte** ou si elle doit y être ajoutée.
    Sans clé, le fallback BeautifulSoup est utilisé (plus lent, moins précis).
    """)
    firecrawl_key_input = st.text_input(
        "Firecrawl API Key", type="password",
        value=_get_firecrawl_key(),
        placeholder="fc-...",
        key="firecrawl_key",
    )

with st.expander("�📍 Import Keyword Mapping — Content Hub Builder (optionnel)", expanded=False):
    st.markdown("""
    Upload ton mapping keyword au format **CSV ou Excel** avec les colonnes :

    | URL | Keyword | Role | Hub_URL | Cluster |
    |---|---|---|---|---|
    | /seo-local | séo local | SPOKE | /seo | Local |
    | /seo | référencement naturel | HUB | | Local |

    - **Role** : `HUB` (pilier / catégorie) ou `SPOKE` (article / sous-page)
    - **Keyword** : le mot-clé cible principal — ce sera l’ancre recommandée
    - **Hub_URL** : URL du hub parent pour chaque spoke
    - **Cluster** : nom du cluster thématique (pour le maillage croisé entre spokes)
    """, unsafe_allow_html=True)
    mapping_file = st.file_uploader("📄 Keyword Mapping (CSV / Excel)", type=["csv", "xlsx", "xls"], key="mapping")

# Domain and language filters
target_domain = st.text_input("🌐 Domaine cible (auto-détecté si vide)", placeholder="example.com")
target_language = st.selectbox("🌍 Langue à analyser", ["Toutes", "fr", "nl", "de", "en"], index=0)

if st.button("🔍 Analyser", use_container_width=True, type="primary"):
    if inlinks_file is None:
        st.error("Veuillez uploader un fichier Inlinks")
    else:
        with st.spinner("Analyse en cours..."):
            results, error = process_files(inlinks_file, crawl_file, target_domain, target_language)
        
        if error:
            st.error(error)
        else:
            kpi = results['kpi']
            
            # KPIs Row 1
            c1, c2, c3, c4, c5, c6 = st.columns(6)
            with c1: kpi_card("Liens analysés", f"{kpi['total_links']:,}", f"{kpi['excluded_links']:,} exclus")
            with c2: kpi_card("Pages cibles", f"{kpi['total_pages']:,}")
            with c3: kpi_card("Liens Contenu", f"{kpi['content_links']:,}", "liens éditoriaux", "#10B981")
            with c4: kpi_card("Liens Nav/Footer", f"{kpi['nav_links'] + kpi['footer_links']:,}", "liens sitewide", "#6B7280")
            with c5: kpi_card("Priorité haute", f"{kpi['high_priority']}", "pages à optimiser", "#DC2626")
            with c6: kpi_card("Score moyen", f"{kpi['avg_seo_score']:.0f}/100")
            
            st.caption(f"Analysé le {datetime.now(timezone.utc).strftime('%d %b %Y, %H:%M UTC')}")
            
            # Tabs
            # Parse mapping if uploaded
            mapping_rows = parse_mapping(mapping_file)
            df_mapping_recs = pd.DataFrame()
            if mapping_rows:
                df_mapping_recs = build_hub_recommendations(mapping_rows, results.get('df_content', pd.DataFrame()))

            # Retrieve Firecrawl key (input field takes priority over secrets)
            fc_key = st.session_state.get("firecrawl_key", "") or _get_firecrawl_key()

            tab_labels = ["🎯 Recommandations", "📊 Pages", "⚠️ Conflits", "🔗 Anchor Map", "📈 Charts", "🔍 Scope"]
            if mapping_rows:
                tab_labels.insert(0, "🏗️ Content Hub")
            tabs = st.tabs(tab_labels)

            hub_tab_offset = 1 if mapping_rows else 0
            if mapping_rows:
                tab_hub = tabs[0]
                tab1, tab2, tab3, tab4, tab5, tab6 = tabs[1], tabs[2], tabs[3], tabs[4], tabs[5], tabs[6]
            else:
                tab1, tab2, tab3, tab4, tab5, tab6 = tabs[0], tabs[1], tabs[2], tabs[3], tabs[4], tabs[5]
            
            if mapping_rows:
                with tab_hub:
                    st.subheader("�️ Content Hub — Recommandations de maillage sur ancres")
                    st.caption(f"{len(mapping_rows)} URLs dans le mapping · {sum(1 for r in mapping_rows if r['Role']=='HUB')} hubs · {sum(1 for r in mapping_rows if r['Role']=='SPOKE')} spokes")

                    if not df_mapping_recs.empty:
                        # ── Content scraping section ────────────────────────────
                        st.markdown("#### 🔍 Analyse du contenu des pages")
                        scraped_cache = st.session_state.get("scraped_content", {})

                        source_urls = df_mapping_recs["Source_URL"].dropna().unique().tolist()
                        already_scraped = [u for u in source_urls if url_key(u) in scraped_cache]
                        to_scrape = [u for u in source_urls if url_key(u) not in scraped_cache]

                        sc1, sc2 = st.columns([3, 1])
                        with sc1:
                            st.caption(
                                f"{len(source_urls)} pages sources · "
                                f"{len(already_scraped)} déjà scrapées · "
                                f"{len(to_scrape)} à scraper"
                            )
                        with sc2:
                            do_scrape = st.button(
                                f"🔍 Scraper {len(to_scrape)} page(s)",
                                key="btn_scrape",
                                disabled=len(to_scrape) == 0,
                            )

                        if do_scrape and to_scrape:
                            prog = st.progress(0, text="Scraping en cours…")
                            for i, url in enumerate(to_scrape):
                                prog.progress((i + 1) / len(to_scrape), text=f"🔍 {url[:60]}…")
                                text = scrape_page(url, api_key=fc_key)
                                scraped_cache[url_key(url)] = text
                                time.sleep(0.3)  # polite delay
                            st.session_state["scraped_content"] = scraped_cache
                            prog.empty()
                            st.success(f"✅ {len(to_scrape)} pages scrapées")
                            st.rerun()

                        # Enrich recommendations if scraping data available
                        if scraped_cache:
                            df_mapping_recs = enrich_recommendations_with_content(df_mapping_recs, scraped_cache)

                        st.markdown("---")

                        # Summary metrics
                        total_recs = len(df_mapping_recs)
                        missing = len(df_mapping_recs[df_mapping_recs['Link_Exists'] == '❌ Manquant'])
                        wrong_anchor = len(df_mapping_recs[df_mapping_recs['Anchor_OK'] == '⚠️ À corriger'])
                        ok = total_recs - missing - wrong_anchor
                        anchors_in_content = len(df_mapping_recs[df_mapping_recs.get('Anchor_In_Content', pd.Series()) == '✅ Oui']) if 'Anchor_In_Content' in df_mapping_recs.columns else 0

                        mc1, mc2, mc3, mc4, mc5 = st.columns(5)
                        with mc1: kpi_card("Liens à créer", str(missing), "liens manquants", "#DC2626")
                        with mc2: kpi_card("Ancres à corriger", str(wrong_anchor), "lien existe, mauvaise ancre", "#D97706")
                        with mc3: kpi_card("Liens OK", str(ok), "corrects", "#059669")
                        with mc4: kpi_card("Total checkés", str(total_recs), "paires source→cible")
                        with mc5: kpi_card("Ancres dans texte", str(anchors_in_content) if scraped_cache else "—", "détectées via scraping", "#6D28D9")

                        st.markdown("---")

                        # Filters
                        fc1, fc2, fc3, fc4 = st.columns(4)
                        with fc1:
                            hub_filter = st.selectbox("Statut lien", ["Tous", "❌ Manquant", "⚠️ À corriger", "✅ OK"], key="hub_status")
                        with fc2:
                            type_filter_hub = st.selectbox("Type de lien", ["Tous", "HUB → SPOKE", "SPOKE → HUB", "SPOKE → SPOKE"], key="hub_type")
                        with fc3:
                            cluster_filter = st.selectbox("Cluster", ["Tous"] + sorted(set(r['Cluster'] for r in mapping_rows if r['Cluster'])), key="hub_cluster")
                        with fc4:
                            content_filter_opts = ["Tous"]
                            if 'Anchor_In_Content' in df_mapping_recs.columns:
                                content_filter_opts += ["✅ Ancre dans texte", "❌ Ancre absente"]
                            content_filter = st.selectbox("Contenu", content_filter_opts, key="hub_content")

                        df_hub_display = df_mapping_recs.copy()
                        if hub_filter != "Tous":
                            if hub_filter == "✅ OK":
                                df_hub_display = df_hub_display[df_hub_display['Priority'] == 'OK']
                            elif hub_filter == "❌ Manquant":
                                df_hub_display = df_hub_display[df_hub_display['Link_Exists'] == '❌ Manquant']
                            elif hub_filter == "⚠️ À corriger":
                                df_hub_display = df_hub_display[df_hub_display['Anchor_OK'] == '⚠️ À corriger']
                        if type_filter_hub != "Tous":
                            df_hub_display = df_hub_display[df_hub_display['Type'] == type_filter_hub]
                        if cluster_filter != "Tous":
                            src_urls = {url_key(r['URL']) for r in mapping_rows if r['Cluster'] == cluster_filter}
                            df_hub_display = df_hub_display[df_hub_display['Source_URL'].apply(url_key).isin(src_urls) | df_hub_display['Target_URL'].apply(url_key).isin(src_urls)]
                        if 'Anchor_In_Content' in df_hub_display.columns and content_filter != "Tous":
                            val = '✅ Oui' if content_filter == '✅ Ancre dans texte' else '❌ Non'
                            df_hub_display = df_hub_display[df_hub_display['Anchor_In_Content'] == val]

                        st.caption(f"{len(df_hub_display)} résultats affichés")

                        # Card view for missing/to-fix
                        priority_rows = df_hub_display[df_hub_display['Priority'].isin(['HIGH', 'MEDIUM'])]
                        if not priority_rows.empty:
                            st.markdown("### ⚡ Actions prioritaires")
                            for _, row in priority_rows.head(30).iterrows():
                                status_color = "#FEE2E2" if row['Priority'] == 'HIGH' else "#FEF3C7"
                                border_color = "#DC2626" if row['Priority'] == 'HIGH' else "#D97706"
                                has_content  = 'Anchor_In_Content' in row.index
                                in_content   = row.get('Anchor_In_Content', '') == '✅ Oui'
                                snippet      = str(row.get('Content_Snippet', ''))
                                action       = str(row.get('Content_Action', ''))
                                content_html = ""
                                if has_content:
                                    ic_color  = "#059669" if in_content else "#DC2626"
                                    ic_label  = "✅ Ancre détectée dans le texte" if in_content else "❌ Ancre absente du contenu"
                                    snip_html = f'<div style="margin-top:4px; font-size:0.78em; color:#555; background:#f9f9f9; padding:6px 10px; border-radius:4px; font-style:italic;">{snippet}</div>' if snippet else ""
                                    content_html = f"""
                                        <div style="margin-top:8px; border-top:1px solid #e5e7eb; padding-top:8px;">
                                            <span style="font-size:0.8em; font-weight:700; color:{ic_color};">{ic_label}</span>
                                            {snip_html}
                                            <div style="margin-top:4px; font-size:0.78em; font-weight:600; color:#374151;">📌 Action : {action}</div>
                                        </div>
                                    """
                                st.markdown(f"""
                                <div style="background:{status_color}; border-left:4px solid {border_color}; border-radius:8px; padding:12px 16px; margin-bottom:10px;">
                                    <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                                        <span style="font-size:0.8em; font-weight:700; color:{border_color};">{row['Type']} — {row['Link_Exists']}</span>
                                        <span style="font-size:0.8em; background:#fff; padding:2px 8px; border-radius:4px;">{row['Anchor_OK']}</span>
                                    </div>
                                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                                        <div>
                                            <span style="font-size:0.75em; color:#666;">SOURCE</span><br/>
                                            <code style="font-size:0.8em;">{row['Source_URL']}</code>
                                            <span style="font-size:0.75em; color:#888;"> ({row['Source_Role']})</span>
                                        </div>
                                        <div>
                                            <span style="font-size:0.75em; color:#666;">CIBLE</span><br/>
                                            <code style="font-size:0.8em;">{row['Target_URL']}</code>
                                            <span style="font-size:0.75em; color:#888;"> ({row['Target_Role']})</span>
                                        </div>
                                    </div>
                                    <div style="margin-top:8px; background:#fff; padding:6px 10px; border-radius:6px;">
                                        🏷️ <strong>Ancre recommandée :</strong>
                                        <code style="color:#059669; font-weight:700;">{row['Recommended_Anchor']}</code>
                                        {'<span style="color:#D97706; margin-left:12px;">Ancre actuelle : <em>' + row['Current_Anchor'] + '</em></span>' if row['Current_Anchor'] else ''}
                                    </div>
                                    {content_html}
                                    <div style="margin-top:4px; font-size:0.75em; color:#666;">ℹ️ {row['Reason']}</div>
                                </div>
                                """, unsafe_allow_html=True)

                        st.markdown("---")
                        st.markdown("### 📋 Tableau complet")
                        base_cols = ['Type', 'Source_URL', 'Source_Role', 'Target_URL', 'Target_Role',
                                     'Recommended_Anchor', 'Current_Anchor', 'Link_Exists', 'Anchor_OK', 'Priority', 'Reason']
                        extra_cols = [c for c in ['Anchor_In_Content', 'Content_Action', 'Content_Snippet'] if c in df_hub_display.columns]
                        st.dataframe(
                            df_hub_display[base_cols + extra_cols],
                            use_container_width=True, hide_index=True, height=400
                        )

                        # CSV export
                        csv_hub = df_hub_display.to_csv(index=False).encode('utf-8-sig')
                        st.download_button(
                            label="⬇️ Télécharger les recommandations (CSV)",
                            data=csv_hub,
                            file_name="hub_anchor_recommendations.csv",
                            mime="text/csv",
                        )
                    else:
                        st.info("💡 Le mapping a été chargé mais aucune recommandation n'a pu être générée.\nVérifie que les colonnes URL, Keyword, Role et Hub_URL sont bien renseignées.")

            with tab1:
                st.subheader("🎯 Recommandations intelligentes")
                if not results['recommendations'].empty:
                    # Filters
                    col1, col2, col3 = st.columns(3)
                    with col1:
                        priority_filter = st.selectbox("Priorité", ['Toutes', 'HIGH', 'MEDIUM'], key='rec_priority')
                    with col2:
                        type_filter = st.selectbox("Type", ['Toutes', 'BOOST', 'ORPHAN', 'HUB_OPTIMIZE'], key='rec_type')
                    with col3:
                        min_score = st.slider("Score minimum", 0, 100, 40, key='rec_score')
                    
                    df_rec = results['recommendations']
                    if priority_filter != 'Toutes':
                        df_rec = df_rec[df_rec['Priority'] == priority_filter]
                    if type_filter != 'Toutes':
                        df_rec = df_rec[df_rec['Type'] == type_filter]
                    df_rec = df_rec[df_rec['Score'] >= min_score]
                    
                    st.caption(f"{len(df_rec)} recommandations affichées")
                    
                    for _, row in df_rec.iterrows():
                        priority_class = f"priority-{row['Priority'].lower()}"
                        
                        # Type icon
                        type_icons = {
                            'BOOST': '🚀',
                            'ORPHAN': '👻', 
                            'HUB_OPTIMIZE': '🔧'
                        }
                        type_icon = type_icons.get(row['Type'], '📄')
                        
                        st.markdown(f"""
                        <div class="void-container">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <span class="{priority_class}">{row['Priority']}</span>
                                <span style="background: #e5e7eb; padding: 2px 8px; border-radius: 4px; font-size: 0.8em;">{type_icon} {row['Type']}</span>
                                <span style="background: #fef3c7; padding: 2px 8px; border-radius: 4px; font-size: 0.8em;">Score: {row['Score']}</span>
                            </div>
                            
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px;">
                                <div>
                                    <strong style="color:#059669;">🎯 PAGE CIBLE</strong><br/>
                                    <a href="{row['Target_URL']}" target="_blank" style="color:#059669; font-weight: 500;">{row['Target_Title']}</a><br/>
                                    <small style="color:#666;">{row['Target_URL'][:60]}...</small><br/>
                                    <small>📊 {row['Current_State']}</small>
                                </div>
                                <div>
                                    <strong style="color:#3b82f6;">📎 PAGE SOURCE</strong><br/>
                                    <a href="{row['Source_URL']}" target="_blank" style="color:#3b82f6; font-weight: 500;">{row['Source_Title']}</a><br/>
                                    <small style="color:#666;">{row['Source_URL'][:60]}...</small>
                                </div>
                            </div>
                            
                            <div style="background: #f0fdf4; padding: 8px; border-radius: 4px; margin-top: 8px;">
                                <strong style="color:#059669;">💡 Raison recommandée:</strong><br/>
                                <small>{row['Reason']}</small>
                            </div>
                        </div>
                        """, unsafe_allow_html=True)
                        
                        st.divider()
                else:
                    # Debug info
                    st.warning("📊 Analyse des pages trouvées:")
                    
                    # Count page types
                    page_analysis_data = results.get('page_analysis', {})
                    if page_analysis_data:
                        type_counts = {}
                        sample_pages = {}
                        for url, data in page_analysis_data.items():
                            page_type = data.get('PageType', 'UNKNOWN')
                            type_counts[page_type] = type_counts.get(page_type, 0) + 1
                            
                            # Store sample pages for each type
                            if page_type not in sample_pages:
                                sample_pages[page_type] = url
                        
                        for ptype, count in type_counts.items():
                            sample_url = sample_pages[ptype][:60] + "..." if len(sample_pages[ptype]) > 60 else sample_pages[ptype]
                            sample_data = page_analysis_data[sample_pages[ptype]]
                            st.markdown(f"- **{ptype}**: {count} pages")
                            st.markdown(f"  - Exemple: {sample_url}")
                            st.markdown(f"  - WordCount: {sample_data.get('WordCount', 0)}, Incoming: {sample_data.get('incoming_links', 0)}, Content In: {sample_data.get('content_incoming', 0)}")
                    
                    # Show crawl data info
                    crawl_data = results.get('crawl_data', {})
                    st.markdown(f"- **Pages dans le crawl**: {len(crawl_data)}")
                    if crawl_data:
                        sample_crawl = list(crawl_data.values())[0]
                        st.markdown(f"- **Colonnes crawl disponibles**: {list(sample_crawl.keys()) if sample_crawl else 'N/A'}")
                    
                    st.info("💡 **Conseils pour générer des recommandations:**")
                    st.markdown("""
                    1. **Ajoutez le fichier crawl** pour plus de données (titres, word count, etc.)
                    2. **Vérifiez les filtres** - essayez de baisser le score minimum à 0
                    3. **Types de pages recherchées:**
                       - **BOOST**: Pages avec contenu mais peu de liens entrants
                       - **ORPHAN**: Pages sans aucun lien entrant  
                       - **HUB**: Pages riches qui pourraient redistribuer du jus
                    4. **Assurez-vous d'avoir des liens contextuels** (pas seulement nav/footer)
                    """)
            
            with tab2:
                st.subheader("Analyse par page")
                if not results['pages'].empty:
                    # Sort by priority then score
                    df_display = results['pages'].sort_values(['Priority', 'SEO_Score'], 
                                                               ascending=[True, True])
                    cols_display = ['URL', 'Priority', 'SEO_Score', 'Content_Links', 'Navigation_Links', 
                                   'Footer_Links', 'Unique_Sources_Content', 'Sitewide_Ratio']
                    st.dataframe(df_display[cols_display].head(200), use_container_width=True, hide_index=True, height=500)
            
            with tab3:
                st.subheader("Conflits d'ancres (même anchor → plusieurs URLs)")
                if not results['conflicts'].empty:
                    st.dataframe(results['conflicts'].head(200), use_container_width=True, hide_index=True, height=500)
                else:
                    st.success("Aucun conflit d'ancre détecté dans les liens contextuels")
            
            with tab4:
                st.subheader("Carte des ancres")
                st.dataframe(results['anchor_map'].head(500), use_container_width=True, hide_index=True, height=500)
            
            with tab5:
                col1, col2 = st.columns(2)
                with col1:
                    st.pyplot(plot_position_pie(results['position_breakdown']))
                with col2:
                    st.pyplot(plot_priority_bar(results['pages']))
                
                st.pyplot(plot_score_distribution(results['pages']))
            
            with tab6:
                st.subheader("Scope de l'analyse")
                st.markdown(f"""
                **Total lignes dans le fichier:** {results['scope']['total']:,}  
                **Lignes gardées pour analyse:** {results['scope']['kept']:,}  
                **Lignes exclues:** {results['scope']['total'] - results['scope']['kept']:,}
                """)
                
                if results.get('scope', {}).get('excluded'):
                    st.markdown("**Détail des exclusions:**")
                    for reason, count in results['scope']['excluded'].items():
                        if count > 0:
                            st.markdown(f"- {reason}: {count:,}")
                
                st.markdown("---")
                st.markdown(f"""
                **Répartition des liens gardés:**
                - Contenu: {results['position_breakdown']['Content']:,}
                - Navigation: {results['position_breakdown']['Navigation']:,}
                - Footer: {results['position_breakdown']['Footer']:,}
                - Autre/Inconnu: {results['position_breakdown']['Other']:,}
                """)

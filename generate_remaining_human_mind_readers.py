from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import json
import re

from PIL import Image


ROOT = Path.cwd()
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
FEEDBACK_ENDPOINT = "https://script.google.com/macros/s/AKfycbwUMR4-6fG8I4JIUGhrRG6y38brSq-bG0nWAF3R_Uh1rYLKj_BGzwgUwpcooVguLHMsHA/exec"
OCCUPATIONS = ["Student", "Educator", "Working Professional", "Writer", "Other"]
RATINGS = ["1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5"]


PALETTES = {
    "quiet": {
        "light": ["#E2E6E8", "#F6F0E7", "#EDE5DB", "#26313A", "#18212B", "#6D748F", "#464E6D", "#927B62"],
        "sepia": ["#E2D6C8", "#F2E5D4", "#E7D8C4", "#332E29", "#251F1C", "#686076", "#4D465F", "#8D7156"],
        "dark": ["#0F141B", "#171D27", "#202733", "#EEE7DD", "#F7F1E9", "#AEB4CC", "#D0D3E8", "#C1A77D"],
    },
    "loop": {
        "light": ["#D9E2DF", "#F4EDDF", "#E9E0D2", "#23342F", "#132620", "#446B62", "#244B43", "#8A7354"],
        "sepia": ["#DED7C9", "#F1E5D2", "#E7D9C4", "#332F28", "#211F1A", "#4F6655", "#374D3F", "#8A6D4D"],
        "dark": ["#0B1514", "#14201E", "#1C2A27", "#ECE7DC", "#F5F0E7", "#85AB9E", "#B5D3C7", "#C2A678"],
    },
    "understanding": {
        "light": ["#E1E4DE", "#F7F0E4", "#ECE5D8", "#2B302B", "#1F241F", "#7C7651", "#555B43", "#9A704E"],
        "sepia": ["#E2D8C9", "#F3E6D1", "#E8DAC4", "#352F27", "#251F19", "#7F694B", "#5F503C", "#92704D"],
        "dark": ["#10140F", "#1A1D18", "#24271F", "#EFE8DB", "#F8F1E8", "#C4BD8C", "#E0D9A8", "#C6A174"],
    },
}


def variables(colors):
    bg, paper, soft, text, heading, accent, strong, warm = colors
    light_text = text if text.startswith("#2") or text.startswith("#3") or text.startswith("#1") else "#F2ECE4"
    return {
        "--reader-bg": bg,
        "--reader-paper": paper,
        "--reader-paper-soft": soft,
        "--reader-text": text,
        "--reader-heading": heading,
        "--reader-muted": f"color-mix(in srgb, {text} 72%, transparent)",
        "--reader-subtle": f"color-mix(in srgb, {text} 62%, transparent)",
        "--reader-faint": f"color-mix(in srgb, {text} 11%, transparent)",
        "--reader-rule": f"color-mix(in srgb, {accent} 24%, transparent)",
        "--reader-border": f"color-mix(in srgb, {text} 20%, transparent)",
        "--reader-accent": accent,
        "--reader-accent-strong": strong,
        "--reader-accent-soft": f"color-mix(in srgb, {accent} 12%, transparent)",
        "--reader-warm": warm,
        "--reader-focus": strong,
        "--reader-control-bg": soft,
        "--reader-control-border": f"color-mix(in srgb, {text} 18%, transparent)",
        "--reader-input-bg": paper,
        "--reader-input-text": light_text,
        "--reader-placeholder": f"color-mix(in srgb, {text} 56%, transparent)",
        "--reader-success": "#4F6B4D",
        "--reader-error-text": "#94474C",
        "--reader-page-edge": f"color-mix(in srgb, {accent} 8%, transparent)",
        "--reader-shadow": "0 22px 58px rgba(25, 34, 39, .14)" if text.startswith("#2") or text.startswith("#3") or text.startswith("#1") else "0 24px 70px rgba(2, 5, 7, .48)",
    }


def palette_vars(key):
    return {mode: variables(values) for mode, values in PALETTES[key].items()}


BOOKS = [
    {
        "key": "quiet",
        "slug": "the-quiet-i-started-living-with",
        "title": "The Quiet I Started Living With",
        "subtitle": "A Psychological Reflection on Silence, Identity, Overthinking, and the Invisible Distance Between Who We Are and Who We Slowly Become",
        "bookNumber": "Book III",
        "word": "projects/human-mind/chapters/WORD/THE QUIET I STARTED LIVING WITH.docx",
        "pdf": "projects/human-mind/chapters/PDF/the quiet i started living with lrm.pdf",
        "cover": "projects/human-mind/assets/covers/the quiet i started living with .jpeg",
        "themeClass": "reader-theme-quiet-living",
        "themeName": "Low Echo Room",
        "purpose": "A hushed interior identity for silence that has become a lived place.",
        "keywords": ["silence as shelter", "interior distance", "unspoken emotion", "soft disappearance", "quiet survival", "private rooms"],
        "motif": "low echo rules and quiet vertical pauses",
        "openingRoles": {1: "series-line", 2: "book-number", 4: "title", 5: "subtitle-line", 6: "author", 7: "epigraph", 8: "epigraph", 9: "epigraph", 10: "epigraph", 12: "publisher", 14: "collection-line"},
        "units": [
            ("opening", "opening", "Opening", 1, {}, None),
            ("contents", "contents", "Contents", 16, {"title": 16}, None),
            ("copyright", "frontmatter", "Copyright", 51, {"title": 51}, None),
            ("disclaimer", "frontmatter", "Disclaimer", 61, {"title": 61}, None),
            ("dedication", "dedication", "Dedication", 70, {"title": 70}, None),
            ("authors-note", "frontmatter", "Author's Note", 80, {"title": 80}, None),
            ("prologue", "prologue", "Prologue", 98, {"number": 98, "title": 99}, None),
            ("introduction", "introduction", "Introduction", 201, {"title": 201}, None),
            ("phase-i", "part", "Phase I", 295, {"number": 295, "title": 296}, None),
            ("chapter-01", "chapter", "Chapter 1", 299, {"number": 299, "title": 300}, "Phase I - The Mind That Never Stopped Speaking"),
            ("chapter-02", "chapter", "Chapter 2", 413, {"number": 413, "title": 414}, "Phase I - The Mind That Never Stopped Speaking"),
            ("chapter-03", "chapter", "Chapter 3", 523, {"number": 523, "title": 524}, "Phase I - The Mind That Never Stopped Speaking"),
            ("chapter-04", "chapter", "Chapter 4", 606, {"number": 606, "title": 607}, "Phase I - The Mind That Never Stopped Speaking"),
            ("phase-ii", "part", "Phase II", 690, {"number": 690, "title": 691}, None),
            ("chapter-05", "chapter", "Chapter 5", 694, {"number": 694, "title": 695}, "Phase II - When Silence Becomes Your Language"),
            ("chapter-06", "chapter", "Chapter 6", 770, {"number": 770, "title": 771}, "Phase II - When Silence Becomes Your Language"),
            ("chapter-07", "chapter", "Chapter 7", 868, {"number": 868, "title": 869}, "Phase II - When Silence Becomes Your Language"),
            ("chapter-08", "chapter", "Chapter 8", 1000, {"number": 1000, "title": 1001}, "Phase II - When Silence Becomes Your Language"),
            ("phase-iii", "part", "Phase III", 1115, {"number": 1115, "title": 1116}, None),
            ("chapter-09", "chapter", "Chapter 9", 1119, {"number": 1119, "title": 1120}, "Phase III - The Weight of the Unseen"),
            ("chapter-10", "chapter", "Chapter 10", 1233, {"number": 1233, "title": 1234}, "Phase III - The Weight of the Unseen"),
            ("chapter-11", "chapter", "Chapter 11", 1343, {"number": 1343, "title": 1344}, "Phase III - The Weight of the Unseen"),
            ("chapter-12", "chapter", "Chapter 12", 1465, {"number": 1465, "title": 1466, "subtitle": 1467}, "Phase III - The Weight of the Unseen"),
            ("phase-iv", "part", "Phase IV", 1558, {"number": 1558, "title": 1559}, None),
            ("chapter-13", "chapter", "Chapter 13", 1562, {"number": 1562, "title": 1563, "subtitle": 1564}, "Phase IV - Becoming Someone the Silence Could No Longer Hide"),
            ("chapter-14", "chapter", "Chapter 14", 1645, {"number": 1645, "title": 1646, "subtitle": 1647}, "Phase IV - Becoming Someone the Silence Could No Longer Hide"),
            ("chapter-15", "chapter", "Chapter 15", 1714, {"number": 1714, "title": 1715}, "Phase IV - Becoming Someone the Silence Could No Longer Hide"),
            ("chapter-16", "chapter", "Chapter 16", 1806, {"number": 1806, "title": 1807}, "Phase IV - Becoming Someone the Silence Could No Longer Hide"),
            ("end-realization", "ending", "End Realization", 1923, {"number": 1923, "title": 1924}, None),
            ("epilogue", "epilogue", "Epilogue", 2018, {"number": 2018, "title": 2019}, None),
            ("about-author", "ending", "About the Author", 2097, {"title": 2097}, None),
        ],
    },
    {
        "key": "loop",
        "slug": "the-loop-within",
        "title": "The Loop Within",
        "subtitle": "The Mind Always Returns to What It Never Finished",
        "bookNumber": "Book IV",
        "word": "projects/human-mind/chapters/WORD/THE LOOP WITHIN.docx",
        "pdf": "projects/human-mind/chapters/PDF/the loop within.pdf",
        "cover": "projects/human-mind/assets/covers/the loop within.jpeg",
        "themeClass": "reader-theme-loop-within",
        "themeName": "Recursive Undertow",
        "purpose": "A restrained cyclical identity for repetition, replay, and unfinished meaning.",
        "keywords": ["repetition", "rumination", "internal loops", "memory replay", "unfinished meaning", "detachment"],
        "motif": "concentric inset traces and repeated small return marks",
        "openingRoles": {1: "series-line", 2: "book-number", 6: "title", 7: "subtitle-line", 10: "author", 11: "epigraph", 12: "epigraph", 13: "epigraph", 14: "epigraph", 15: "epigraph", 16: "epigraph", 17: "epigraph", 19: "publisher", 21: "collection-line"},
        "units": [
            ("opening", "opening", "Opening", 1, {}, None),
            ("contents", "contents", "Index", 23, {"title": 23}, None),
            ("copyright", "frontmatter", "Copyright", 62, {"title": 62}, None),
            ("dedication", "dedication", "Dedication", 71, {"title": 71}, None),
            ("disclaimer", "frontmatter", "Disclaimer", 81, {"title": 81}, None),
            ("authors-note", "frontmatter", "Author's Note", 91, {"title": 91}, None),
            ("prologue", "prologue", "Prologue", 125, {"number": 125, "title": 126}, None),
            ("introduction", "introduction", "Introduction", 185, {"number": 185, "title": 186}, None),
            ("part-1", "part", "Part 1", 248, {"number": 248, "title": 249}, None),
            ("chapter-01", "chapter", "Chapter 1", 251, {"number": 251, "title": 252}, "Part 1 - The Trap"),
            ("chapter-02", "chapter", "Chapter 2", 307, {"number": 307, "title": 308}, "Part 1 - The Trap"),
            ("chapter-03", "chapter", "Chapter 3", 375, {"number": 375, "title": 376}, "Part 1 - The Trap"),
            ("chapter-04", "chapter", "Chapter 4", 439, {"number": 439, "title": 440}, "Part 1 - The Trap"),
            ("part-2", "part", "Part 2", 514, {"number": 514, "title": 515}, None),
            ("chapter-05", "chapter", "Chapter 5", 518, {"number": 518, "title": 519}, "Part 2 - The Distortion"),
            ("chapter-06", "chapter", "Chapter 6", 584, {"number": 584, "title": 585}, "Part 2 - The Distortion"),
            ("chapter-07", "chapter", "Chapter 7", 648, {"number": 648, "title": 649}, "Part 2 - The Distortion"),
            ("part-3", "part", "Part 3", 723, {"number": 723, "title": 724}, None),
            ("chapter-08", "chapter", "Chapter 8", 726, {"number": 726, "title": 727}, "Part 3 - The Loop"),
            ("chapter-09", "chapter", "Chapter 9", 807, {"number": 807, "title": 808}, "Part 3 - The Loop"),
            ("chapter-10", "chapter", "Chapter 10", 882, {"number": 882, "title": 883}, "Part 3 - The Loop"),
            ("part-4", "part", "Part 4", 960, {"title": 960}, None),
            ("chapter-11", "chapter", "Chapter 11", 962, {"number": 962, "title": 963}, "Part 4 - The Weight"),
            ("chapter-12", "chapter", "Chapter 12", 1039, {"number": 1039, "title": 1040}, "Part 4 - The Weight"),
            ("chapter-13", "chapter", "Chapter 13", 1098, {"number": 1098, "title": 1099}, "Part 4 - The Weight"),
            ("part-5", "part", "Part 5", 1164, {"title": 1164}, None),
            ("chapter-14", "chapter", "Chapter 14", 1166, {"number": 1166, "title": 1167}, "Part 5 - The Break"),
            ("chapter-15", "chapter", "Chapter 15", 1230, {"number": 1230, "title": 1231}, "Part 5 - The Break"),
            ("chapter-16", "chapter", "Chapter 16", 1301, {"number": 1301, "title": 1302}, "Part 5 - The Break"),
            ("part-6", "part", "Part 6", 1372, {"number": 1372, "title": 1373}, None),
            ("chapter-17", "chapter", "Chapter 17", 1375, {"number": 1375, "title": 1376}, "Part 6 - The Shift"),
            ("chapter-18", "chapter", "Chapter 18", 1432, {"number": 1432, "title": 1433}, "Part 6 - The Shift"),
            ("chapter-19", "chapter", "Chapter 19", 1506, {"number": 1506, "title": 1507}, "Part 6 - The Shift"),
            ("chapter-20", "chapter", "Chapter 20", 1581, {"number": 1581, "title": 1582}, "Part 6 - The Shift"),
            ("epilogue", "epilogue", "Epilogue", 1640, {"number": 1640, "title": 1641}, None),
            ("final-realization", "ending", "Final Realization", 1723, {"number": 1723, "title": 1724}, None),
            ("about-author", "ending", "About the Author", 1753, {"title": 1753}, None),
        ],
    },
    {
        "key": "understanding",
        "slug": "when-understanding-begins",
        "title": "When Understanding Begins",
        "subtitle": "The greatest distance between two people was never space. It was the invisible story each believed the other could already see.",
        "bookNumber": "Book V",
        "word": "projects/human-mind/chapters/WORD/WHEN UNDERSTANDING BEGINS.docx",
        "pdf": "projects/human-mind/chapters/PDF/when understanding begins.pdf",
        "cover": "projects/human-mind/assets/covers/when understanding begins .jpeg",
        "themeClass": "reader-theme-understanding-begins",
        "themeName": "Threshold Clarity",
        "purpose": "A soft threshold identity for perspective arriving without triumph.",
        "keywords": ["understanding", "perspective", "family distance", "emotional translation", "awareness", "closure without force"],
        "motif": "threshold rules and small dawn-side markers",
        "openingRoles": {1: "series-line", 2: "book-number", 4: "title", 5: "subtitle-line", 6: "subtitle-line", 8: "author", 9: "epigraph", 10: "epigraph", 11: "epigraph", 12: "epigraph", 13: "epigraph", 14: "epigraph", 16: "publisher", 18: "collection-line"},
        "units": [
            ("opening", "opening", "Opening", 1, {}, None),
            ("contents", "contents", "Contents", 20, {"title": 20}, None),
            ("copyright", "frontmatter", "Copyright", 45, {"title": 45}, None),
            ("disclaimer", "frontmatter", "Disclaimer", 53, {"title": 53}, None),
            ("dedication", "dedication", "Dedication", 62, {"title": 62}, None),
            ("authors-note", "frontmatter", "Author's Note", 68, {"title": 68}, None),
            ("prologue", "prologue", "Prologue", 83, {"number": 83, "title": 84}, None),
            ("introduction", "introduction", "Introduction", 249, {"title": 249}, None),
            ("layer-1", "part", "Layer 1", 283, {"number": 283, "title": 284, "subtitle": 285}, None),
            ("chapter-01", "chapter", "Chapter 1", 288, {"number": 288, "title": 289}, "Layer 1 - The Human Mask"),
            ("chapter-02", "chapter", "Chapter 2", 354, {"number": 354, "title": 355}, "Layer 1 - The Human Mask"),
            ("chapter-03", "chapter", "Chapter 3", 446, {"number": 446, "title": 447}, "Layer 1 - The Human Mask"),
            ("layer-2", "part", "Layer 2", 517, {"number": 517, "title": 518, "subtitle": 519}, None),
            ("chapter-04", "chapter", "Chapter 4", 522, {"number": 522, "title": 523}, "Layer 2 - The Human Heart"),
            ("chapter-05", "chapter", "Chapter 5", 613, {"number": 613, "title": 614}, "Layer 2 - The Human Heart"),
            ("layer-3", "part", "Layer 3", 690, {"number": 690, "title": 691}, None),
            ("chapter-06", "chapter", "Chapter 6", 694, {"number": 694, "title": 695}, "Layer 3 - Healing Phase"),
            ("layer-4", "part", "Layer 4", 753, {"number": 753, "title": 754}, None),
            ("chapter-07", "chapter", "Chapter 7", 757, {"number": 757, "title": 758}, "Layer 4 - The Closure"),
            ("layer-5", "part", "Layer 5", 819, {"number": 819, "title": 820}, None),
            ("chapter-08", "chapter", "Chapter 8", 822, {"number": 822, "title": 823}, "Layer 5 - The Real World Shift"),
            ("final-reflection", "ending", "Final Reflection", 901, {"title": 901}, None),
            ("epilogue", "epilogue", "Epilogue", 916, {"number": 916, "title": 917}, None),
            ("about-author", "ending", "About the Author", 1057, {"title": 1057}, None),
        ],
    },
]


def bool_attr(run_pr, tag):
    if run_pr is None:
        return False
    el = run_pr.find(f"./w:{tag}", NS)
    if el is None:
        return False
    val = el.attrib.get(f"{{{NS['w']}}}val")
    return val not in ("0", "false", "False")


def parse_docx(path):
    with ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    paras = []
    for idx, para in enumerate(root.findall(".//w:p", NS), start=1):
        runs, pieces = [], []
        for child in para:
            if child.tag != f"{{{NS['w']}}}r":
                continue
            rpr = child.find("./w:rPr", NS)
            bold, italic = bool_attr(rpr, "b"), bool_attr(rpr, "i")
            texts = []
            for node in child:
                if node.tag == f"{{{NS['w']}}}t":
                    texts.append(node.text or "")
                elif node.tag == f"{{{NS['w']}}}tab":
                    texts.append("\t")
                elif node.tag == f"{{{NS['w']}}}br":
                    texts.append("\n")
            text = "".join(texts)
            if text:
                run = {"text": text}
                if bold:
                    run["bold"] = True
                if italic:
                    run["italic"] = True
                runs.append(run)
                pieces.append(text)
        merged = []
        for run in runs:
            if merged and merged[-1].get("bold") == run.get("bold") and merged[-1].get("italic") == run.get("italic"):
                merged[-1]["text"] += run["text"]
            else:
                merged.append(run)
        text = "".join(pieces)
        paras.append({"index": idx, "text": text.strip(), "runs": merged, "empty": not text.strip()})
    return paras


def short(text):
    return re.sub(r"[^A-Za-z0-9 ]+", "", text).strip()[:52] or text


def para_element(p, role=None, toc=False):
    text = p["text"]
    if toc:
        if re.match(r"^(PHASE|PART|LAYER|CLOSING|THE MIND|WHEN SILENCE|THE WEIGHT|BECOMING|THE HUMAN|HEALING|THE CLOSURE|THE REAL WORLD)", text, re.I):
            typ = "toc-heading"
        elif re.match(r"^(Chapter|CHAPTER|Prologue|Introduction|Epilogue|Final|End Realization|About)", text):
            typ = "toc-chapter"
        else:
            typ = "toc-line"
        el = {"type": typ, "text": text, "sourceParagraph": p["index"]}
    else:
        typ = "blockquote" if role == "epigraph" or (text.startswith('"') and len(text) < 220) else "paragraph"
        el = {"type": typ, "runs": p["runs"] or [{"text": text}], "sourceParagraph": p["index"]}
    if role:
        el["role"] = role
    elif not toc:
        if text.startswith("—") or text.startswith("~"):
            el["role"] = "chapter-end"
        elif text.isupper() and 2 <= len(text) <= 56 and not text.startswith("CHAPTER"):
            el["role"] = "section-heading"
    return el


def build_units(book, paras):
    by_index = {p["index"]: p for p in paras}
    starts = [u[3] for u in book["units"]]
    result = []
    for idx, raw in enumerate(book["units"]):
        uid, kind, label, start, header_map, phase = raw
        end = starts[idx + 1] - 1 if idx + 1 < len(starts) else len(paras)
        header_ids = set(header_map.values()) if kind != "opening" else set()
        title = book["title"] if kind == "opening" else by_index[header_map.get("title", start)]["text"]
        unit = {
            "id": uid,
            "kind": kind,
            "label": label,
            "title": title,
            "shortTitle": short(label if kind != "chapter" else title),
            "file": f"chapters/{idx:02d}-{uid}.json",
            "index": idx,
            "sourceRange": [start, end],
            "elements": [],
        }
        if phase:
            unit["phase"] = phase
        if kind == "opening":
            unit["openingMode"] = "source"
        if header_map:
            unit["headerSourceParagraphs"] = header_map
            if "number" in header_map:
                unit["number"] = by_index[header_map["number"]]["text"]
            else:
                unit["suppressHeaderNumber"] = True
            if "subtitle" in header_map:
                unit["subtitle"] = by_index[header_map["subtitle"]]["text"]
            unit["sourceHeadingParagraphs"] = list(header_map.values())
        for p in paras[start - 1 : end]:
            if p["empty"] or p["index"] in header_ids:
                continue
            role = book["openingRoles"].get(p["index"]) if kind == "opening" else None
            unit["elements"].append(para_element(p, role=role, toc=kind == "contents"))
        result.append(unit)
    nonempty = [p["index"] for p in paras if not p["empty"]]
    return result, nonempty


def css(book):
    c = book["themeClass"]
    if book["key"] == "quiet":
        layer = "linear-gradient(180deg, transparent, color-mix(in srgb, var(--reader-accent) 16%, transparent), transparent)"
        align, before, after = "center", "64px", "18px"
    elif book["key"] == "loop":
        layer = "repeating-radial-gradient(circle at 92% 12%, color-mix(in srgb, var(--reader-accent) 9%, transparent) 0 1px, transparent 1px 22px)"
        align, before, after = "left", "46px", "46px"
    else:
        layer = "linear-gradient(90deg, color-mix(in srgb, var(--reader-warm) 10%, transparent), transparent 42%)"
        align, before, after = "left", "92px", "30px"
    return f""".{c} {{
  --reader-display: "Cormorant Garamond", Georgia, serif;
  --reader-serif: Georgia, "Times New Roman", serif;
  --reader-sans: "Inter", Arial, sans-serif;
  --page-width: 664px;
  --page-height: 1026px;
  --page-padding-block: 82px;
  --page-padding-inline: 70px;
  --reader-body-size: 18px;
}}

.{c} .book-page {{
  background: linear-gradient(90deg, var(--reader-page-edge), transparent 18px, transparent calc(100% - 18px), var(--reader-page-edge)), {layer}, var(--reader-paper);
  border-color: color-mix(in srgb, var(--reader-border) 82%, transparent);
  box-shadow: var(--reader-shadow);
}}
.{c} .book-page::before {{ border-color: color-mix(in srgb, var(--reader-accent) 12%, transparent); }}
.{c} .book-page::after {{ background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--reader-accent) 20%, transparent), transparent); }}
.{c} .book-page__content {{ color: var(--reader-text); font-family: var(--reader-serif); font-size: var(--reader-body-size); line-height: 1.72; }}
.{c} .reader-paragraph + .reader-paragraph {{ margin-top: .35em; text-indent: 1.02em; }}
.{c} .reader-paragraph[data-element-role], .{c} .reader-quote[data-element-role] {{ text-indent: 0; }}
.{c} .book-page:has([data-cover-page]) {{ background: linear-gradient(90deg, color-mix(in srgb, var(--reader-accent) 8%, transparent), transparent 24px, transparent calc(100% - 24px), color-mix(in srgb, var(--reader-accent) 8%, transparent)), var(--reader-paper); }}
.{c} .reader-cover-page {{ padding: 4px; }}
.{c} .reader-cover-page__frame {{ background: color-mix(in srgb, var(--reader-paper-soft) 64%, transparent); }}
.{c} .reader-cover-page__image {{ max-width: 100%; max-height: 100%; object-fit: contain; border: 1px solid color-mix(in srgb, var(--reader-warm) 28%, transparent); box-shadow: 0 18px 44px rgba(12,18,22,.18); filter: none; opacity: 1; }}
.{c} .flow-opening {{ grid-template-columns: 1fr; text-align: center; }}
.{c} .flow-opening__copy--source {{ display: grid; gap: 9px; justify-items: center; align-content: center; min-height: 100%; max-width: 500px; margin-inline: auto; }}
.{c} .flow-opening__copy--source .reader-paragraph {{ margin: 0; text-indent: 0; color: var(--reader-muted); font-family: var(--reader-sans); font-size: .8rem; font-weight: 650; letter-spacing: .11em; line-height: 1.48; text-transform: uppercase; }}
.{c} .flow-opening__copy--source [data-element-role="title"] {{ margin-top: 16px; max-width: 10.5ch; color: var(--reader-heading); font-family: var(--reader-display); font-size: clamp(3.55rem, 9.6vw, 5.8rem); font-weight: 700; letter-spacing: 0; line-height: .9; text-transform: uppercase; }}
.{c} .flow-opening__copy--source [data-element-role="subtitle-line"] {{ max-width: 36ch; color: var(--reader-accent); font-family: var(--reader-display); font-size: clamp(1.06rem, 2.55vw, 1.48rem); font-style: italic; font-weight: 500; letter-spacing: 0; line-height: 1.24; text-transform: none; }}
.{c} .flow-opening__copy--source [data-element-role="author"] {{ margin-top: 14px; color: var(--reader-heading); }}
.{c} .flow-opening__copy--source .reader-quote, .{c} .flow-opening__copy--source [data-element-role="epigraph"] {{ width: min(100%, 420px); margin: 4px auto; padding: 0; border: 0; color: var(--reader-accent-strong); font-family: var(--reader-display); font-size: clamp(1.08rem, 2.5vw, 1.36rem); font-style: italic; line-height: 1.25; }}
.{c} .flow-opening__copy--source [data-element-role="publisher"], .{c} .flow-opening__copy--source [data-element-role="collection-line"] {{ color: var(--reader-subtle); font-size: .74rem; }}
.{c} .unit-header {{ position: relative; min-height: 216px; align-content: center; gap: 11px; padding-block: 24px 34px; text-align: {align}; }}
.{c} .unit-header::before, .{c} .unit-header::after {{ content: ""; display: block; height: 1px; background: color-mix(in srgb, var(--reader-accent) 42%, transparent); }}
.{c} .unit-header::before {{ width: {before}; margin-bottom: 16px; }}
.{c} .unit-header::after {{ width: {after}; margin-top: 12px; background: color-mix(in srgb, var(--reader-warm) 46%, transparent); }}
.{c} .unit-header--chapter {{ min-height: 300px; padding-block: 42px 46px; }}
.{c} .unit-header__phase, .{c} .contents-drawer__eyebrow {{ color: var(--reader-subtle); font-family: var(--reader-sans); font-size: .68rem; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }}
.{c} .unit-header__number {{ color: var(--reader-accent); font-family: var(--reader-sans); font-size: .78rem; font-weight: 750; letter-spacing: .15em; text-transform: uppercase; }}
.{c} .unit-header h1, .{c} .unit-header:not(.unit-header--chapter) h1 {{ max-width: 15ch; margin: 0; color: var(--reader-heading); font-family: var(--reader-display); font-size: clamp(2.82rem, 6vw, 4.1rem); font-weight: 700; letter-spacing: 0; line-height: .98; text-wrap: balance; }}
.{c} .unit-header--chapter h1 {{ max-width: 13.8ch; font-size: clamp(2.36rem, 4.8vw, 3.45rem); }}
.{c} .unit-header__subtitle {{ max-width: 26ch; margin: 0; color: var(--reader-accent-strong); font-family: var(--reader-display); font-size: clamp(1.25rem, 2.8vw, 1.7rem); font-style: italic; line-height: 1.18; }}
.{c} .book-page:has([data-unit-kind="part"]) .unit-header {{ min-height: 100%; align-content: center; text-align: center; }}
.{c} .book-page:has([data-unit-kind="part"]) .unit-header::before, .{c} .book-page:has([data-unit-kind="part"]) .unit-header::after {{ margin-inline: auto; }}
.{c} .book-page:has([data-unit-kind="part"]) .unit-header h1 {{ margin-inline: auto; color: var(--reader-accent-strong); font-size: clamp(3.05rem, 7.4vw, 4.65rem); }}
.{c} .reader-paragraph[data-element-role="section-heading"], .{c} .reader-paragraph[data-element-role="part-heading"], .{c} .reader-paragraph[data-element-role="chapter-end"] {{ margin: 1.7em 0 .6em; color: var(--reader-accent-strong); font-family: var(--reader-sans); font-size: .8rem; font-weight: 750; letter-spacing: .11em; line-height: 1.35; text-transform: uppercase; }}
.{c} .reader-paragraph[data-element-role="chapter-end"] {{ margin-top: 2em; color: var(--reader-subtle); text-align: center; }}
.{c} .reader-quote {{ color: var(--reader-accent); font-family: var(--reader-display); font-size: 1.28rem; font-style: italic; line-height: 1.33; }}
.{c} .reader-section-break {{ display: grid; justify-items: center; gap: 8px; margin: 2.2em auto; }}
.{c} .reader-section-break::before, .{c} .reader-section-break::after {{ content: ""; height: 1px; background: color-mix(in srgb, var(--reader-accent) 36%, transparent); }}
.{c} .reader-section-break::before {{ width: 54px; }}
.{c} .reader-section-break::after {{ width: 18px; background: color-mix(in srgb, var(--reader-warm) 42%, transparent); }}
.{c} .source-contents {{ font-size: .92rem; }}
.{c} .source-contents__heading {{ margin-top: 1.1em; color: var(--reader-accent-strong); font-family: var(--reader-sans); font-size: .82rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }}
.{c} .source-contents__chapter {{ color: var(--reader-heading); }}
.{c} .contents-drawer {{ border-left-color: color-mix(in srgb, var(--reader-accent) 28%, transparent); }}
.{c} .contents-list button:hover, .{c} .contents-list button[aria-current="true"] {{ border-color: color-mix(in srgb, var(--reader-accent) 42%, transparent); background: var(--reader-accent-soft); }}
.{c} .book-page:has([data-unit-kind="ending"]), .{c} .book-page:has([data-unit-kind="epilogue"]), .{c} .book-page:has([data-unit-id="about-author"]), .{c} .book-page--feedback {{ background: linear-gradient(180deg, transparent 68%, color-mix(in srgb, var(--reader-accent) 7%, transparent)), var(--reader-paper); }}
.{c} .book-page__number {{ color: var(--reader-subtle); font-family: var(--reader-sans); font-size: .72rem; letter-spacing: .08em; }}
.{c} .book-end {{ text-align: center; }}
.{c} .feedback-panel {{ border-top-color: color-mix(in srgb, var(--reader-accent) 26%, transparent); }}
.{c} .book-page--feedback.is-feedback-expanded .feedback-panel {{ max-height: none; overflow: visible; }}
.{c} .feedback-panel input, .{c} .feedback-panel textarea, .{c} .feedback-panel select {{ min-height: 44px; background: var(--reader-input-bg); color: var(--reader-input-text); border-color: var(--reader-control-border); }}
.{c} .feedback-panel input::placeholder, .{c} .feedback-panel textarea::placeholder {{ color: var(--reader-placeholder); }}
.{c} .feedback-panel input:focus, .{c} .feedback-panel textarea:focus, .{c} .feedback-panel select:focus, .{c} .reader-control:focus-visible {{ outline: 2px solid var(--reader-focus); outline-offset: 2px; }}
@media (max-width: 1024px) {{
  .{c} {{ --page-width: min(642px, calc(100vw - 56px)); --page-height: 940px; --page-padding-block: 64px; --page-padding-inline: 56px; }}
  .{c} .unit-header--chapter {{ min-height: 258px; }}
}}
@media (max-width: 640px) {{
  .{c} {{ --page-width: calc(100vw - 20px); --page-height: min(900px, calc(100svh - 118px)); --page-padding-block: 36px; --page-padding-inline: 20px; --reader-body-size: 17px; }}
  .{c} .reader-pages {{ grid-template-columns: minmax(0, 1fr); }}
  .{c} .reader-cover-page {{ padding: 0; }}
  .{c} .reader-cover-page__image {{ box-shadow: 0 12px 28px rgba(12,18,22,.16); }}
  .{c} .flow-opening__copy--source {{ gap: 7px; max-width: 100%; }}
  .{c} .flow-opening__copy--source .reader-paragraph {{ font-size: .66rem; letter-spacing: .09em; }}
  .{c} .flow-opening__copy--source [data-element-role="title"] {{ max-width: 9.6ch; font-size: clamp(2.72rem, 12.5vw, 3.85rem); }}
  .{c} .flow-opening__copy--source [data-element-role="subtitle-line"] {{ max-width: 30ch; font-size: .98rem; }}
  .{c} .flow-opening__copy--source .reader-quote, .{c} .flow-opening__copy--source [data-element-role="epigraph"] {{ font-size: 1rem; line-height: 1.22; }}
  .{c} .unit-header, .{c} .unit-header--chapter {{ min-height: 190px; padding-block: 22px 28px; }}
  .{c} .unit-header::before {{ width: 54px; margin-bottom: 12px; }}
  .{c} .unit-header::after {{ width: 20px; }}
  .{c} .unit-header h1, .{c} .unit-header:not(.unit-header--chapter) h1, .{c} .unit-header--chapter h1 {{ max-width: 13ch; font-size: clamp(2.02rem, 9.8vw, 3.2rem); }}
  .{c} .unit-header__subtitle {{ max-width: 22ch; font-size: 1.08rem; }}
  .{c} .reader-paragraph[data-element-role="section-heading"], .{c} .reader-paragraph[data-element-role="part-heading"], .{c} .reader-paragraph[data-element-role="chapter-end"] {{ font-size: .72rem; letter-spacing: .09em; }}
  .{c} .source-contents {{ font-size: .78rem; }}
  .{c} .source-contents__heading {{ font-size: .76rem; }}
}}
"""


def cover_assets(book, out_dir):
    cover_dir = out_dir / "cover"
    cover_dir.mkdir(parents=True, exist_ok=True)
    src = ROOT / book["cover"]
    with Image.open(src) as img:
        rgb = img.convert("RGB")
        rgb.save(cover_dir / "front-cover.webp", "WEBP", quality=88, method=6)
        rgb.save(cover_dir / "front-cover-print.png", "PNG")
        rgb.save(cover_dir / "cover-source.png", "PNG")
        w, h = img.size
    return {
        "width": w,
        "height": h,
        "sourceBytes": src.stat().st_size,
        "webBytes": (cover_dir / "front-cover.webp").stat().st_size,
        "printBytes": (cover_dir / "front-cover-print.png").stat().st_size,
    }


def design_spec(book, counts, cover):
    color_system = {}
    for mode, vals in PALETTES[book["key"]].items():
        color_system[mode] = {
            "outerCanvas": vals[0],
            "paper": vals[1],
            "paperSoft": vals[2],
            "text": vals[3],
            "heading": vals[4],
            "accent": vals[5],
            "accentStrong": vals[6],
            "warm": vals[7],
        }
    return {
        "bookSlug": book["slug"],
        "title": book["title"],
        "collection": "The Human Paradox Collection",
        "series": "Human Mind",
        "visualThemeName": book["themeName"],
        "designPurpose": book["purpose"],
        "emotionalKeywords": book["keywords"],
        "colorSystem": color_system,
        "fonts": {"display": "Cormorant Garamond, Georgia, serif", "body": "Georgia, Times New Roman, serif", "interface": "Inter, Arial, sans-serif"},
        "typography": {"bodyFontSizeDesktop": "18px", "bodyFontSizeTablet": "17.5px minimum", "bodyFontSizeMobile": "17px minimum", "lineHeight": 1.72, "paragraphIndent": "1.02em", "paragraphSpacing": "0.35em", "chapterTitleDesktop": "40px to 52px depending on length", "chapterTitleMobile": "30px to 38px", "quoteTreatment": "Display serif italic in the book accent color."},
        "pageGeometry": {"desktop": {"pageWidth": "664px", "pageHeight": "1026px", "pagePadding": "82px 70px", "pageGap": "58px", "measure": "60-72 characters per line", "tradeBookReference": "close to 5.5 x 8.5 portrait"}, "tablet": {"pageWidth": "min(642px, calc(100vw - 56px))", "pageHeight": "940px", "pagePadding": "64px 56px"}, "mobile": {"pageWidth": "calc(100vw - 20px)", "pageHeight": "min(900px, calc(100svh - 118px))", "safePadding": "18-22px horizontal", "bodyFontFloor": "17px", "toolbar": "compact shared toolbar with touch-friendly controls"}},
        "semanticPageTypes": {"frontCover": "Official image appears once as first unnumbered page, object-fit contain, no crop, no theme filter.", "titlePage": "Source-driven title page preserves manuscript title-page roles.", "contents": "Source table of contents rendered as unboxed literary contents.", "chapterOpening": f"Fresh page for every chapter with {book['motif']}.", "normalContinuation": "Warm paper, readable deep text, measured literary spacing, first-line indent after adjacent paragraphs.", "sectionBreak": f"Subtle {book['motif']} reduced to quiet marks.", "pageNumbers": "Small bottom folio with cover/front matter unnumbered where required.", "finalManuscriptPage": "Ending, epilogue, and about-author pages receive a softer closing surface.", "feedbackSurface": "Whole-book feedback page inherits book palette and natural-height mobile behavior."},
        "coverSpecification": {"sourceAsset": {"originalRepositoryFile": "/" + book["cover"].replace("\\", "/"), "preservedAsset": f"/assets/books/{book['slug']}/cover/cover-source.png", "format": "JPEG original preserved as PNG reference", "pixelDimensions": f"{cover['width']} x {cover['height']}", "fileSizeBytesOriginal": cover["sourceBytes"], "containsCompleteFrontCover": True, "containsPublisherBranding": True}, "websiteAsset": {"path": f"/assets/books/{book['slug']}/cover/front-cover.webp", "format": "WEBP", "pixelDimensions": f"{cover['width']} x {cover['height']}", "fileSizeBytes": cover["webBytes"], "optimization": "Converted from official JPEG at WebP quality 88 with complete artwork preserved."}, "printAsset": {"path": f"/assets/books/{book['slug']}/cover/front-cover-print.png", "format": "PNG", "pixelDimensions": f"{cover['width']} x {cover['height']}", "fileSizeBytes": cover["printBytes"], "printReadiness": "Best available full-resolution reference, not genuine 300 DPI production print art for a 5.5in x 8.5in trim."}, "referenceTrimSize": "5.5in x 8.5in portrait", "availableEffectiveDpiAtReferenceTrim": "approximately 186 DPI by width and 181 DPI by height, below 300 DPI target", "imageFitBehavior": "Use object-fit: contain. Do not recolor, filter, stretch, crop, darken, or apply theme overlays."},
        "responsiveAdaptations": {"mobile": "Nearly full-width page, 18-22px safe padding, simplified motifs, body text no smaller than 17px, no horizontal overflow, natural-height feedback.", "tablet": "Centered page with balanced page proportions and clear chapter hierarchy.", "desktop": "664px x 1026px page target, subtle edge/shadow, literary spacing, 60-72 character measure."},
        "futureWordMapping": {"trimSize": "5.5in x 8.5in", "bodyFont": "Georgia 11.5pt", "lineSpacing": "18.6pt exact", "firstLineIndent": "0.18in", "chapterTitle": "Cormorant Garamond 28-31pt", "pageNumber": "Inter/Arial 8pt bottom folio", "sectionBreak": book["motif"], "coverOrder": ["Front cover", "Optional blank verso", "Title page", "Copyright/front matter", "Contents", "Main manuscript"]},
        "futurePdfMapping": {"fixedPageTheme": "light theme only", "coverFit": "contain first page", "digitalOnly": ["toolbar", "theme switcher", "contents drawer", "progress bar", "feedback form"], "printEquivalent": "warm ivory stock with book-specific muted accent motif"},
        "printLimitations": "The available cover is suitable for digital and reference use but should be replaced with a higher-resolution bleed-ready cover for paperback production.",
        "sourceCounts": counts,
    }


def manifest(book, units, counts):
    return {
        "id": book["slug"],
        "slug": book["slug"],
        "title": book["title"],
        "subtitle": book["subtitle"],
        "collection": "The Human Paradox Collection",
        "volume": "Volume I",
        "series": "Human Mind",
        "seriesDisplay": "The Human Mind Series",
        "bookNumber": book["bookNumber"],
        "author": "Lalit R. Mishra",
        "publisher": "Greyveil Editions",
        "editionYear": "2026",
        "coverUrl": "/" + book["cover"].replace("\\", "/").replace(" ", "%20"),
        "cover": {"web": f"/assets/books/{book['slug']}/cover/front-cover.webp", "print": f"/assets/books/{book['slug']}/cover/front-cover-print.png", "source": f"/assets/books/{book['slug']}/cover/cover-source.png", "alt": f"{book['title']} book cover"},
        "readerRoute": f"/projects/human-mind/books/{book['slug']}/reader/",
        "readerExitUrl": f"/projects/human-mind/books/{book['slug']}.html",
        "storageKey": f"greyveil:{book['slug']}:continuous-reader:v1",
        "designSpecFile": "design-spec.json",
        "themeStylesheet": "theme.css",
        "feedbackEndpoint": FEEDBACK_ENDPOINT,
        "feedbackContext": {"collection": "The Human Paradox Collection", "series": "Human Mind", "book": book["title"], "feedbackType": "book"},
        "theme": {"className": book["themeClass"], "variables": palette_vars(book["key"])},
        "occupationOptions": OCCUPATIONS,
        "ratingOptions": RATINGS,
        "sourceNotes": {"wordPrimary": "/" + book["word"].replace("\\", "/"), "pdfVerification": "/" + book["pdf"].replace("\\", "/"), "sourceParagraphsTotal": counts["sourceParagraphsTotal"], "sourceParagraphsNonEmpty": counts["sourceParagraphsNonEmpty"], "manuscriptPolicy": "Word is the primary source. PDF is used only to verify title, order, headings, paragraph breaks, and completeness."},
        "units": [{k: v for k, v in u.items() if k != "elements"} for u in units],
    }


def route_html(book):
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{book['title']} Reader | Greyveil Editions</title>
  <meta name="description" content="A continuous paginated Greyveil Editions reader for {book['title']} by Lalit R. Mishra." />
  <link rel="canonical" href="https://greyveileditions.vercel.app/projects/human-mind/books/{book['slug']}/reader/" />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="512x512" href="/assets/images/favicon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/css/reader.css?v=20260726" />
</head>
<body class="reader-book" data-book-url="/assets/books/{book['slug']}/book.json" data-reader-exit-url="/projects/human-mind/books/{book['slug']}.html">
  <noscript><p class="reader-noscript">This reader needs JavaScript to load the prepared book pages.</p></noscript>
  <script src="/assets/js/reader.js?v=20260726" defer></script>
</body>
</html>
"""


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


summary = []
for book in BOOKS:
    paras = parse_docx(ROOT / book["word"])
    units, nonempty = build_units(book, paras)
    counts = {
        "sourceParagraphsTotal": len(paras),
        "sourceParagraphsNonEmpty": len(nonempty),
        "semanticUnits": len(units),
        "chapters": sum(1 for u in units if u["kind"] == "chapter"),
    }
    out = ROOT / "assets/books" / book["slug"]
    cover = cover_assets(book, out)
    for unit in units:
        write_json(out / unit["file"], unit)
    write_json(out / "book.json", manifest(book, units, counts))
    write_json(out / "design-spec.json", design_spec(book, counts, cover))
    (out / "theme.css").write_text(css(book), encoding="utf-8", newline="\n")
    route = ROOT / "projects/human-mind/books" / book["slug"] / "reader" / "index.html"
    route.parent.mkdir(parents=True, exist_ok=True)
    route.write_text(route_html(book), encoding="utf-8", newline="\n")
    summary.append({"slug": book["slug"], **counts, "cover": cover})

print(json.dumps(summary, indent=2))

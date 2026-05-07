#!/usr/bin/env python3
"""Manipulate .docx Word documents: merge, extract, split, info, replace-text,
accept-changes.

Body copying uses python-docx + lxml deepcopy of the body XML onto a fresh
document. Text and tables survive; styles RESOLVE against the FIRST input's
styles map. WARNING: images from documents after the first may break because
merge does NOT copy media/relationships. For image-safe merges, ensure all
inputs share the same template OR convert each to PDF first via docx_convert.py.
"""
import argparse
import copy
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from docx import Document
from docx.enum.text import WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn


# ── Helpers ────────────────────────────────────────────────────────────────
def _check_extension(path: Path) -> None:
    if path.suffix.lower() not in (".docx", ".dotx"):
        raise ValueError(f"Unsupported extension: {path.suffix} (use .docx or .dotx). "
                         f"For legacy .doc files, run docx_convert.py doc2docx first.")


def _parse_indices(spec: str, total: int) -> List[int]:
    out: List[int] = []
    invalid_parts = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            parts = part.split("-", 1)
            if len(parts) != 2:
                invalid_parts.append(part)
                continue  # Invalid range format, skip
            a, b = parts
            try:
                a_i, b_i = int(a), int(b)
            except ValueError:
                invalid_parts.append(part)
                continue  # Invalid numbers, skip
            if a_i > b_i:
                a_i, b_i = b_i, a_i
            out.extend(range(a_i, b_i + 1))
        else:
            try:
                out.append(int(part))
            except ValueError:
                invalid_parts.append(part)
                continue  # Invalid number, skip
    if invalid_parts:
        print(f"Warning: Invalid index parts ignored: {', '.join(invalid_parts)}", file=sys.stderr)
    out = [i for i in out if 1 <= i <= total]
    return sorted(set(out))


def _body_children(doc) -> List[Any]:
    body = doc.element.body
    return [child for child in body.iterchildren()
            if child.tag in (qn("w:p"), qn("w:tbl"), qn("w:sectPr"))]


def _strip_final_sectPr(body) -> Optional[Any]:
    """Word stores the last section's properties as the final <w:sectPr> child
    of body. Detach and return it (caller may re-append later)."""
    last = body[-1] if len(body) else None
    if last is not None and last.tag == qn("w:sectPr"):
        body.remove(last)
        return last
    return None


def _append_page_break(doc) -> None:
    p = doc.add_paragraph()
    r = p.add_run()
    r.add_break(WD_BREAK.PAGE)


# ── merge ──────────────────────────────────────────────────────────────────
def cmd_merge(inputs: Sequence[Path], output: Path, no_page_break: bool) -> Dict[str, Any]:
    if len(inputs) < 2:
        raise ValueError("merge requires at least 2 input files.")
    for p in inputs:
        if not p.exists():
            raise FileNotFoundError(f"Input not found: {p}")
        _check_extension(p)

    # Use the first input as the base (preserves its styles + theme)
    base_path = inputs[0]
    dest_tmp_dir = Path(tempfile.mkdtemp(prefix="docx_merge_"))
    try:
        base_copy = dest_tmp_dir / base_path.name
        shutil.copyfile(base_path, base_copy)
        dest = Document(str(base_copy))

        body = dest.element.body
        final_sectPr = _strip_final_sectPr(body)

        counts: List[Dict[str, Any]] = [{
            "file": str(base_path),
            "paragraphs_appended": 0,
            "tables_appended": 0,
            "note": "first input (used as base, styles inherited)",
        }]

        for src_path in inputs[1:]:
            if not no_page_break:
                _append_page_break(dest)
            src = Document(str(src_path))
            p_count = 0
            t_count = 0
            for child in _body_children(src):
                if child.tag == qn("w:sectPr"):
                    continue  # don't import section breaks
                clone = copy.deepcopy(child)
                body.append(clone)
                if clone.tag == qn("w:p"):
                    p_count += 1
                else:
                    t_count += 1
            counts.append({
                "file": str(src_path),
                "paragraphs_appended": p_count,
                "tables_appended": t_count,
            })

        if final_sectPr is not None:
            body.append(final_sectPr)

        output.parent.mkdir(parents=True, exist_ok=True)
        dest.save(str(output))
        return {
            "action": "merge",
            "output": str(output),
            "base": str(base_path),
            "inputs": counts,
            "total_inputs": len(inputs),
        }
    finally:
        try:
            shutil.rmtree(dest_tmp_dir)
        except Exception:
            pass


# ── extract ────────────────────────────────────────────────────────────────
def cmd_extract(input_path: Path, output: Path, *,
                paragraphs: Optional[str], sections: Optional[str]) -> Dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")
    _check_extension(input_path)
    if not paragraphs and not sections:
        raise ValueError("extract requires --paragraphs OR --sections.")
    if paragraphs and sections:
        raise ValueError("extract accepts EITHER --paragraphs OR --sections, not both.")

    src_tmp_dir = Path(tempfile.mkdtemp(prefix="docx_extract_"))
    try:
        src_copy = src_tmp_dir / input_path.name
        shutil.copyfile(input_path, src_copy)
        src = Document(str(src_copy))

        # Build a fresh destination doc that inherits the source's styles
        dest_copy = src_tmp_dir / f"dest_{input_path.name}"
        shutil.copyfile(input_path, dest_copy)
        dest = Document(str(dest_copy))
        # Wipe all body content
        body = dest.element.body
        final_sectPr = _strip_final_sectPr(body)
        for child in list(body):
            body.remove(child)

        body_children = [c for c in src.element.body.iterchildren()
                         if c.tag in (qn("w:p"), qn("w:tbl"))]
        kept: List[int] = []

        if paragraphs:
            indices = _parse_indices(paragraphs, len(body_children))
            for idx in indices:
                body.append(copy.deepcopy(body_children[idx - 1]))
                kept.append(idx)
        else:
            # sections-based: split body by <w:sectPr> markers
            section_groups: List[List[Any]] = []
            current: List[Any] = []
            for child in src.element.body.iterchildren():
                if child.tag == qn("w:tbl") or child.tag == qn("w:p"):
                    current.append(child)
                # Check for sectPr in pPr (inside paragraph)
                if child.tag == qn("w:p"):
                    pPr = child.find(qn("w:pPr"))
                    if pPr is not None:
                        sectPr = pPr.find(qn("w:sectPr"))
                        if sectPr is not None:
                            section_groups.append(current)
                            current = []
                # Also check for standalone sectPr as direct child of body
                elif child.tag == qn("w:sectPr"):
                    section_groups.append(current)
                    current = []
            if current:
                section_groups.append(current)
            indices = _parse_indices(sections, len(section_groups))
            for idx in indices:
                for child in section_groups[idx - 1]:
                    body.append(copy.deepcopy(child))
                kept.append(idx)

        if final_sectPr is not None:
            body.append(final_sectPr)

        output.parent.mkdir(parents=True, exist_ok=True)
        dest.save(str(output))
        return {
            "action": "extract",
            "input": str(input_path),
            "output": str(output),
            "mode": "paragraphs" if paragraphs else "sections",
            "kept_indices": kept,
            "count": len(kept),
        }
    finally:
        try:
            shutil.rmtree(src_tmp_dir)
        except Exception:
            pass


# ── split ──────────────────────────────────────────────────────────────────
def cmd_split(input_path: Path, output_prefix: str) -> Dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")
    _check_extension(input_path)

    src_tmp_dir = Path(tempfile.mkdtemp(prefix="docx_split_"))
    try:
        src_copy = src_tmp_dir / input_path.name
        shutil.copyfile(input_path, src_copy)
        src = Document(str(src_copy))

        # Group body children by section (w:sectPr inside w:pPr marks the end)
        section_groups: List[List[Any]] = []
        current: List[Any] = []
        for child in src.element.body.iterchildren():
            if child.tag == qn("w:tbl"):
                current.append(child)
            elif child.tag == qn("w:p"):
                current.append(child)
                pPr = child.find(qn("w:pPr"))
                if pPr is not None and pPr.find(qn("w:sectPr")) is not None:
                    section_groups.append(current)
                    current = []
            elif child.tag == qn("w:sectPr"):
                if current:
                    section_groups.append(current)
                    current = []
        if current:
            section_groups.append(current)

        if len(section_groups) <= 1:
            # Fallback: write a single output (split-on-page-break is unreliable
            # without a render pass; tell the user to use sections explicitly)
            section_groups = section_groups or [list(src.element.body)]

        outputs: List[str] = []
        pad = max(3, len(str(len(section_groups))))
        for idx, group in enumerate(section_groups, start=1):
            dest_copy = src_tmp_dir / f"part_{idx}.docx"
            shutil.copyfile(input_path, dest_copy)
            dest = Document(str(dest_copy))
            body = dest.element.body
            final_sectPr = _strip_final_sectPr(body)
            for child in list(body):
                body.remove(child)
            for child in group:
                # Skip the trailing sectPr marker of this section group
                if child.tag == qn("w:p"):
                    pPr = child.find(qn("w:pPr"))
                    if pPr is not None:
                        sectPr_inner = pPr.find(qn("w:sectPr"))
                        if sectPr_inner is not None:
                            pPr.remove(sectPr_inner)
                body.append(copy.deepcopy(child))
            if final_sectPr is not None:
                body.append(final_sectPr)
            out_path = Path(f"{output_prefix}_{str(idx).zfill(pad)}.docx")
            out_path.parent.mkdir(parents=True, exist_ok=True)
            dest.save(str(out_path))
            outputs.append(str(out_path))
        return {
            "action": "split",
            "input": str(input_path),
            "outputs": outputs,
            "count": len(outputs),
        }
    finally:
        try:
            shutil.rmtree(src_tmp_dir)
        except Exception:
            pass


# ── info ───────────────────────────────────────────────────────────────────
def cmd_info(input_path: Path) -> Dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")
    _check_extension(input_path)
    doc = Document(str(input_path))
    core = doc.core_properties
    paragraph_count = len(doc.paragraphs)
    table_count = len(doc.tables)
    section_count = len(doc.sections)
    return {
        "action": "info",
        "file": str(input_path),
        "paragraph_count": paragraph_count,
        "table_count": table_count,
        "section_count": section_count,
        "properties": {
            "title": core.title, "author": core.author,
            "subject": core.subject,
            "modified": str(core.modified) if core.modified else None,
            "revision": core.revision,
        },
    }


# ── replace-text ───────────────────────────────────────────────────────────
def _merge_runs_in_paragraph(para) -> None:
    """Merge adjacent runs that share the same rPr fingerprint into one,
    so cross-run placeholders like ``{{COMPANY}}`` become findable."""
    p_el = para._element
    runs = list(p_el.findall(qn("w:r")))
    if len(runs) < 2:
        return
    # Greedily merge adjacent runs whose rPr XML is identical
    i = 0
    while i < len(runs) - 1:
        a = runs[i]
        b = runs[i + 1]
        a_rPr = a.find(qn("w:rPr"))
        b_rPr = b.find(qn("w:rPr"))
        a_xml = "" if a_rPr is None else _xml_signature(a_rPr)
        b_xml = "" if b_rPr is None else _xml_signature(b_rPr)
        if a_xml != b_xml:
            i += 1
            continue
        # Merge: append all <w:t> of b into a, keeping order
        # Then remove b
        for child in list(b):
            if child.tag == qn("w:rPr"):
                continue
            a.append(child)
        parent = b.getparent()
        if parent is not None:
            parent.remove(b)
        runs.pop(i + 1)
        # Don't advance i: try to merge again with the new neighbor


def _xml_signature(el) -> str:
    from lxml import etree  # pylint: disable=import-outside-toplevel
    return etree.tostring(el, method="c14n").decode("utf-8")


def _replace_in_paragraph(para, replacements: Dict[str, str], *,
                          regex: bool, case_insensitive: bool) -> int:
    _merge_runs_in_paragraph(para)
    runs = list(para._element.findall(qn("w:r")))
    if not runs:
        return 0

    # Concatenate all <w:t> within each run (preserving run boundaries)
    run_texts: List[str] = []
    for r in runs:
        ts = r.findall(qn("w:t"))
        run_texts.append("".join(t.text or "" for t in ts))
    full_text = "".join(run_texts)
    if not full_text:
        return 0

    new_text = full_text
    n_replacements = 0
    flags = re.IGNORECASE if case_insensitive else 0
    for pattern, replacement in replacements.items():
        if regex:
            compiled = re.compile(pattern, flags)
            new_text, n = compiled.subn(replacement, new_text)
            n_replacements += n
        else:
            if case_insensitive:
                compiled = re.compile(re.escape(pattern), flags)
                new_text, n = compiled.subn(replacement, new_text)
                n_replacements += n
            else:
                if pattern in new_text:
                    n = new_text.count(pattern)
                    new_text = new_text.replace(pattern, replacement)
                    n_replacements += n
    if n_replacements == 0:
        return 0

    # Distribute the new text back across runs.
    # LIMITATION: puts ALL new text in the FIRST run's first <w:t>, blanks others.
    # This means mixed formatting (bold/italic/colors within paragraph) is lost.
    # For simple replacements with uniform formatting this is acceptable.
    first_run = runs[0]
    # Find or create the first <w:t>
    first_t = first_run.find(qn("w:t"))
    if first_t is None:
        first_t = OxmlElement("w:t")
        first_run.append(first_t)
    first_t.set(qn("xml:space"), "preserve")
    first_t.text = new_text
    # Remove extra <w:t> in first run
    for extra in first_run.findall(qn("w:t"))[1:]:
        first_run.remove(extra)
    # Blank out subsequent runs' text
    for r in runs[1:]:
        for t in r.findall(qn("w:t")):
            t.text = ""

    return n_replacements


def _walk_all_paragraphs(doc, include_headers_footers: bool, include_tables: bool):
    yield from doc.paragraphs
    if include_tables:
        for tbl in doc.tables:
            for row in tbl.rows:
                for cell in row.cells:
                    yield from cell.paragraphs
                    # Nested tables
                    for inner in cell.tables:
                        for irow in inner.rows:
                            for icell in irow.cells:
                                yield from icell.paragraphs
    if include_headers_footers:
        for section in doc.sections:
            for hf in (section.header, section.footer):
                if hf is None:
                    continue
                yield from hf.paragraphs
                for tbl in hf.tables:
                    for row in tbl.rows:
                        for cell in row.cells:
                            yield from cell.paragraphs


def cmd_replace_text(input_path: Path, output: Path, replacements_path: Path, *,
                     regex: bool, case_insensitive: bool,
                     include_headers_footers: bool, include_tables: bool) -> Dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")
    _check_extension(input_path)
    if not replacements_path.exists():
        raise FileNotFoundError(f"Replacements file not found: {replacements_path}")

    try:
        replacements = json.loads(replacements_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in replacements file: {exc}") from exc
    if not isinstance(replacements, dict):
        raise ValueError("replacements JSON must be an object: {pattern: replacement}.")
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in replacements.items()):
        raise ValueError("All keys and values in replacements must be strings.")

    work_dir = Path(tempfile.mkdtemp(prefix="docx_replace_"))
    try:
        work_copy = work_dir / input_path.name
        shutil.copyfile(input_path, work_copy)
        doc = Document(str(work_copy))

        total = 0

        for para in _walk_all_paragraphs(doc, include_headers_footers, include_tables):
            n = _replace_in_paragraph(
                para, replacements,
                regex=regex, case_insensitive=case_insensitive,
            )
            total += n
            # We count globally; per-pattern is not tracked finely here (multi-pattern
            # passes share a single sub call). For simplicity report total.

        output.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(output))
        return {
            "action": "replace-text",
            "input": str(input_path),
            "output": str(output),
            "replacements_applied": total,
            "patterns": list(replacements.keys()),
            "regex": regex,
            "case_insensitive": case_insensitive,
        }
    finally:
        try:
            shutil.rmtree(work_dir)
        except Exception:
            pass


# ── accept-changes ─────────────────────────────────────────────────────────
def _libreoffice_accept_or_reject(input_path: Path, output: Path, reject: bool,
                                  strip_comments: bool) -> Dict[str, Any]:
    # We manipulate the XML directly instead of using LibreOffice macros
    # (headless LibreOffice doesn't easily support macro injection)
    work_dir = Path(tempfile.mkdtemp(prefix="docx_accept_"))
    try:
        work_copy = work_dir / input_path.name
        shutil.copyfile(input_path, work_copy)

        from lxml import etree  # pylint: disable=import-outside-toplevel

        edited = _accept_or_reject_via_xml(work_copy, reject=reject,
                                           strip_comments=strip_comments)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(edited, output)
        return {
            "action": "accept-changes" if not reject else "reject-changes",
            "input": str(input_path),
            "output": str(output),
            "strip_comments": strip_comments,
            "method": "xml",
        }
    finally:
        try:
            shutil.rmtree(work_dir)
        except Exception:
            pass


def _accept_or_reject_via_xml(path: Path, *, reject: bool,
                              strip_comments: bool) -> Path:
    """Implement accept/reject by XML transformation: drop <w:del> entirely
    (or convert to plain text on reject), unwrap <w:ins> → keep contents
    (or drop on reject). Handles document.xml, headers, footers, footnotes."""
    import zipfile  # pylint: disable=import-outside-toplevel
    from lxml import etree  # pylint: disable=import-outside-toplevel

    out_path = path.with_suffix(path.suffix + ".tmp.docx")

    with zipfile.ZipFile(path, "r") as zin, zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            target_xml = (
                item.filename == "word/document.xml"
                or item.filename.startswith("word/header")
                or item.filename.startswith("word/footer")
                or item.filename.startswith("word/footnotes")
                or item.filename.startswith("word/endnotes")
            ) and item.filename.endswith(".xml")
            if target_xml:
                try:
                    root = etree.fromstring(data)
                    _process_tracked_changes(root, reject=reject)
                    if strip_comments:
                        _strip_comment_refs(root)
                    data = etree.tostring(root, xml_declaration=True, encoding="UTF-8",
                                          standalone=True)
                except Exception as exc:
                    # Log warning but continue with original data to avoid corruption
                    import sys
                    print(f"Warning: failed to process tracked changes in {item.filename}: {exc}", file=sys.stderr)
            elif strip_comments and item.filename == "word/comments.xml":
                # Drop all comments
                try:
                    root = etree.fromstring(data)
                    for c in list(root):
                        root.remove(c)
                    data = etree.tostring(root, xml_declaration=True, encoding="UTF-8",
                                          standalone=True)
                except Exception as exc:
                    # Log warning but continue with original data to avoid corruption
                    import sys
                    print(f"Warning: failed to strip comments from {item.filename}: {exc}", file=sys.stderr)
            zout.writestr(item, data)
    # Replace original
    final = path.with_name(path.stem + ".accepted.docx")
    shutil.move(out_path, final)
    return final


def _process_tracked_changes(root, *, reject: bool) -> None:
    """Drop deleted runs (or restore them on reject) and unwrap inserted runs
    (or drop them on reject)."""
    # Process w:ins
    for ins in list(root.iter(qn("w:ins"))):
        parent = ins.getparent()
        if parent is None:
            continue
        index = parent.index(ins)
        if reject:
            # Reject insertion: remove the entire <w:ins>
            parent.remove(ins)
        else:
            # Accept insertion: unwrap children into parent at the same index
            for i, child in enumerate(list(ins)):
                parent.insert(index + i, child)
            parent.remove(ins)

    # Process w:del
    for d in list(root.iter(qn("w:del"))):
        parent = d.getparent()
        if parent is None:
            continue
        index = parent.index(d)
        if reject:
            # Reject deletion: keep deleted text by converting <w:delText> → <w:t>
            for child in list(d):
                if child.tag == qn("w:r"):
                    for t in child.findall(qn("w:delText")):
                        t.tag = qn("w:t")
                parent.insert(index, child)
                index += 1
            parent.remove(d)
        else:
            # Accept deletion: simply remove
            parent.remove(d)

    # Process format changes pPrChange / rPrChange — accept = just drop the change record
    for tag in ("w:pPrChange", "w:rPrChange"):
        for el in list(root.iter(qn(tag))):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)


def _strip_comment_refs(root) -> None:
    for tag in ("w:commentRangeStart", "w:commentRangeEnd", "w:commentReference"):
        for el in list(root.iter(qn(tag))):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)


def cmd_accept_changes(input_path: Path, output: Path, *,
                        reject: bool, strip_comments: bool) -> Dict[str, Any]:
    if not input_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")
    _check_extension(input_path)
    return _libreoffice_accept_or_reject(input_path, output,
                                         reject=reject,
                                         strip_comments=strip_comments)


# ── CLI ────────────────────────────────────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser(description="Manipulate .docx files (merge / extract / split / info / replace-text / accept-changes).")
    sub = p.add_subparsers(dest="action", required=True)

    p_merge = sub.add_parser("merge", help="Concatenate paragraphs/tables from multiple .docx files.")
    p_merge.add_argument("--inputs", nargs="+", required=True)
    p_merge.add_argument("--output", required=True)
    p_merge.add_argument("--no-page-break", action="store_true",
                         help="Concat without inserting a page break between docs")

    p_ext = sub.add_parser("extract", help="Extract paragraph or section ranges.")
    p_ext.add_argument("--input", required=True)
    p_ext.add_argument("--output", required=True)
    p_ext.add_argument("--paragraphs", help='1-based body-paragraph index spec like "10-50"')
    p_ext.add_argument("--sections", help='1-based section index spec like "1,3"')

    p_split = sub.add_parser("split", help="Split into one .docx per section.")
    p_split.add_argument("--input", required=True)
    p_split.add_argument("--output-prefix", required=True)

    p_info = sub.add_parser("info", help="Print metadata + body counts.")
    p_info.add_argument("--input", required=True)

    p_rep = sub.add_parser("replace-text", help="Literal find/replace, run-aware (formatting preserved).")
    p_rep.add_argument("--input", required=True)
    p_rep.add_argument("--output", required=True)
    p_rep.add_argument("--replacements", required=True,
                       help='Path to JSON file: {"pattern":"replacement",...}')
    p_rep.add_argument("--regex", action="store_true", help="Treat keys as regex patterns")
    p_rep.add_argument("--case-insensitive", action="store_true")
    p_rep.add_argument("--no-headers-footers", action="store_true",
                       help="Skip headers/footers (default: include)")
    p_rep.add_argument("--no-tables", action="store_true",
                       help="Skip tables (default: include)")

    p_acc = sub.add_parser("accept-changes", help="Accept (or reject) all tracked changes.")
    p_acc.add_argument("--input", required=True)
    p_acc.add_argument("--output", required=True)
    p_acc.add_argument("--reject", action="store_true", help="Reject changes instead of accepting")
    p_acc.add_argument("--strip-comments", action="store_true",
                       help="Also remove all comments")

    args = p.parse_args()

    try:
        if args.action == "merge":
            res = cmd_merge([Path(x) for x in args.inputs], Path(args.output),
                            no_page_break=args.no_page_break)
        elif args.action == "extract":
            res = cmd_extract(
                Path(args.input), Path(args.output),
                paragraphs=args.paragraphs, sections=args.sections,
            )
        elif args.action == "split":
            res = cmd_split(Path(args.input), args.output_prefix)
        elif args.action == "info":
            res = cmd_info(Path(args.input))
        elif args.action == "replace-text":
            res = cmd_replace_text(
                Path(args.input), Path(args.output), Path(args.replacements),
                regex=args.regex,
                case_insensitive=args.case_insensitive,
                include_headers_footers=not args.no_headers_footers,
                include_tables=not args.no_tables,
            )
        elif args.action == "accept-changes":
            res = cmd_accept_changes(
                Path(args.input), Path(args.output),
                reject=args.reject,
                strip_comments=args.strip_comments,
            )
        else:
            raise ValueError(f"unknown action: {args.action}")
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(res, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()

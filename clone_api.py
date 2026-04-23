"""
clone_api.py  —  GraphCodeBERT Clone Detection REST API
========================================================
Minimal corrected version:
- Keeps original FAISS/HNSW + cache logic
- Keeps original similarity logic
- Keeps original MIN_STUB_TOKENS from extract_functions_and_embed.py
- Keeps original IGNORE_FILES from extract_functions_and_embed.py
- Adds ONLY extra real-world file skipping to avoid unnecessary comparisons
- No exact-duplicate stage
- No extra clone-counting logic
"""

import os
import sys
import json
import logging
import time
import hashlib
import pickle
from collections import defaultdict
import re
from itertools import combinations


try:
    import faiss
    import numpy as np
    import torch
    from flask import Flask, request, jsonify
    from flask_cors import CORS
except ModuleNotFoundError as e:
    missing = e.name or "a required package"
    sys.exit(
        "ERROR: Missing Python dependency: "
        f"{missing}\n"
        "Install the clone detection API dependencies with:\n"
        "  yarn setup:clone-api"
    )

# ── Import everything directly from extract_functions_and_embed.py ────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from extract_functions_and_embed import (
    extract_functions_from_file,
    extract_tokens_and_dfg,
    strategy_a_slice,
    build_graphcodebert_inputs,
    load_graphcodebert_model,
    get_encoder_hidden_states,
    DFG_FUNCTIONS,
    MODEL_NAME,
    CODE_LENGTH,
    DATA_FLOW_LENGTH,
    MIN_STUB_TOKENS,
    IGNORE_FILES,
    EXTENSION_TO_LANG,
)

# ── Config ────────────────────────────────────────────────────────────────────
BPE_EXPANSION_FACTOR = 1.4
FAISS_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "faiss_cache")
os.makedirs(FAISS_CACHE_DIR, exist_ok=True)

PIPELINE_VERSION = "v4_minimal_realworld_skip_only"

# clone_api.py

EXTRA_IGNORE_FILENAMES = {
    # generated / stubs
    "demo_pb2.py",
    "demo_pb2_grpc.py",

    # client wrappers / harnesses
    "ApiClient.java",
    "RestClient.java",
}

EXTRA_IGNORE_PATTERNS = [
    ".test.",
    ".spec.",
    ".mock.",
    ".d.ts",
    "migration",
    "seed",
    "__test__",
    "test_",
]

EXTRA_IGNORE_DIRS_IN_PATH = {
    "dist",
    "build",
    "coverage",
    "test",
    "tests",
    "__tests__",
    "mocks",
    "fixtures",
    "migrations",
    "seeds",
    "vendor",
    "target",          # Java
    ".idea",
    ".gradle",
    ".mvn",
}

TOP_K = 10


# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
)
log = logging.getLogger("clone_api")


# ── Build tree-sitter parsers (once at startup) ───────────────────────────────
log.info("Building tree-sitter parsers...")
try:
    from tree_sitter_languages import get_parser
except ImportError:
    sys.exit("ERROR: Run: pip3 install tree-sitter==0.20.4 tree-sitter-languages")

parsers = {}
for lang, dfg_fn in DFG_FUNCTIONS.items():
    parsers[lang] = (get_parser(lang), dfg_fn)
    log.info(f"  ✓ {lang}")


# ── Load GraphCodeBERT model (once at startup) ────────────────────────────────
_script_dir = os.path.dirname(os.path.abspath(__file__))
_model_subdir = os.path.join(_script_dir, "model")

log.info(f"Loading {MODEL_NAME} — this takes ~30s on first run...")
tokenizer, model, adapter_dir = load_graphcodebert_model(_model_subdir)
if adapter_dir:
    log.info(f"✓ LoRA adapter loaded from: {adapter_dir}")
    _thresh_file = os.path.join(adapter_dir, "threshold.json")
    if os.path.exists(_thresh_file):
        with open(_thresh_file, encoding="utf-8") as _tf:
            _bcb_meta = json.load(_tf)
        log.info(
            f"  BCB val-F1: {_bcb_meta.get('val_f1', 'n/a'):.4f}  "
            f"BCB classifier threshold: {_bcb_meta.get('best_threshold', 'n/a'):.4f} "
            f"(informational — API uses cosine-similarity threshold)"
        )
else:
    log.info("No LoRA adapter detected. Using base GraphCodeBERT only.")
log.info("Model ready. API accepting requests.")


# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)


# ─────────────────────────────────────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def normalize_text_for_hash(text: str) -> str:
    return text.replace("\r\n", "\n").strip()


def compute_service_content_hash(files: list) -> str:
    hash_obj = hashlib.sha256()
    hash_obj.update(PIPELINE_VERSION.encode("utf-8"))
    for f in sorted(files, key=lambda x: x.get("path") or x.get("filename", "")):
        hash_obj.update((f.get("path") or f.get("filename", "")).encode("utf-8"))
        hash_obj.update(normalize_text_for_hash(f.get("content", "")).encode("utf-8"))
    return hash_obj.hexdigest()


def should_ignore_file(path: str) -> tuple[bool, str]:
    """
    Combine original IGNORE_FILES from extract_functions_and_embed.py
    with extra real-world skip rules.
    """
    basename = os.path.basename(path)
    path_lower = path.lower()

    # keep original ignore behavior
    if basename in IGNORE_FILES:
        return True, f"IGNORE_FILES match '{basename}'"

    # extra filename ignores
    if basename in EXTRA_IGNORE_FILENAMES:
        return True, f"extra ignore filename '{basename}'"

    # extra pattern ignores
    for pattern in EXTRA_IGNORE_PATTERNS:
        if pattern in basename.lower():
            return True, f"matches pattern '{pattern}'"

    # extra directory ignores
    parts = path.replace("\\", "/").split("/")
    for part in parts[:-1]:
        if part.lower() in EXTRA_IGNORE_DIRS_IN_PATH:
            return True, f"in ignored directory '{part}'"

    return False, ""


# detect_shared_files removed for research purposes


def embed_function(tokens, dfg):
    input_ids, position_ids, attention_mask = build_graphcodebert_inputs(
        tokens,
        dfg,
        tokenizer,
    )

    with torch.no_grad():
        hidden = get_encoder_hidden_states(
            model,
            input_ids=input_ids.unsqueeze(0),
            position_ids=position_ids.unsqueeze(0),
            attention_mask=attention_mask.unsqueeze(0),
        )

    cls_emb = hidden[0, 0, :].cpu().numpy().astype(np.float32)
    return cls_emb

def is_infrastructure_file(path: str) -> bool:
    p = path.replace("\\", "/").lower()
    keywords = [
        "infrastructure", "config", "httpclient", "client", "factory",
        "middleware", "auth", "error", "logger", "thirdparty"
    ]
    return any(k in p for k in keywords)

def is_entry_point(fn_name: str, code: str, filename: str, lang: str) -> bool:
    code_lower = code.lower()
    file_lower = filename.lower()

    # ── Java (Spring Boot main) ─────────────────────────────
    if lang == "java":
        if fn_name == "main" and "springapplication.run" in code_lower:
            return True

    # ── Python (__main__ or simple main wrapper) ────────────
    if lang == "python":
        if "__name__" in code_lower and "__main__" in code_lower:
            return True
        if fn_name == "main" and len(code.splitlines()) <= 5:
            return True

    # ── JavaScript / TypeScript (server bootstrap) ──────────
    if lang in ["javascript", "typescript"]:
        if "listen(" in code_lower and ("app." in code_lower or "server." in code_lower):
            return True

    return False

def is_constructor(fn_name: str, code: str, filename: str, lang: str) -> bool:
    code_stripped = code.strip()
    header = code_stripped.split("{", 1)[0].strip()
    code_lower = code_stripped.lower()

    # ── Java ─────────────────────────────────────────────
    if lang == "java":
        if fn_name == "<anonymous>":
            return False

        prefixes = [
            f"public {fn_name}(",
            f"private {fn_name}(",
            f"protected {fn_name}(",
            f"{fn_name}(",
        ]
        return any(header.startswith(p) for p in prefixes)

    # ── JavaScript / TypeScript ──────────────────────────
    if lang in ["javascript", "typescript"]:
        # class constructor()
        if fn_name == "constructor":
            return True

        # also catch class constructor syntax
        if "constructor(" in code_lower:
            return True

        return False

    # ── Python ───────────────────────────────────────────
    if lang == "python":
        # __init__ method
        if fn_name == "__init__":
            return True

        return False

    return False


# ─────────────────────────────────────────────────────────────────────────────
#  PIPELINE
# ─────────────────────────────────────────────────────────────────────────────
def process_services(services_input: list, shared_files: set) -> tuple:
    """
    Original FAISS pipeline logic + only extra file skipping.
    Returns (all_records, service_indices).
    """
    all_records = []
    service_indices = {}

    for svc_entry in services_input:
        service_name = svc_entry.get("service", "unknown")
        files = svc_entry.get("files", [])
        log.info(f"--- Handling Service: {service_name} ({len(files)} files) ---")

        content_hash = compute_service_content_hash(files)

        safe_service_name = re.sub(r'[^A-Za-z0-9._-]', '_', service_name)
        index_path = os.path.join(FAISS_CACHE_DIR, f"{safe_service_name}_{content_hash}.index")
        meta_path = os.path.join(FAISS_CACHE_DIR, f"{safe_service_name}_{content_hash}_meta.pkl")
        os.makedirs(os.path.dirname(index_path), exist_ok=True)

        if os.path.exists(index_path) and os.path.exists(meta_path):
            log.info(f"  CACHE HIT for {service_name} (hash {content_hash[:8]})")
            with open(meta_path, "rb") as mf:
                svc_records = pickle.load(mf)
            svc_index = faiss.read_index(index_path)
            all_records.extend(svc_records)
            service_indices[service_name] = svc_index
            continue

        log.info(f"  PROCESSING {service_name} (hash miss)...")
        svc_records = []
        svc_embeddings = []

        for file_entry in files:
            filename = file_entry.get("path") or file_entry.get("filename", "unknown")
            content = file_entry.get("content", "")

            if (service_name, filename) in shared_files:
                continue

            ignore, reason = should_ignore_file(filename)
            if ignore:
                log.info(f"  [SKIP {reason}] {service_name}/{filename}")
                continue

            ext = os.path.splitext(filename)[1].lower()
            lang = EXTENSION_TO_LANG.get(ext)
            if not lang or lang not in parsers:
                continue

            try:
                functions = extract_functions_from_file(content, lang, parsers)
            except Exception as e:
                log.warning(f"  SKIP parse {service_name}/{filename}: {e}")
                continue

            for fn in functions:
                fn_name = fn["name"]
                fn_code = fn["code"]

                try:
                    tokens, dfg = extract_tokens_and_dfg(fn_code, lang, parsers)

                    # remove file-level noise
                    if fn_name == "<file>":
                        continue

                    if fn_name == "<anonymous>" and is_infrastructure_file(filename):
                        continue

                    if is_entry_point(fn_name, fn_code, filename, lang):
                        log.info(f"  [SKIP entry-point] {service_name}/{filename}::{fn_name}")
                        continue

                    if is_constructor(fn_name, fn_code, filename, lang):
                        log.info(f"  [SKIP constructor] {service_name}/{filename}::{fn_name}")
                        continue
                except Exception as e:
                    log.warning(f"  SKIP DFG {fn_name}: {e}")
                    continue

                # keep original stub logic from extract_functions_and_embed.py
                if len(tokens) < MIN_STUB_TOKENS:
                    continue

                sliced = False
                token_budget = CODE_LENGTH + DATA_FLOW_LENGTH
                if len(tokens) * BPE_EXPANSION_FACTOR > token_budget:
                    try:
                        s_tokens, s_dfg, _, _, _ = strategy_a_slice(
                            fn_code, dfg, tokens, lang, parsers
                        )
                        tokens, dfg = s_tokens, s_dfg
                        sliced = True
                    except Exception as e:
                        log.warning(f"  Slice failed {fn_name}: {e}")

                try:
                    cls_emb = embed_function(tokens, dfg)
                except Exception as e:
                    log.warning(f"  SKIP inputs/embed {fn_name}: {e}")
                    continue

                svc_records.append({
                    "service": service_name,
                    "filename": filename,
                    "function_name": fn_name,
                    "start_line": fn["start_line"],
                    "end_line": fn["end_line"],
                    "lang": lang,
                    "n_tokens": len(tokens),
                    "sliced": sliced,
                    "source_code": fn_code,
                    "embedding": cls_emb,
                })
                svc_embeddings.append(cls_emb)

                log.info(
                    f"  ✓ {service_name}/{filename}::{fn_name} "
                    f"tokens={len(tokens)} sliced={sliced}"
                )

        if svc_records:
            embs_np = np.vstack(svc_embeddings)
            faiss.normalize_L2(embs_np)

            dim = 768
            M = 32
            svc_index = faiss.IndexHNSWFlat(dim, M, faiss.METRIC_INNER_PRODUCT)
            svc_index.add(embs_np)

            for i in range(len(svc_records)):
                svc_records[i]["embedding"] = embs_np[i]

            faiss.write_index(svc_index, index_path)
            with open(meta_path, "wb") as mf:
                pickle.dump(svc_records, mf)

            all_records.extend(svc_records)
            service_indices[service_name] = svc_index
        else:
            service_indices[service_name] = None

    return all_records, service_indices


def build_clone_report(records: list, indices: dict, threshold: float) -> dict:
    """
    Original FAISS ANN comparison logic.
    """
    by_service: dict = {}
    for r in records:
        by_service.setdefault(r["service"], []).append(r)

    service_names = list(by_service.keys())
    all_pairs, clone_pairs = [], []
    seen_pairs = set()

    for q_svc in service_names:
        q_records = by_service[q_svc]
        if not q_records:
            continue

        other_svcs = [svc for svc in service_names if svc != q_svc]
        if not other_svcs:
            continue

        q_embs = np.vstack([r["embedding"] for r in q_records])

        for target_svc in other_svcs:
            target_index = indices.get(target_svc)
            if not target_index or target_index.ntotal == 0:
                continue

            target_records = by_service[target_svc]
            k = min(TOP_K, target_index.ntotal)
            D, I = target_index.search(q_embs, k)

            for q_idx in range(len(q_records)):
                ra = q_records[q_idx]
                for match_rank in range(k):
                    match_faiss_id = I[q_idx][match_rank]
                    if match_faiss_id < 0:
                        continue

                    rb = target_records[match_faiss_id]

                    uid_a = f"{ra['service']}/{ra['filename']}::{ra['function_name']}"
                    uid_b = f"{rb['service']}/{rb['filename']}::{rb['function_name']}"

                    if uid_a < uid_b:
                        pair_id = (uid_a, uid_b)
                        rec_1, rec_2 = ra, rb
                    else:
                        pair_id = (uid_b, uid_a)
                        rec_1, rec_2 = rb, ra

                    if pair_id in seen_pairs:
                        continue
                    seen_pairs.add(pair_id)

                    score = float(
                        np.dot(
                            rec_1["embedding"].flatten(),
                            rec_2["embedding"].flatten()
                        )
                    )

                    is_clone = score >= threshold
                    confidence = (
                        "HIGH" if score >= 0.95 else
                        "MEDIUM" if score >= threshold else
                        "LOW"
                    )

                    recommendation = None
                    if is_clone:
                        recommendation = make_recommendation(rec_1, rec_2, score)

                    pair = {
                        "score": round(score, 4),
                        "confidence": confidence,
                        "is_clone": is_clone,
                        "function_1": f"{rec_1['service']}/{rec_1['filename']}::{rec_1['function_name']}",
                        "service_1": rec_1["service"],
                        "lang_1": rec_1["lang"],
                        "location_1": {"start": rec_1["start_line"], "end": rec_1["end_line"]},
                        "code_1": rec_1.get("source_code", ""),

                        "function_2": f"{rec_2['service']}/{rec_2['filename']}::{rec_2['function_name']}",
                        "service_2": rec_2["service"],
                        "lang_2": rec_2["lang"],
                        "location_2": {"start": rec_2["start_line"], "end": rec_2["end_line"]},
                        "code_2": rec_2.get("source_code", ""),
                        "lang_pair": f"{rec_1['lang']}↔{rec_2['lang']}",
                        "recommendation": recommendation,
                    }
                    all_pairs.append(pair)
                    if is_clone:
                        clone_pairs.append(pair)

    all_pairs.sort(key=lambda x: x["score"], reverse=True)
    clone_pairs.sort(key=lambda x: x["score"], reverse=True)

    return {
        "config": {
            "model": MODEL_NAME,
            "threshold": threshold,
            "score_type": "faiss_hnsw_cosine_similarity",
            "code_length": CODE_LENGTH,
            "dfg_length": DATA_FLOW_LENGTH,
            "slicing_strategy": "A — line-based DFG-guided",
            "pipeline_version": PIPELINE_VERSION,
        },
        "summary": {
            "services_analysed": len(indices),
            "service_names": list(indices.keys()),
            "functions_processed": len(records),
            "functions_sliced": sum(1 for r in records if r.get("sliced", False)),
            "cross_service_pairs": len(all_pairs),
            "clones_detected": len(clone_pairs),
        },
        "clone_pairs": clone_pairs,
        "top_pairs": all_pairs[:300],
    }


def make_recommendation(ra: dict, rb: dict, score: float) -> dict:
    same_lang = ra["lang"] == rb["lang"]
    fn1 = ra["function_name"]
    fn2 = rb["function_name"]
    svc1 = ra["service"]
    svc2 = rb["service"]

    if score >= 0.98:
        urgency = "HIGH"
        action = "REMOVE_DUPLICATE"
        if same_lang:
            detail = (
                f"Functions '{fn1}' ({svc1}) and '{fn2}' ({svc2}) are "
                f"near-identical ({score:.4f}). Extract to a shared library "
                f"or shared service. Both services should call the single "
                f"shared implementation."
            )
        else:
            detail = (
                f"Functions '{fn1}' ({svc1}, {ra['lang']}) and '{fn2}' "
                f"({svc2}, {rb['lang']}) implement the same logic in different "
                f"languages ({score:.4f}). Consider exposing this as a dedicated "
                f"micro-service endpoint so both services call it via API, "
                f"eliminating the duplication."
            )
    elif score >= 0.90:
        urgency = "MEDIUM"
        action = "REVIEW_AND_MERGE"
        if same_lang:
            detail = (
                f"Functions '{fn1}' ({svc1}) and '{fn2}' ({svc2}) are "
                f"semantically similar ({score:.4f}) but may have minor "
                f"differences. Review both implementations, reconcile any "
                f"differences, and extract to a shared module."
            )
        else:
            detail = (
                f"Functions '{fn1}' ({svc1}, {ra['lang']}) and '{fn2}' "
                f"({svc2}, {rb['lang']}) share the same logic ({score:.4f}). "
                f"Review both for subtle differences before deciding whether "
                f"to consolidate via a shared API endpoint."
            )
    else:
        urgency = "LOW"
        action = "MONITOR"
        detail = (
            f"Functions '{fn1}' and '{fn2}' show structural similarity "
            f"({score:.4f}). Monitor for future divergence."
        )

    return {
        "urgency": urgency,
        "action": action,
        "detail": detail,
        "same_language": same_lang,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  ROUTES
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    info: dict = {"status": "ok", "model": MODEL_NAME}
    if adapter_dir:
        info["adapter"] = adapter_dir
        _tf = os.path.join(adapter_dir, "threshold.json")
        if os.path.exists(_tf):
            with open(_tf, encoding="utf-8") as f:
                meta = json.load(f)
            info["bcb_val_f1"] = round(meta.get("val_f1", 0), 4)
            info["bcb_classifier_threshold"] = meta.get("best_threshold")
    return jsonify(info)


@app.post("/detect-clones")
def detect_clones():
    """
    POST /detect-clones
    {
      "threshold": 0.90,
      "services": [
        {
          "service": "inventory-service",
          "files": [ { "path": "stockService.py", "content": "..." } ]
        }
      ]
    }
    """
    t0 = time.time()
    body = request.get_json(force=True, silent=True)

    if not body:
        return jsonify({"error": "Empty or invalid JSON body"}), 400

    threshold = float(body.get("threshold", 0.90))
    services_input = body.get("services", [])

    if not services_input:
        return jsonify({"error": "No services provided"}), 400

    total_files = sum(len(s.get("files", [])) for s in services_input)
    log.info(
        f"Request: {len(services_input)} service(s), "
        f"{total_files} file(s), threshold={threshold}"
    )

    try:
        # shared_files = detect_shared_files(services_input)
        records, indices = process_services(services_input, set())
        report = build_clone_report(records, indices, threshold)
    except Exception as e:
        log.error(f"Pipeline error: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

    report["meta"] = {
        "processing_time_sec": round(time.time() - t0, 2),
    }
    log.info(
        f"Done — {report['summary']['services_analysed']} service(s), "
        f"{report['summary']['functions_processed']} function(s), "
        f"{report['summary']['clones_detected']} clone(s) "
        f"in {report['meta']['processing_time_sec']}s"
    )

    return jsonify(report)


# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    log.info(f"Clone Detection API → http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
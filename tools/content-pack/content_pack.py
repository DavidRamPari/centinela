#!/usr/bin/env python3
"""Centinela content pack generator.

For every Sigma rule it asks Claude for:
  * a bilingual (Spanish / English) investigation playbook, and
  * test fixtures: events that must match the rule and near-miss events that must not.

It uses the Message Batches API (half the price of normal calls, results within 24 h,
usually much sooner) and writes one JSON file per rule to content/sigma/<rule-id>.json.
Rules that already have a file are skipped, so every command is safe to re-run.

Commands (run from the repository root):
  estimate            count pending rules and estimate the cost
  sample --n 3        generate a few rules right away (normal API) to check quality
  submit              send all pending rules as one batch
  status              show batch progress
  collect             download finished results and write the files
  retry               resubmit rules whose results failed

The API key is read from ANTHROPIC_API_KEY. Use a key from the Claude Console
organization that receives your plan's monthly API credits.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover - handled at runtime
    sys.exit("PyYAML is missing. Run: pip install -r tools/content-pack/requirements.txt")

TOOL_VERSION = "content-pack/1"
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RULES_DIR = REPO_ROOT / "rules" / "sigma"
DEFAULT_OUT_DIR = REPO_ROOT / "content" / "sigma"
WORK_DIR = Path(__file__).resolve().parent / ".work"
DEFAULT_MODEL = "claude-opus-5-5"
# Opus 5.5 and Sonnet 5.5 always think before answering (adaptive thinking), and thinking
# tokens count toward max_tokens and are billed as output, so leave plenty of room.
MAX_TOKENS = 16000
TOOL_NAME = "save_content_pack"
EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")

# USD per million tokens (standard input, standard output). Batch = 50% of these.
# Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-25).
PRICES = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}
# Used by `estimate` until `sample` has measured real usage (includes thinking tokens).
DEFAULT_OUTPUT_TOKENS_PER_RULE = 4000
CHARS_PER_TOKEN = 3.5
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TECHNIQUE_RE = re.compile(r"^attack\.(t\d{4}(?:\.\d{3})?)$", re.IGNORECASE)

SYSTEM_PROMPT = """You are a senior detection engineer and SOC lead. You write investigation playbooks and test fixtures for the detection rules of Centinela, an open-source SIEM. Analysts read a playbook while triaging an alert from that rule, so it must be specific to the rule, accurate and actionable.

Ground rules
- Base everything on the rule YAML you receive. Do not invent threat-actor attributions, CVE numbers, statistics or vendor claims. If the rule names a tool or technique, describe it factually and briefly.
- Triage steps are concrete and ordered. Refer to the fields the rule actually uses (for example CommandLine, ParentImage, cs-uri-query, the source IP or the user) and to useful pivots: the same host within +/- 15 minutes, the same user, the same source IP, parent and child processes, earlier alerts for the same entity.
- False positives are realistic legitimate causes; start from the rule's falsepositives field.
- Response steps are proportionate: verify, contain, eradicate, recover. Never recommend destructive actions without verification.
- Spanish: neutral Latin American Spanish, professional tone, no voseo. Keep usual SOC terms in English when that is what analysts say (user agent, hash, payload, endpoint).
- English: concise and plain.
- Length per language: summary at most 2 sentences; each list item at most 30 words; about 350 words in total.

Fixtures
- Each event is a flat JSON object that uses exactly the Sigma field names the rule uses (for example "Image", "CommandLine", "cs-uri-query", "cs-user-agent"). Add a few other realistic fields of that log source when it helps.
- For rules whose detection is a plain list of strings (keywords), put the complete raw log line in a "message" field, written the way that log source really writes it (for Linux, a syslog line such as "Oct 25 14:03:12 bastion-01 sudo: ..."). A keyword only matches when it appears verbatim and in one piece in that line, so pick a format that records the whole command line contiguously (for example a shell history line or a sudo COMMAND= line), never auditd EXECVE records, which split the arguments into a0, a1 and so on.
- Positive events MUST satisfy the rule's condition under Sigma semantics: string matching is case-insensitive; '*' is a wildcard; contains / startswith / endswith wrap the value with wildcards; |all requires every listed value; |windash means an option dash may also be '/', '–', '—' or '―'; |re is a regular expression (case-sensitive unless |i); |base64offset|contains means the value appears base64-encoded at any offset; |fieldref compares two fields; filters joined with 'and not' must NOT match; '1 of selection_*' needs one of those selections, 'all of' needs all of them.
- Negative events are realistic near-misses that must NOT match, for example the same binary used legitimately so that a filter excludes it, or a value that only partly matches.
- Use safe placeholder data: documentation IP ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), example.com or example.org domains, fictitious users and hosts (for example ANDES\\jperez, WS-0142, bastion-01). Do not include working exploit payloads beyond the literal strings the rule needs in order to match.

Always answer by calling the save_content_pack tool exactly once."""


def playbook_schema() -> dict[str, Any]:
    text_list = {"type": "array", "items": {"type": "string"}}
    return {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "One or two sentences: what the alert means."},
            "what_it_detects": {"type": "string"},
            "why_it_matters": {"type": "string", "description": "Impact and the ATT&CK technique in plain words."},
            "triage_steps": {**text_list, "minItems": 3, "maxItems": 8},
            "false_positives": {**text_list, "minItems": 1, "maxItems": 6},
            "response_steps": {**text_list, "minItems": 2, "maxItems": 6},
            "severity_rationale": {"type": "string", "description": "Why the rule's level fits, in one sentence."},
        },
        "required": [
            "summary",
            "what_it_detects",
            "why_it_matters",
            "triage_steps",
            "false_positives",
            "response_steps",
            "severity_rationale",
        ],
    }


def fixture_schema() -> dict[str, Any]:
    return {
        "type": "array",
        "minItems": 1,
        "maxItems": 2,
        "items": {
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "event": {
                    "type": "object",
                    "additionalProperties": {"type": ["string", "number", "boolean", "null"]},
                },
            },
            "required": ["description", "event"],
        },
    }


TOOL = {
    "name": TOOL_NAME,
    "description": "Save the bilingual playbook and the test fixtures for one Sigma rule.",
    "input_schema": {
        "type": "object",
        "properties": {
            "es": playbook_schema(),
            "en": playbook_schema(),
            "fixtures": {
                "type": "object",
                "properties": {"positive": fixture_schema(), "negative": fixture_schema()},
                "required": ["positive", "negative"],
            },
        },
        "required": ["es", "en", "fixtures"],
    },
}


# --------------------------------------------------------------------------- helpers


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def sigma_commit(rules_dir: Path) -> str | None:
    """Commit of the SigmaHQ rules: from rules/sigma/README.md, or from git for a SigmaHQ clone."""
    readme = rules_dir / "README.md"
    if readme.exists():
        match = re.search(r"\b([0-9a-f]{40})\b", readme.read_text(encoding="utf-8"))
        if match:
            return match.group(1)
    try:
        out = subprocess.run(["git", "-C", str(rules_dir), "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=10, check=True)
        commit = out.stdout.strip()
        return commit if re.fullmatch(r"[0-9a-f]{40}", commit) else None
    except (OSError, subprocess.SubprocessError):
        return None


def rule_url(rel_path: str, commit: str | None) -> str | None:
    if not commit:
        return None
    return f"https://github.com/SigmaHQ/sigma/blob/{commit}/rules/{rel_path}"


def load_rules(rules_dir: Path) -> list[dict[str, Any]]:
    """Return rule records sorted by path. Skips regression data, deprecated and broken files."""
    commit = sigma_commit(rules_dir)
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in sorted(rules_dir.rglob("*.yml")):
        rel = path.relative_to(rules_dir).as_posix()
        if rel.startswith("regression/"):
            continue
        text = path.read_text(encoding="utf-8")
        try:
            docs = list(yaml.safe_load_all(text))
        except yaml.YAMLError as exc:
            eprint(f"skip {rel}: invalid YAML ({exc.__class__.__name__})")
            continue
        if len(docs) != 1 or not isinstance(docs[0], dict):
            eprint(f"skip {rel}: expected one YAML document")
            continue
        doc = docs[0]
        rid = str(doc.get("id", ""))
        if not rid or "detection" not in doc or "title" not in doc:
            eprint(f"skip {rel}: missing id, title or detection")
            continue
        if str(doc.get("status", "")).lower() in {"deprecated", "unsupported"}:
            continue
        if rid in seen:
            eprint(f"skip {rel}: duplicate id {rid}")
            continue
        seen.add(rid)
        techniques = sorted(
            {m.group(1).upper() for t in doc.get("tags") or [] if (m := TECHNIQUE_RE.match(str(t)))}
        )
        records.append(
            {
                "id": rid,
                "custom_id": rid if ID_RE.match(rid) else re.sub(r"[^A-Za-z0-9_-]", "_", rid)[:64],
                "title": str(doc.get("title")),
                "level": doc.get("level"),
                "status": doc.get("status"),
                "author": doc.get("author"),
                "path": rel,
                "url": rule_url(rel, commit),
                "license": "DRL-1.1",
                "techniques": techniques,
                "text": text,
            }
        )
    return records


def out_path(out_dir: Path, rule: dict[str, Any]) -> Path:
    return out_dir / f"{rule['custom_id']}.json"


def pending_rules(rules: list[dict[str, Any]], out_dir: Path, force: bool) -> list[dict[str, Any]]:
    return [r for r in rules if force or not out_path(out_dir, r).exists()]


def user_prompt(rule: dict[str, Any]) -> str:
    return (
        f"Rule file: {rule['path']}\n"
        "Origin: SigmaHQ, Detection Rule License 1.1\n\n"
        f"```yaml\n{rule['text'].strip()}\n```\n\n"
        "Write the Spanish and English playbooks and the fixtures for this rule, "
        f"then deliver them by calling {TOOL_NAME} exactly once. Do not reply in plain text."
    )


def build_params(rule: dict[str, Any], model: str, effort: str | None = None) -> dict[str, Any]:
    # Opus 5.5, Sonnet 5.5 and the Fable/Mythos models reject forced tool use
    # (tool_choice "tool" or "any" returns HTTP 400), so the tool is offered with "auto"
    # and the prompt requires the call; responses without it are caught by
    # tool_input_from_message and can be resubmitted with `retry`.
    params: dict[str, Any] = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "tools": [TOOL],
        "tool_choice": {"type": "auto"},
        "messages": [{"role": "user", "content": user_prompt(rule)}],
    }
    if effort:
        params["output_config"] = {"effort": effort}
    return params


def validate_tool_input(data: Any) -> str | None:
    """Return an error message, or None when the payload has the expected shape."""
    if not isinstance(data, dict):
        return "tool input is not an object"
    for lang in ("es", "en"):
        pb = data.get(lang)
        if not isinstance(pb, dict):
            return f"missing playbook '{lang}'"
        for key in ("summary", "what_it_detects", "why_it_matters", "severity_rationale"):
            if not isinstance(pb.get(key), str) or not pb[key].strip():
                return f"playbook '{lang}' lacks '{key}'"
        for key in ("triage_steps", "false_positives", "response_steps"):
            items = pb.get(key)
            if not isinstance(items, list) or not items or not all(isinstance(i, str) for i in items):
                return f"playbook '{lang}' has an invalid '{key}'"
    fixtures = data.get("fixtures")
    if not isinstance(fixtures, dict):
        return "missing fixtures"
    for kind in ("positive", "negative"):
        items = fixtures.get(kind)
        if not isinstance(items, list) or not items:
            return f"missing {kind} fixtures"
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("event"), dict) or not item["event"]:
                return f"invalid {kind} fixture"
    return None


def tool_input_from_message(message: Any) -> tuple[dict[str, Any] | None, str | None]:
    if getattr(message, "stop_reason", None) == "max_tokens":
        return None, "output truncated (max_tokens)"
    for block in getattr(message, "content", []) or []:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == TOOL_NAME:
            data = block.input
            error = validate_tool_input(data)
            return (None, error) if error else (data, None)
    return None, "no save_content_pack tool call in the response"


def record_for(rule: dict[str, Any], data: dict[str, Any], model: str) -> dict[str, Any]:
    return {
        "rule": {k: rule[k] for k in ("id", "title", "level", "status", "author", "path", "url", "license", "techniques")},
        "playbook": {"es": data["es"], "en": data["en"]},
        "fixtures": data["fixtures"],
        "generated": {
            "tool": TOOL_VERSION,
            "model": model,
            "at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
            "review": "unreviewed",
            "notice": "AI-generated content. Review it before relying on it. Fixtures are validated by Centinela's engine in session S7.",
        },
    }


def usage_cost(model: str, input_tokens: int, output_tokens: int, batch: bool) -> float:
    price_in, price_out = PRICES.get(model, PRICES[DEFAULT_MODEL])
    factor = 0.5 if batch else 1.0
    return factor * (input_tokens * price_in + output_tokens * price_out) / 1_000_000


def client():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY is not set. Export it in this terminal (never paste it into a chat or a file in the repo).")
    try:
        import anthropic
    except ImportError:
        sys.exit("The anthropic package is missing. Run: pip install -r tools/content-pack/requirements.txt")
    return anthropic.Anthropic()


# --------------------------------------------------------------------------- commands


def cmd_estimate(args: argparse.Namespace) -> None:
    rules = load_rules(args.rules_dir)
    todo = pending_rules(rules, args.out, args.force)
    measured = load_json(WORK_DIR / "sample-usage.json", None)
    fixed_chars = len(SYSTEM_PROMPT) + len(json.dumps(TOOL)) + 200
    input_tokens = sum((fixed_chars + len(r["text"])) / CHARS_PER_TOKEN for r in todo)
    if measured and measured.get("rules"):
        out_per_rule = measured["output_tokens"] / measured["rules"]
        basis = f"measured by `sample` on {measured['rules']} rules"
    else:
        out_per_rule = DEFAULT_OUTPUT_TOKENS_PER_RULE
        basis = "default guess; run `sample` to measure"
    output_tokens = out_per_rule * len(todo)
    print(f"rules found: {len(rules)}   already done: {len(rules) - len(todo)}   pending: {len(todo)}")
    print(f"model: {args.model}   output tokens per rule: {out_per_rule:,.0f} ({basis})")
    print(f"estimated tokens: {input_tokens:,.0f} input, {output_tokens:,.0f} output")
    print(f"estimated cost: ${usage_cost(args.model, int(input_tokens), int(output_tokens), batch=True):,.2f} with the Batch API "
          f"(${usage_cost(args.model, int(input_tokens), int(output_tokens), batch=False):,.2f} without it)")


def cmd_sample(args: argparse.Namespace) -> None:
    rules = load_rules(args.rules_dir)
    if args.rule:
        chosen = [r for r in rules if r["id"] == args.rule]
        if not chosen:
            sys.exit(f"rule {args.rule} not found")
    else:
        chosen = random.Random(args.seed).sample(rules, k=min(args.n, len(rules)))
    api = client()
    sample_dir = args.out.parent / f"{args.out.name}-sample"
    total_in = total_out = 0
    for rule in chosen:
        print(f"-> {rule['path']} ({rule['title']})")
        # Streaming avoids HTTP timeouts on long generations (thinking + two playbooks).
        with api.messages.stream(**build_params(rule, args.model, args.effort)) as stream:
            message = stream.get_final_message()
        total_in += message.usage.input_tokens
        total_out += message.usage.output_tokens
        data, error = tool_input_from_message(message)
        if error:
            eprint(f"   failed: {error}")
            continue
        atomic_write_json(out_path(sample_dir, rule), record_for(rule, data, args.model))
        print(f"   ok: {message.usage.input_tokens} in / {message.usage.output_tokens} out tokens")
    if chosen:
        atomic_write_json(WORK_DIR / "sample-usage.json",
                          {"rules": len(chosen), "input_tokens": total_in, "output_tokens": total_out, "model": args.model})
    print(f"\nwrote samples to {sample_dir.relative_to(REPO_ROOT)}  (cost: ${usage_cost(args.model, total_in, total_out, batch=False):.3f})")
    print("Open those files and check the playbooks before you run `submit`.")


def in_flight_ids(state: list[dict[str, Any]]) -> set[str]:
    """custom_ids that belong to batches not collected yet (submitting them again would pay twice)."""
    ids: set[str] = set()
    for entry in state:
        if not entry.get("collected"):
            ids.update(entry.get("custom_ids", []))
    return ids


def cmd_submit(args: argparse.Namespace, only_ids: set[str] | None = None) -> None:
    rules = load_rules(args.rules_dir)
    todo = pending_rules(rules, args.out, args.force)
    if only_ids is not None:
        todo = [r for r in todo if r["custom_id"] in only_ids]
    state = load_json(WORK_DIR / "batches.json", [])
    busy = in_flight_ids(state)
    if busy and not args.force:
        skipped = sum(1 for r in todo if r["custom_id"] in busy)
        todo = [r for r in todo if r["custom_id"] not in busy]
        if skipped:
            print(f"skipping {skipped} rules that are in a batch you have not collected yet (run `status` / `collect`)")
    if args.limit:
        todo = todo[: args.limit]
    if not todo:
        print("nothing to submit: every rule already has a file in", args.out, "or is waiting in a batch")
        return
    fixed_chars = len(SYSTEM_PROMPT) + len(json.dumps(TOOL)) + 200
    measured = load_json(WORK_DIR / "sample-usage.json", None)
    out_per_rule = measured["output_tokens"] / measured["rules"] if measured and measured.get("rules") else DEFAULT_OUTPUT_TOKENS_PER_RULE
    est = usage_cost(args.model, int(sum((fixed_chars + len(r["text"])) / CHARS_PER_TOKEN for r in todo)),
                     int(out_per_rule * len(todo)), batch=True)
    print(f"submitting {len(todo)} rules with {args.model}; estimated cost ${est:,.2f}")
    if est > args.max_cost and not args.yes:
        sys.exit(f"estimate exceeds --max-cost {args.max_cost}; re-run with a higher --max-cost or --yes")
    requests = [{"custom_id": r["custom_id"], "params": build_params(r, args.model, args.effort)} for r in todo]
    if args.dry_run:
        WORK_DIR.mkdir(parents=True, exist_ok=True)
        dump = WORK_DIR / "requests.jsonl"
        with dump.open("w", encoding="utf-8") as fh:
            for req in requests:
                fh.write(json.dumps(req, ensure_ascii=False) + "\n")
        print(f"dry run: wrote {len(requests)} requests to {dump}")
        return
    api = client()
    batch = api.messages.batches.create(requests=requests)
    state.append({
        "id": batch.id,
        "model": args.model,
        "count": len(requests),
        "custom_ids": [r["custom_id"] for r in todo],
        "rules_dir": str(args.rules_dir),
        "out": str(args.out),
        "created": dt.datetime.now(dt.timezone.utc).isoformat(),
        "collected": False,
    })
    atomic_write_json(WORK_DIR / "batches.json", state)
    print(f"batch {batch.id} created ({batch.processing_status}). Check it with: python tools/content-pack/content_pack.py status")


def cmd_status(args: argparse.Namespace) -> None:
    state = load_json(WORK_DIR / "batches.json", [])
    if not state:
        print("no batches yet; run `submit`")
        return
    api = client()
    for entry in state:
        batch = api.messages.batches.retrieve(entry["id"])
        c = batch.request_counts
        flag = " (collected)" if entry.get("collected") else ""
        print(f"{entry['id']}: {batch.processing_status}{flag} | processing {c.processing}, succeeded {c.succeeded}, "
              f"errored {c.errored}, canceled {c.canceled}, expired {c.expired} | {entry['count']} requests")


def cmd_collect(args: argparse.Namespace) -> None:
    state = load_json(WORK_DIR / "batches.json", [])
    if not state:
        print("no batches yet; run `submit`")
        return
    api = client()
    failed = load_json(WORK_DIR / "failed.json", {})
    for entry in state:
        if entry.get("collected"):
            continue
        batch = api.messages.batches.retrieve(entry["id"])
        if batch.processing_status != "ended":
            print(f"{entry['id']}: still {batch.processing_status}; try again later")
            continue
        rules = {r["custom_id"]: r for r in load_rules(Path(entry.get("rules_dir", args.rules_dir)))}
        out_dir = Path(entry.get("out", args.out))
        ok = bad = 0
        total_in = total_out = 0
        for result in api.messages.batches.results(entry["id"]):
            cid = result.custom_id
            rule = rules.get(cid)
            if result.result.type != "succeeded":
                detail = getattr(result.result, "error", None)
                failed[cid] = f"{result.result.type}: {detail}" if detail else result.result.type
                bad += 1
                continue
            message = result.result.message
            total_in += message.usage.input_tokens
            total_out += message.usage.output_tokens
            if rule is None:
                failed[cid] = "rule file no longer found"
                bad += 1
                continue
            data, error = tool_input_from_message(message)
            if error:
                failed[cid] = error
                bad += 1
                continue
            atomic_write_json(out_path(out_dir, rule), record_for(rule, data, entry["model"]))
            failed.pop(cid, None)
            ok += 1
        entry["collected"] = True
        entry["usage"] = {"input_tokens": total_in, "output_tokens": total_out,
                          "cost_usd": round(usage_cost(entry["model"], total_in, total_out, batch=True), 2)}
        print(f"{entry['id']}: wrote {ok} files, {bad} failed, cost ${entry['usage']['cost_usd']:.2f}")
    atomic_write_json(WORK_DIR / "batches.json", state)
    atomic_write_json(WORK_DIR / "failed.json", failed)
    if failed:
        print(f"{len(failed)} rules failed; see {WORK_DIR / 'failed.json'} and run `retry`")


def cmd_retry(args: argparse.Namespace) -> None:
    failed = load_json(WORK_DIR / "failed.json", {})
    if not failed:
        print("no failed rules to retry")
        return
    cmd_submit(args, only_ids=set(failed))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rules-dir", type=Path, default=DEFAULT_RULES_DIR, help="folder with Sigma rules (default: rules/sigma)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR, help="output folder (default: content/sigma)")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"model id (default: {DEFAULT_MODEL})")
    parser.add_argument("--force", action="store_true",
                        help="also process rules that already have a file or are waiting in an uncollected batch")
    parser.add_argument("--effort", choices=EFFORT_LEVELS, default=None,
                        help="thinking effort (output_config.effort); omitted = the model's default (medium on Opus 5.5)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("estimate", help="count pending rules and estimate cost")
    p_sample = sub.add_parser("sample", help="generate a few rules now with the normal API")
    p_sample.add_argument("--n", type=int, default=3)
    p_sample.add_argument("--seed", type=int, default=7)
    p_sample.add_argument("--rule", help="a specific rule id")
    for name in ("submit", "retry"):
        p = sub.add_parser(name, help=f"{name} a batch")
        p.add_argument("--limit", type=int, default=0, help="only the first N pending rules")
        p.add_argument("--max-cost", type=float, default=120.0, help="refuse to submit above this estimate (USD)")
        p.add_argument("--yes", action="store_true", help="submit even above --max-cost")
        p.add_argument("--dry-run", action="store_true", help="write the requests to .work/requests.jsonl instead of sending")
    sub.add_parser("status", help="show batch progress")
    sub.add_parser("collect", help="download results and write files")

    args = parser.parse_args(argv)
    args.rules_dir = args.rules_dir.resolve()
    args.out = args.out.resolve()
    commands = {
        "estimate": cmd_estimate,
        "sample": cmd_sample,
        "submit": cmd_submit,
        "status": cmd_status,
        "collect": cmd_collect,
        "retry": cmd_retry,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()

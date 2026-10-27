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
  repair              resubmit fixtures that Centinela's engine rejected
                      (run `npm run content:validate` first; `collect` writes them back)

--origin centinela does the same for Centinela's own rules (rules/centinela/** and
rules/correlation/**, MIT) into content/centinela/; correlation rules get a playbook only.

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
# --origin: SigmaHQ rules (DRL 1.1) or Centinela's own rules (MIT). Centinela's rules are
# read from a rules root (the repository's rules/) with these folders, as the engine does.
ORIGINS = ("sigmahq", "centinela")
CENTINELA_RULE_FOLDERS = ("centinela", "correlation")
DEFAULT_DIRS = {
    "sigmahq": (DEFAULT_RULES_DIR, DEFAULT_OUT_DIR),
    "centinela": (REPO_ROOT / "rules", REPO_ROOT / "content" / "centinela"),
}
WORK_DIR = Path(__file__).resolve().parent / ".work"
# Written by `npm run content:validate` (Centinela's engine) next to the content folder as
# <out>-failures.json (content/sigma-failures.json by default); read by `repair`.
FAILURES_FORMAT = "centinela-content-failures/1"
DEFAULT_MODEL = "claude-opus-5-5"
# Opus 5.5 and Sonnet 5.5 always think before answering (adaptive thinking), and thinking
# tokens count toward max_tokens and are billed as output, so leave plenty of room.
MAX_TOKENS = 16000
TOOL_NAME = "save_content_pack"
# Correlation rules get a playbook only: a correlation cannot be tested with single events.
PLAYBOOK_TOOL_NAME = "save_playbook"
REPAIR_TOOL_NAME = "save_fixtures"
# Repairs answer with a few fixtures only, but the model still thinks first.
REPAIR_OUTPUT_TOKENS_PER_RULE = 3000
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

# Shared by the generation prompt and the repair prompt, so both describe the same semantics.
PLAYBOOK_GUIDE = """You are a senior detection engineer and SOC lead. You write investigation playbooks and test fixtures for the detection rules of Centinela, an open-source SIEM. Analysts read a playbook while triaging an alert from that rule, so it must be specific to the rule, accurate and actionable.

Ground rules
- Base everything on the rule YAML you receive. Do not invent threat-actor attributions, CVE numbers, statistics or vendor claims. If the rule names a tool or technique, describe it factually and briefly.
- Triage steps are concrete and ordered. Refer to the fields the rule actually uses (for example CommandLine, ParentImage, cs-uri-query, the source IP or the user) and to useful pivots: the same host within +/- 15 minutes, the same user, the same source IP, parent and child processes, earlier alerts for the same entity.
- False positives are realistic legitimate causes; start from the rule's falsepositives field.
- Response steps are proportionate: verify, contain, eradicate, recover. Never recommend destructive actions without verification.
- Spanish: neutral Latin American Spanish, professional tone, no voseo. Keep usual SOC terms in English when that is what analysts say (user agent, hash, payload, endpoint).
- English: concise and plain.
- Length per language: summary at most 2 sentences; each list item at most 30 words; about 350 words in total."""

FIXTURE_GUIDE = """Fixtures
- Each event is a flat JSON object that uses exactly the Sigma field names the rule uses (for example "Image", "CommandLine", "cs-uri-query", "cs-user-agent"). Add a few other realistic fields of that log source when it helps.
- For rules whose detection is a plain list of strings (keywords), put the complete raw log line in a "message" field, written the way that log source really writes it (for Linux, a syslog line such as "Oct 25 14:03:12 bastion-01 sudo: ..."). A keyword only matches when it appears verbatim and in one piece in that line, so pick a format that records the whole command line contiguously (for example a shell history line or a sudo COMMAND= line), never auditd EXECVE records, which split the arguments into a0, a1 and so on.
- Positive events MUST satisfy the rule's condition under Sigma semantics: string matching is case-insensitive; '*' is a wildcard; contains / startswith / endswith wrap the value with wildcards; |all requires every listed value; |windash means an option dash may also be '/', '–', '—' or '―'; |re is a regular expression (case-sensitive unless |i); |base64offset|contains means the value appears base64-encoded at any offset; |fieldref compares two fields; filters joined with 'and not' must NOT match; '1 of selection_*' needs one of those selections, 'all of' needs all of them.
- Negative events are realistic near-misses that must NOT match, for example the same binary used legitimately so that a filter excludes it, or a value that only partly matches.
- Use safe placeholder data: documentation IP ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), example.com or example.org domains, fictitious users and hosts (for example ANDES\\jperez, WS-0142, bastion-01). Do not include working exploit payloads beyond the literal strings the rule needs in order to match."""

SYSTEM_PROMPT = f"""{PLAYBOOK_GUIDE}

{FIXTURE_GUIDE}

Always answer by calling the {TOOL_NAME} tool exactly once."""


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


PLAYBOOK_TOOL = {
    "name": PLAYBOOK_TOOL_NAME,
    "description": "Save the bilingual playbook for one correlation rule (no fixtures).",
    "input_schema": {
        "type": "object",
        "properties": {"es": playbook_schema(), "en": playbook_schema()},
        "required": ["es", "en"],
    },
}

CORRELATION_GUIDE = """Correlation rules
- This rule is a correlation: it does not match single events. It fires when the rules it references match in the pattern it declares, per group of group-by values (for example per source IP) within the timespan: event_count needs at least the threshold of matches, value_count at least that many distinct values of a field, temporal every referenced rule in any order and temporal_ordered every referenced rule in the listed order. A referenced rule may itself be a correlation (chaining). The referenced rules are given after the correlation.
- The alert carries the group-by values and links the contributing events (at most 100). Start the triage steps from them: review the contributing events in order, the entity of the group, what happened right before and after.
- Write the playbook only. Do not write test fixtures: a correlation cannot be tested with single events."""

CORRELATION_SYSTEM_PROMPT = f"""{PLAYBOOK_GUIDE}

{CORRELATION_GUIDE}

Always answer by calling the {PLAYBOOK_TOOL_NAME} tool exactly once."""

CENTINELA_FIELDS_NOTE = (
    "Field names: Centinela's normalized event fields, as the rule writes them (ECS-style keys such as "
    "event.action, event.outcome, source.ip, user.name and host.name for Linux and web events; "
    "Sigma names such as Image, CommandLine or TargetFilename for Windows Sysmon events)."
)


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


def read_rule(path: Path, rel: str, rule_keys: tuple[str, ...]) -> tuple[dict[str, Any], str] | None:
    """Parse one rule file: (document, text), or None (with a message) when it is not usable."""
    text = path.read_text(encoding="utf-8")
    try:
        docs = list(yaml.safe_load_all(text))
    except yaml.YAMLError as exc:
        eprint(f"skip {rel}: invalid YAML ({exc.__class__.__name__})")
        return None
    if len(docs) != 1 or not isinstance(docs[0], dict):
        eprint(f"skip {rel}: expected one YAML document")
        return None
    doc = docs[0]
    if not str(doc.get("id", "")) or "title" not in doc or not any(k in doc for k in rule_keys):
        eprint(f"skip {rel}: missing id, title or {' or '.join(rule_keys)}")
        return None
    if str(doc.get("status", "")).lower() in {"deprecated", "unsupported"}:
        return None
    return doc, text


def rule_record(doc: dict[str, Any], text: str, rel: str, url: str | None, license_id: str) -> dict[str, Any]:
    rid = str(doc.get("id", ""))
    techniques = sorted(
        {m.group(1).upper() for t in doc.get("tags") or [] if (m := TECHNIQUE_RE.match(str(t)))}
    )
    return {
        "id": rid,
        "custom_id": rid if ID_RE.match(rid) else re.sub(r"[^A-Za-z0-9_-]", "_", rid)[:64],
        "title": str(doc.get("title")),
        "level": doc.get("level"),
        "status": doc.get("status"),
        "author": doc.get("author"),
        "path": rel,
        "url": url,
        "license": license_id,
        "techniques": techniques,
        "text": text,
    }


def load_rules(rules_dir: Path, origin: str = "sigmahq") -> list[dict[str, Any]]:
    """Return rule records sorted by path. Skips regression data, deprecated and broken files.

    sigmahq: every rule below `rules_dir` (a Sigma rules folder), DRL 1.1 with its SigmaHQ link.
    centinela: `rules_dir/centinela/**` and `rules_dir/correlation/**` (a rules root), MIT, with
    the author from the rule and its own `url` if it has one (Centinela's rules link nowhere
    else); correlation rules are marked `kind: correlation` and get a playbook only.
    """
    if origin == "centinela":
        return load_centinela_rules(rules_dir)
    commit = sigma_commit(rules_dir)
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in sorted(rules_dir.rglob("*.yml")):
        rel = path.relative_to(rules_dir).as_posix()
        if rel.startswith("regression/"):
            continue
        parsed = read_rule(path, rel, ("detection",))
        if parsed is None:
            continue
        doc, text = parsed
        rid = str(doc.get("id", ""))
        if rid in seen:
            eprint(f"skip {rel}: duplicate id {rid}")
            continue
        seen.add(rid)
        records.append({**rule_record(doc, text, rel, rule_url(rel, commit), "DRL-1.1"),
                        "origin": "sigmahq", "kind": "detection"})
    return records


def load_centinela_rules(rules_dir: Path) -> list[dict[str, Any]]:
    folders = [rules_dir / name for name in CENTINELA_RULE_FOLDERS if (rules_dir / name).is_dir()]
    if not folders:
        sys.exit(f"{rules_dir} has no {' or '.join(CENTINELA_RULE_FOLDERS)} folder; "
                 "with --origin centinela, --rules-dir is the rules root (default: rules/)")
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in sorted(p for folder in folders for p in folder.rglob("*.yml")):
        rel = path.relative_to(rules_dir).as_posix()
        parsed = read_rule(path, rel, ("detection", "correlation"))
        if parsed is None:
            continue
        doc, text = parsed
        rid = str(doc.get("id", ""))
        if rid in seen:
            eprint(f"skip {rel}: duplicate id {rid}")
            continue
        seen.add(rid)
        own_url = doc.get("url") if isinstance(doc.get("url"), str) else None
        records.append({
            **rule_record(doc, text, rel, own_url, "MIT"),
            "origin": "centinela",
            "kind": "correlation" if "correlation" in doc else "detection",
            "name": doc.get("name") if isinstance(doc.get("name"), str) else None,
            "references": correlation_refs(doc),
        })
    return records


def correlation_refs(doc: dict[str, Any]) -> list[str]:
    """Rule names or ids a correlation references (empty for other rules)."""
    block = doc.get("correlation")
    refs = block.get("rules") if isinstance(block, dict) else None
    if isinstance(refs, str):
        return [refs]
    return [str(r) for r in refs] if isinstance(refs, list) else []


def out_path(out_dir: Path, rule: dict[str, Any]) -> Path:
    return out_dir / f"{rule['custom_id']}.json"


def pending_rules(rules: list[dict[str, Any]], out_dir: Path, force: bool) -> list[dict[str, Any]]:
    return [r for r in rules if force or not out_path(out_dir, r).exists()]


def origin_line(rule: dict[str, Any]) -> str:
    if rule.get("origin") == "centinela":
        return "Origin: Centinela (this project's own rule), MIT License"
    return "Origin: SigmaHQ, Detection Rule License 1.1"


def user_prompt(rule: dict[str, Any]) -> str:
    note = f"{CENTINELA_FIELDS_NOTE}\n" if rule.get("origin") == "centinela" else ""
    return (
        f"Rule file: {rule['path']}\n"
        f"{origin_line(rule)}\n{note}\n"
        f"```yaml\n{rule['text'].strip()}\n```\n\n"
        "Write the Spanish and English playbooks and the fixtures for this rule, "
        f"then deliver them by calling {TOOL_NAME} exactly once. Do not reply in plain text."
    )


def referenced_rules(rule: dict[str, Any], rules: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Rules a correlation references, followed through chained correlations: (found, missing)."""
    by_ref: dict[str, dict[str, Any]] = {}
    for r in rules:
        by_ref[r["id"].lower()] = r
        if r.get("name"):
            by_ref.setdefault(r["name"], r)
    found: list[dict[str, Any]] = []
    missing: list[str] = []
    seen = {rule["id"].lower()}
    queue = list(rule.get("references") or [])
    while queue:
        ref = queue.pop(0)
        target = by_ref.get(ref) or by_ref.get(ref.lower())
        if target is None:
            if ref not in missing:
                missing.append(ref)
            continue
        if target["id"].lower() in seen:
            continue
        seen.add(target["id"].lower())
        found.append(target)
        queue.extend(target.get("references") or [])
    return found, missing


def correlation_prompt(rule: dict[str, Any], rules: list[dict[str, Any]]) -> str:
    found, missing = referenced_rules(rule, rules)
    parts = [
        f"Rule file: {rule['path']}",
        origin_line(rule),
        "Kind: correlation rule (playbook only, no fixtures)",
        "",
        f"```yaml\n{rule['text'].strip()}\n```",
        "",
        "Rules it references (directly or through chained correlations):",
    ]
    for ref in found:
        parts += ["", f"Rule file: {ref['path']}", f"```yaml\n{ref['text'].strip()}\n```"]
    if not found:
        parts.append("(none found)")
    if missing:
        parts += ["", f"References not found among the loaded rules: {', '.join(missing)}"]
    parts += [
        "",
        "Write the Spanish and English playbooks for the correlation rule (not for the rules it references), "
        f"then deliver them by calling {PLAYBOOK_TOOL_NAME} exactly once. Do not write fixtures and do not "
        "reply in plain text.",
    ]
    return "\n".join(parts)


def is_correlation(rule: dict[str, Any]) -> bool:
    return rule.get("kind") == "correlation"


def build_params(rule: dict[str, Any], model: str, effort: str | None = None,
                 rules: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Request for one rule. Correlations (playbook only) get the referenced rules from `rules` as context."""
    # Opus 5.5, Sonnet 5.5 and the Fable/Mythos models reject forced tool use
    # (tool_choice "tool" or "any" returns HTTP 400), so the tool is offered with "auto"
    # and the prompt requires the call; responses without it are caught by
    # tool_input_from_message and can be resubmitted with `retry`.
    params: dict[str, Any] = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": CORRELATION_SYSTEM_PROMPT if is_correlation(rule) else SYSTEM_PROMPT,
        "tools": [PLAYBOOK_TOOL if is_correlation(rule) else TOOL],
        "tool_choice": {"type": "auto"},
        "messages": [{"role": "user", "content": correlation_prompt(rule, rules or []) if is_correlation(rule)
                      else user_prompt(rule)}],
    }
    if effort:
        params["output_config"] = {"effort": effort}
    return params


def validate_tool_input(data: Any, playbook_only: bool = False) -> str | None:
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
    if playbook_only:
        return None
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


def tool_input_from_message(message: Any, playbook_only: bool = False) -> tuple[dict[str, Any] | None, str | None]:
    if getattr(message, "stop_reason", None) == "max_tokens":
        return None, "output truncated (max_tokens)"
    name = PLAYBOOK_TOOL_NAME if playbook_only else TOOL_NAME
    for block in getattr(message, "content", []) or []:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == name:
            data = block.input
            error = validate_tool_input(data, playbook_only)
            return (None, error) if error else (data, None)
    return None, f"no {name} tool call in the response"


def record_for(rule: dict[str, Any], data: dict[str, Any], model: str) -> dict[str, Any]:
    """The content file. Correlation rules have no `fixtures` key (playbook only)."""
    record: dict[str, Any] = {
        "rule": {k: rule[k] for k in ("id", "title", "level", "status", "author", "path", "url", "license", "techniques")},
        "playbook": {"es": data["es"], "en": data["en"]},
    }
    if not is_correlation(rule):
        record["fixtures"] = data["fixtures"]
    notice = ("AI-generated content. Review it before relying on it." if is_correlation(rule) else
              "AI-generated content. Review it before relying on it. Fixtures are validated by Centinela's engine in session S7.")
    record["generated"] = {
        "tool": TOOL_VERSION,
        "model": model,
        "at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "review": "unreviewed",
        "notice": notice,
    }
    return record


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


# --------------------------------------------------------------------------- repair
#
# `npm run content:validate` evaluates every fixture with Centinela's engine and writes a
# failures file: rule id, fixture kind and index, the event and the engine's reason. `repair`
# sends one request per failing rule (the rule YAML, its fixtures and those reasons) asking
# for corrected fixtures only; `collect` writes them back into the same content files, in
# place of the failing fixtures. Playbooks and passing fixtures are never touched.

REPAIR_SYSTEM_PROMPT = f"""You are a senior detection engineer. You fix the test fixtures of a Sigma rule for Centinela, an open-source SIEM. Centinela's engine evaluated the fixtures against the rule and rejected some of them: a positive fixture that the rule does not match, or a negative fixture that the rule matches. You receive the rule YAML, every fixture with its result, and the engine's reason for each rejected one.

How Centinela evaluates a fixture
- The event is evaluated directly against the rule's detection; the logsource is not checked.
- Field names are case-sensitive and must be spelled exactly as in the rule. A field missing from the event never matches a value.
- A value without wildcards and without contains/startswith/endswith must equal the whole field value (case-insensitive).
- Values are taken literally: a backslash-escaped quote inside a JSON string is a backslash followed by a quote, so write the text exactly as the process would log it.
- Keyword lists (plain strings in the detection) are searched in the event's "message" field, or in the event's JSON text when it has no "message".

{FIXTURE_GUIDE}

Write a replacement for every rejected fixture: same kind, same index, a realistic event that now satisfies (positive) or fails (negative) the rule's condition, and a one-sentence description. Do not return fixtures that passed, and do not write a playbook. If no event can satisfy the rule as it is written (for example an exact value that contradicts another selection), do not invent one: list that fixture under "unfixable" with the reason.

Always answer by calling the {REPAIR_TOOL_NAME} tool exactly once."""

REPAIR_TOOL = {
    "name": REPAIR_TOOL_NAME,
    "description": "Save corrected replacements for the rejected fixtures of one Sigma rule.",
    "input_schema": {
        "type": "object",
        "properties": {
            "fixtures": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": ["positive", "negative"]},
                        "index": {"type": "integer", "minimum": 0},
                        "description": {"type": "string"},
                        "event": {
                            "type": "object",
                            "additionalProperties": {"type": ["string", "number", "boolean", "null"]},
                        },
                    },
                    "required": ["kind", "index", "description", "event"],
                },
            },
            "unfixable": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": ["positive", "negative"]},
                        "index": {"type": "integer", "minimum": 0},
                        "reason": {"type": "string"},
                    },
                    "required": ["kind", "index", "reason"],
                },
            },
        },
        "required": ["fixtures"],
    },
}

FIXTURE_KINDS = ("positive", "negative")


def load_failures(path: Path) -> dict[str, Any]:
    """Read and check the failures file written by `npm run content:validate`."""
    if not path.exists():
        sys.exit(f"{path} not found. Run `npm run content:validate` first (it writes the failures file).")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("format") != FAILURES_FORMAT or not isinstance(data.get("failures"), list):
        sys.exit(f"{path} is not a failures file from `npm run content:validate` ({FAILURES_FORMAT})")
    return data


def failures_by_rule(failures: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Failing fixtures grouped by rule id (lower-cased), in file order."""
    grouped: dict[str, list[dict[str, Any]]] = {}
    for failure in failures["failures"]:
        if not isinstance(failure, dict) or failure.get("kind") not in FIXTURE_KINDS:
            continue
        if not isinstance(failure.get("index"), int) or not isinstance(failure.get("event"), dict):
            continue
        grouped.setdefault(str(failure.get("ruleId", "")).lower(), []).append(failure)
    return grouped


def current_fixture(content: dict[str, Any], kind: str, index: int) -> dict[str, Any] | None:
    items = (content.get("fixtures") or {}).get(kind)
    if not isinstance(items, list) or not 0 <= index < len(items) or not isinstance(items[index], dict):
        return None
    return items[index]


def still_failing(content: dict[str, Any], failure: dict[str, Any]) -> bool:
    """True when the content file still holds the fixture the engine rejected (not repaired yet)."""
    fixture = current_fixture(content, failure["kind"], failure["index"])
    return fixture is not None and fixture.get("event") == failure["event"]


def repair_prompt(rule: dict[str, Any], content: dict[str, Any], failures: list[dict[str, Any]]) -> str:
    rejected = {(f["kind"], f["index"]): f.get("reason", "") for f in failures}
    listing = []
    for kind in FIXTURE_KINDS:
        for index, fixture in enumerate((content.get("fixtures") or {}).get(kind) or []):
            status = "REJECTED" if (kind, index) in rejected else "passed"
            listing.append({"kind": kind, "index": index, "status": status,
                            "description": fixture.get("description", ""), "event": fixture.get("event", {})})
    reasons = "\n".join(f"- {kind} #{index}: {reason}" for (kind, index), reason in rejected.items())
    return (
        f"Rule file: {rule['path']}\n"
        f"{origin_line(rule)}\n\n"
        f"```yaml\n{rule['text'].strip()}\n```\n\n"
        "Current fixtures:\n\n"
        f"```json\n{json.dumps(listing, ensure_ascii=False, indent=2)}\n```\n\n"
        f"Centinela's engine rejected these fixtures:\n{reasons}\n\n"
        f"Write a corrected replacement for each rejected fixture (same kind and index), "
        f"then deliver them by calling {REPAIR_TOOL_NAME} exactly once. Do not reply in plain text."
    )


def build_repair_params(rule: dict[str, Any], content: dict[str, Any], failures: list[dict[str, Any]],
                        model: str, effort: str | None = None) -> dict[str, Any]:
    # Same constraints as build_params: forced tool use is rejected by these models.
    params: dict[str, Any] = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": REPAIR_SYSTEM_PROMPT,
        "tools": [REPAIR_TOOL],
        "tool_choice": {"type": "auto"},
        "messages": [{"role": "user", "content": repair_prompt(rule, content, failures)}],
    }
    if effort:
        params["output_config"] = {"effort": effort}
    return params


def plan_repairs(failures: dict[str, Any], rules: list[dict[str, Any]], out_dir: Path
                 ) -> tuple[list[dict[str, Any]], list[tuple[str, str]]]:
    """One job per rule that still has rejected fixtures: (jobs, skipped as (rule id, reason))."""
    by_id = {r["id"].lower(): r for r in rules}
    unsupported = {str(u.get("ruleId", "")).lower() for u in failures.get("unsupported") or [] if isinstance(u, dict)}
    jobs: list[dict[str, Any]] = []
    skipped: list[tuple[str, str]] = []
    for rule_id, items in sorted(failures_by_rule(failures).items()):
        rule = by_id.get(rule_id)
        if rule is None:
            skipped.append((rule_id, "rule not found in --rules-dir"))
            continue
        if rule_id in unsupported:
            skipped.append((rule_id, "the engine does not support this rule"))
            continue
        path = out_path(out_dir, rule)
        if not path.exists():
            skipped.append((rule_id, f"no content file {path.name} in --out"))
            continue
        content = json.loads(path.read_text(encoding="utf-8"))
        pending = [f for f in items if still_failing(content, f)]
        if not pending:
            skipped.append((rule_id, "fixtures changed since validation (already repaired?); run `npm run content:validate`"))
            continue
        jobs.append({"rule": rule, "content": content, "failures": pending})
    return jobs, skipped


def repair_input_from_message(message: Any) -> tuple[dict[str, Any] | None, str | None]:
    stop_reason = getattr(message, "stop_reason", None)
    if stop_reason == "max_tokens":
        return None, "output truncated (max_tokens)"
    for block in getattr(message, "content", []) or []:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == REPAIR_TOOL_NAME:
            data = block.input
            if not isinstance(data, dict) or not isinstance(data.get("fixtures"), list):
                return None, "tool input has no fixtures list"
            if not data["fixtures"] and not data.get("unfixable"):
                return None, "tool input has neither fixtures nor unfixable entries"
            return data, None
    return None, f"no {REPAIR_TOOL_NAME} tool call in the response (stop_reason: {stop_reason})"


def scalar_event(event: Any) -> bool:
    return (isinstance(event, dict) and bool(event)
            and all(isinstance(k, str) and (v is None or isinstance(v, (str, int, float, bool))) for k, v in event.items()))


def merge_repair(content: dict[str, Any], failures: list[dict[str, Any]], answer: dict[str, Any],
                 model: str, at: str) -> tuple[dict[str, Any], list[str], list[str]]:
    """Replace each rejected fixture with the model's correction.

    Returns (updated content, applied "kind/index" labels, problems). A fixture is only
    replaced when the content file still holds the event the engine rejected, so a file
    edited since the validation run is never overwritten. Answers for fixtures that were
    not rejected are ignored. The input is not modified.
    """
    updated = json.loads(json.dumps(content))
    answers: dict[tuple[str, int], dict[str, Any]] = {}
    problems: list[str] = []
    for item in answer.get("fixtures") or []:
        if isinstance(item, dict) and item.get("kind") in FIXTURE_KINDS and isinstance(item.get("index"), int):
            answers.setdefault((item["kind"], item["index"]), item)
    unfixable: dict[tuple[str, int], str] = {}
    for item in answer.get("unfixable") or []:
        if isinstance(item, dict) and item.get("kind") in FIXTURE_KINDS and isinstance(item.get("index"), int):
            unfixable.setdefault((item["kind"], item["index"]), str(item.get("reason", "")))
    wanted = {(f["kind"], f["index"]) for f in failures}
    for key in sorted(set(answers) - wanted):
        problems.append(f"ignored {key[0]}/{key[1]}: it was not rejected")
    applied: list[str] = []
    for failure in failures:
        key = (failure["kind"], failure["index"])
        label = f"{key[0]}/{key[1]}"
        replacement = answers.get(key)
        if replacement is None:
            if key in unfixable:
                problems.append(f"unfixable {label}: {unfixable[key]}")
            else:
                problems.append(f"no replacement for {label}")
            continue
        if not scalar_event(replacement.get("event")):
            problems.append(f"invalid event for {label}")
            continue
        if not still_failing(updated, failure):
            problems.append(f"{label} changed since validation; left as it is")
            continue
        updated["fixtures"][key[0]][key[1]] = {
            "description": str(replacement.get("description", "")),
            "event": replacement["event"],
        }
        applied.append(label)
    if applied:
        generated = updated.setdefault("generated", {})
        generated.setdefault("repairs", []).append(
            {"tool": TOOL_VERSION, "model": model, "at": at, "fixtures": applied})
    return updated, applied, problems


# --------------------------------------------------------------------------- commands


def cmd_estimate(args: argparse.Namespace) -> None:
    rules = load_rules(args.rules_dir, args.origin)
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
    rules = load_rules(args.rules_dir, args.origin)
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
        with api.messages.stream(**build_params(rule, args.model, args.effort, rules)) as stream:
            message = stream.get_final_message()
        total_in += message.usage.input_tokens
        total_out += message.usage.output_tokens
        data, error = tool_input_from_message(message, is_correlation(rule))
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
    rules = load_rules(args.rules_dir, args.origin)
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
    requests = [{"custom_id": r["custom_id"], "params": build_params(r, args.model, args.effort, rules)} for r in todo]
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
        "origin": args.origin,
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


def collect_generation(api: Any, entry: dict[str, Any], args: argparse.Namespace, failed: dict[str, Any]) -> None:
    rules = {r["custom_id"]: r for r in load_rules(Path(entry.get("rules_dir", args.rules_dir)),
                                                   entry.get("origin", "sigmahq"))}
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
        data, error = tool_input_from_message(message, is_correlation(rule))
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


def collect_repair(api: Any, entry: dict[str, Any], repair_failed: dict[str, Any]) -> None:
    """Merge the corrected fixtures of a repair batch into the content files."""
    out_dir = Path(entry["out"])
    at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    ok = bad = fixtures = 0
    total_in = total_out = 0
    for result in api.messages.batches.results(entry["id"]):
        cid = result.custom_id
        failures = (entry.get("fixtures") or {}).get(cid)
        if result.result.type != "succeeded":
            detail = getattr(result.result, "error", None)
            repair_failed[cid] = {"error": f"{result.result.type}: {detail}" if detail else result.result.type,
                                  "stop_reason": None}
            bad += 1
            continue
        message = result.result.message
        total_in += message.usage.input_tokens
        total_out += message.usage.output_tokens
        stop_reason = getattr(message, "stop_reason", None)
        data, error = repair_input_from_message(message)
        path = out_dir / f"{cid}.json"
        if error is None and (failures is None or not path.exists()):
            error = "content file or batch record no longer found"
        if error is not None:
            repair_failed[cid] = {"error": error, "stop_reason": stop_reason}
            bad += 1
            continue
        content = json.loads(path.read_text(encoding="utf-8"))
        updated, applied, problems = merge_repair(content, failures, data, entry["model"], at)
        if applied:
            atomic_write_json(path, updated)
            fixtures += len(applied)
        if problems:
            repair_failed[cid] = {"error": "; ".join(problems), "stop_reason": stop_reason, "applied": applied}
            bad += 1
        else:
            repair_failed.pop(cid, None)
            ok += 1
    entry["collected"] = True
    entry["usage"] = {"input_tokens": total_in, "output_tokens": total_out,
                      "cost_usd": round(usage_cost(entry["model"], total_in, total_out, batch=True), 2)}
    print(f"{entry['id']} (repair): replaced {fixtures} fixtures in {ok + bad} rules, {bad} with problems, "
          f"cost ${entry['usage']['cost_usd']:.2f}")


def cmd_collect(args: argparse.Namespace) -> None:
    state = load_json(WORK_DIR / "batches.json", [])
    if not state:
        print("no batches yet; run `submit`")
        return
    api = client()
    failed = load_json(WORK_DIR / "failed.json", {})
    repair_failed = load_json(WORK_DIR / "repair-failed.json", {})
    repaired = False
    for entry in state:
        if entry.get("collected"):
            continue
        batch = api.messages.batches.retrieve(entry["id"])
        if batch.processing_status != "ended":
            print(f"{entry['id']}: still {batch.processing_status}; try again later")
            continue
        if entry.get("kind") == "repair":
            collect_repair(api, entry, repair_failed)
            repaired = True
        else:
            collect_generation(api, entry, args, failed)
    atomic_write_json(WORK_DIR / "batches.json", state)
    atomic_write_json(WORK_DIR / "failed.json", failed)
    atomic_write_json(WORK_DIR / "repair-failed.json", repair_failed)
    if failed:
        print(f"{len(failed)} rules failed; see {WORK_DIR / 'failed.json'} and run `retry`")
    if repair_failed:
        print(f"{len(repair_failed)} repairs failed or were partial; see {WORK_DIR / 'repair-failed.json'}")
    if repaired:
        print("Re-run `npm run content:validate` to check the repaired fixtures and refresh the failures file.")


def cmd_retry(args: argparse.Namespace) -> None:
    failed = load_json(WORK_DIR / "failed.json", {})
    if not failed:
        print("no failed rules to retry")
        return
    cmd_submit(args, only_ids=set(failed))


def cmd_repair(args: argparse.Namespace) -> None:
    failures = load_failures(args.failures)
    rules = load_rules(args.rules_dir, args.origin)
    jobs, skipped = plan_repairs(failures, rules, args.out)
    for rule_id, reason in skipped:
        print(f"skip {rule_id}: {reason}")
    state = load_json(WORK_DIR / "batches.json", [])
    busy = in_flight_ids(state)
    if busy and not args.force:
        waiting = [j for j in jobs if j["rule"]["custom_id"] in busy]
        jobs = [j for j in jobs if j["rule"]["custom_id"] not in busy]
        if waiting:
            print(f"skipping {len(waiting)} rules that are in a batch you have not collected yet (run `status` / `collect`)")
    if args.limit:
        jobs = jobs[: args.limit]
    if not jobs:
        print("nothing to repair: no rule in", args.failures, "has rejected fixtures left to send")
        return
    requests = [{"custom_id": j["rule"]["custom_id"],
                 "params": build_repair_params(j["rule"], j["content"], j["failures"], args.model, args.effort)}
                for j in jobs]
    input_chars = sum(len(r["params"]["system"]) + len(json.dumps(REPAIR_TOOL)) + len(r["params"]["messages"][0]["content"])
                      for r in requests)
    est = usage_cost(args.model, int(input_chars / CHARS_PER_TOKEN), REPAIR_OUTPUT_TOKENS_PER_RULE * len(requests), batch=True)
    count = sum(len(j["failures"]) for j in jobs)
    print(f"repairing {count} fixtures of {len(jobs)} rules with {args.model}; estimated cost ${est:,.2f}")
    if est > args.max_cost and not args.yes:
        sys.exit(f"estimate exceeds --max-cost {args.max_cost}; re-run with a higher --max-cost or --yes")
    if args.dry_run:
        WORK_DIR.mkdir(parents=True, exist_ok=True)
        dump = WORK_DIR / "repair-requests.jsonl"
        with dump.open("w", encoding="utf-8") as fh:
            for req in requests:
                fh.write(json.dumps(req, ensure_ascii=False) + "\n")
        print(f"dry run: wrote {len(requests)} requests to {dump}")
        return
    api = client()
    batch = api.messages.batches.create(requests=requests)
    state.append({
        "id": batch.id,
        "kind": "repair",
        "model": args.model,
        "count": len(requests),
        "custom_ids": [j["rule"]["custom_id"] for j in jobs],
        # The rejected fixtures as validated: collect only replaces fixtures that still match them.
        "fixtures": {j["rule"]["custom_id"]: j["failures"] for j in jobs},
        "rules_dir": str(args.rules_dir),
        "out": str(args.out),
        "failures": str(args.failures),
        "created": dt.datetime.now(dt.timezone.utc).isoformat(),
        "collected": False,
    })
    atomic_write_json(WORK_DIR / "batches.json", state)
    print(f"batch {batch.id} created ({batch.processing_status}). Check it with: python tools/content-pack/content_pack.py status")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--origin", choices=ORIGINS, default="sigmahq",
                        help="sigmahq: SigmaHQ rules (DRL 1.1); centinela: Centinela's own rules (MIT), "
                             "correlations get a playbook only (default: sigmahq)")
    parser.add_argument("--rules-dir", type=Path, default=None,
                        help="folder with Sigma rules (default: rules/sigma); with --origin centinela, the rules "
                             "root holding centinela/ and correlation/ (default: rules)")
    parser.add_argument("--out", type=Path, default=None,
                        help="output folder (default: content/sigma; content/centinela with --origin centinela)")
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
    p_repair = sub.add_parser("repair", help="send rejected fixtures back for correction (after npm run content:validate)")
    p_repair.add_argument("--failures", type=Path, default=None,
                          help="failures file from npm run content:validate (default: <out>-failures.json, "
                               "e.g. content/sigma-failures.json)")
    p_repair.add_argument("--limit", type=int, default=0, help="only the first N rules")
    p_repair.add_argument("--max-cost", type=float, default=20.0, help="refuse to submit above this estimate (USD)")
    p_repair.add_argument("--yes", action="store_true", help="submit even above --max-cost")
    p_repair.add_argument("--dry-run", action="store_true", help="write the requests to .work/repair-requests.jsonl instead of sending")
    sub.add_parser("status", help="show batch progress")
    sub.add_parser("collect", help="download results and write files")

    args = parser.parse_args(argv)
    default_rules, default_out = DEFAULT_DIRS[args.origin]
    args.rules_dir = (args.rules_dir or default_rules).resolve()
    args.out = (args.out or default_out).resolve()
    if args.command == "repair":
        # Written by content:validate next to the content folder.
        args.failures = (args.failures or args.out.parent / f"{args.out.name}-failures.json").resolve()
    commands = {
        "estimate": cmd_estimate,
        "sample": cmd_sample,
        "submit": cmd_submit,
        "status": cmd_status,
        "collect": cmd_collect,
        "retry": cmd_retry,
        "repair": cmd_repair,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()

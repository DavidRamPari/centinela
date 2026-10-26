# Content pack generator

Generates, for every rule in `rules/sigma/`, a bilingual investigation playbook (Spanish and English) and test fixtures (events that must match the rule and near-miss events that must not), using the Claude Message Batches API. Output: one JSON file per rule in `content/sigma/<rule-id>.json`. Session S7 shows the playbooks in the dashboard and validates the fixtures with Centinela's engine.

This tool runs on your machine with your API key. It is not part of the npm build, and cloud sessions do not run it.

## Setup (WSL or Linux, from the repo root)

```bash
sudo apt install -y python3-venv   # Ubuntu needs it to create virtual environments
python3 -m venv .venv
source .venv/bin/activate
pip install -r tools/content-pack/requirements.txt
export ANTHROPIC_API_KEY=...   # a key from the Claude Console organization that holds your API credits
```

Never commit the key or paste it into a chat.

## Run

```bash
python tools/content-pack/content_pack.py estimate      # pending rules and estimated cost
python tools/content-pack/content_pack.py sample --n 3  # 3 rules right away, written to content/sigma-sample/
python tools/content-pack/content_pack.py submit        # one batch with every pending rule
python tools/content-pack/content_pack.py status        # progress
python tools/content-pack/content_pack.py collect       # write content/sigma/*.json when the batch has ended
python tools/content-pack/content_pack.py retry         # resubmit failed rules, then collect again
```

## Repair fixtures that Centinela's engine rejects

Session S7 added `npm run content:validate`, which evaluates every fixture with Centinela's engine and writes `content/sigma-failures.json` (rule id, fixture kind and index, the event and the engine's reason, for example which selection or item failed). `repair` sends those fixtures back for correction:

```bash
npm run content:validate                                   # writes content/sigma-failures.json and docs/content-pack-report.md
python tools/content-pack/content_pack.py repair --dry-run # inspect .work/repair-requests.jsonl and the estimate
python tools/content-pack/content_pack.py repair           # one batch: one request per failing rule
python tools/content-pack/content_pack.py status
python tools/content-pack/content_pack.py collect          # writes the corrected fixtures into the same files
npm run content:validate                                   # check them and refresh the failures file, then commit
```

- Each request carries the rule YAML, all of the rule's fixtures (marked `passed` or `REJECTED`) and the engine's reasons, and asks for replacements of the rejected fixtures only (tool `save_fixtures`). Playbooks and passing fixtures are never sent back or changed.
- `collect` replaces a fixture only if the content file still holds the event the engine rejected, so files edited in the meantime are left alone. Each repaired file records the repair under `generated.repairs`.
- The model may declare a fixture `unfixable` (no event can satisfy the rule as written); those, answers without the tool call, truncated answers and partial answers go to `.work/repair-failed.json` with the error and the answer's `stop_reason` (for example `refusal`).
- Same safeguards as `submit`: `--max-cost` (default 20 USD for repairs), `--yes`, `--dry-run`, `--limit`, and rules waiting in an uncollected batch are skipped unless `--force`. Rules the engine does not support, rules whose content file is missing and rules already repaired since the last validation are skipped with a message.
- For another content folder, pass the same folders to both tools: `npm run content:validate -- --rules ~/sigmahq/rules --content ~/sigma-playbooks/content` writes `~/sigma-playbooks/content-failures.json`; then `content_pack.py --rules-dir ~/sigmahq/rules --out ~/sigma-playbooks/content repair --failures ~/sigma-playbooks/content-failures.json`.
- Unit tests (no API key needed): `python3 -m unittest discover -s tools/content-pack -v`.

## Notes

- Re-running is safe: rules that already have a file, or that are waiting in a batch you have not collected yet, are skipped (`--force` overrides both).
- `submit` refuses to send a batch whose estimate is above `--max-cost` (default 120 USD).
- `submit --dry-run` writes the requests to `tools/content-pack/.work/requests.jsonl` without calling the API.
- `--model claude-sonnet-5-5` halves the price per token; Opus 5.5 is the default for quality.
- `--effort low` (before the command, e.g. `content_pack.py --effort low submit`) makes the model think less and costs less; the default is the model's own (`medium` on Opus 5.5).
- Opus 5.5 and Sonnet 5.5 do not accept forced tool calls, so the request offers the tool with `tool_choice: auto` and the prompt requires the call. A response without it is recorded as failed; `retry` resubmits those rules.
- Batch ids and failures (with the API's reason) are kept in `tools/content-pack/.work/` (ignored by git).

## Cost (Batch API, Opus 5.5 at $2 / $10 per million input / output tokens)

| Scope | Rules | Estimate |
| --- | ---: | ---: |
| `rules/sigma/` (Centinela's subset) | 1,231 | about $54 |
| A full SigmaHQ clone (`--rules-dir <clone>/rules --out <folder>`) | 3,161 | about $139 |

These are upper-end guesses: `estimate` assumes 4,000 output tokens per rule (Opus 5.5 always thinks before answering, and thinking is billed as output) until `sample` has measured the real number; after `sample` it uses the measured average. Truncated or tool-less answers are billed and then billed again by `retry`, so check `sample` first.

## Output shape

```json
{
  "rule": { "id": "...", "title": "...", "level": "high", "status": "test", "author": "...", "path": "linux/builtin/...", "url": "https://github.com/SigmaHQ/sigma/blob/<commit>/rules/...", "license": "DRL-1.1", "techniques": ["T1059.004"] },
  "playbook": {
    "es": { "summary": "...", "what_it_detects": "...", "why_it_matters": "...", "triage_steps": ["..."], "false_positives": ["..."], "response_steps": ["..."], "severity_rationale": "..." },
    "en": { "...": "same keys" }
  },
  "fixtures": {
    "positive": [{ "description": "...", "event": { "CommandLine": "...", "Image": "..." } }],
    "negative": [{ "description": "...", "event": { "...": "..." } }]
  },
  "generated": { "tool": "content-pack/1", "model": "claude-opus-5-5", "at": "...", "review": "unreviewed", "notice": "AI-generated content. Review it before relying on it. ..." }
}
```

Playbooks are derived from DRL 1.1 rules, so every file keeps the rule's author, link and license.

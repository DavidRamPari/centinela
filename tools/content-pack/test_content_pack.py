"""Unit tests for the `repair` command of content_pack.py.

Run from the repository root (no API key or network needed):

    python3 -m unittest discover -s tools/content-pack -v
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

import content_pack as cp  # noqa: E402

RULE_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ID = "22222222-2222-4222-8222-222222222222"

RULE_YAML = f"""title: Whoami Through Cmd
id: {RULE_ID}
status: test
author: Test Author
logsource:
    product: windows
    category: process_creation
detection:
    selection:
        Image|endswith: '\\cmd.exe'
        CommandLine|contains: '/c whoami'
    condition: selection
level: medium
"""

OTHER_YAML = RULE_YAML.replace(RULE_ID, OTHER_ID).replace("Whoami Through Cmd", "Other Rule")

PLAYBOOK = {
    "summary": "S.", "what_it_detects": "W.", "why_it_matters": "M.", "triage_steps": ["T."],
    "false_positives": ["F."], "response_steps": ["R."], "severity_rationale": "V.",
}

GOOD = {"Image": "C:\\Windows\\System32\\cmd.exe", "CommandLine": "cmd.exe /c whoami"}
BAD_POSITIVE = {"Image": "C:\\Windows\\System32\\cmd.exe"}
GOOD_NEGATIVE = {"Image": "C:\\Windows\\explorer.exe"}
BAD_NEGATIVE = {"Image": "C:\\Windows\\System32\\cmd.exe", "CommandLine": "cmd /c WHOAMI"}


def content_for(rule_id: str) -> dict:
    return {
        "rule": {"id": rule_id, "title": "t", "path": "p.yml", "author": "a", "url": None, "license": "DRL-1.1"},
        "playbook": {"es": PLAYBOOK, "en": PLAYBOOK},
        "fixtures": {
            "positive": [{"description": "ok", "event": GOOD}, {"description": "missing CommandLine", "event": BAD_POSITIVE}],
            "negative": [{"description": "explorer", "event": GOOD_NEGATIVE}, {"description": "matches", "event": BAD_NEGATIVE}],
        },
        "generated": {"tool": "content-pack/1", "model": "m", "at": "2026-10-25T00:00:00+00:00",
                      "review": "unreviewed", "notice": "AI-generated."},
    }


def failure(rule_id: str, kind: str, index: int, event: dict, reason: str) -> dict:
    return {"ruleId": rule_id, "title": "t", "rulePath": "p.yml", "file": f"{rule_id}.json", "kind": kind,
            "index": index, "description": "d", "event": event, "reason": reason, "selections": None}


FAILURES = [
    failure(RULE_ID, "positive", 1, BAD_POSITIVE,
            'expected a match, but the condition "selection" is false: selection did not match '
            "(failed: CommandLine|contains: field missing)"),
    failure(RULE_ID, "negative", 1, BAD_NEGATIVE,
            'expected no match, but the condition "selection" is true: selection matched'),
]


def failures_doc(failures: list[dict], unsupported: list[dict] | None = None) -> dict:
    return {"format": cp.FAILURES_FORMAT, "rulesDir": "rules/sigma", "contentDir": "content/sigma", "pruned": False,
            "summary": {"rules": 1, "fixtures": 4, "passed": 2, "failed": 2},
            "unsupported": unsupported or [], "failures": failures}


def tool_message(data: dict, stop_reason: str = "tool_use", name: str = cp.REPAIR_TOOL_NAME) -> SimpleNamespace:
    block = SimpleNamespace(type="tool_use", name=name, input=data)
    return SimpleNamespace(stop_reason=stop_reason, content=[block],
                           usage=SimpleNamespace(input_tokens=1000, output_tokens=500))


def text_message(stop_reason: str) -> SimpleNamespace:
    return SimpleNamespace(stop_reason=stop_reason, content=[SimpleNamespace(type="text", text="...")],
                           usage=SimpleNamespace(input_tokens=1000, output_tokens=10))


ANSWER = {"fixtures": [
    {"kind": "positive", "index": 1, "description": "fixed", "event": {**BAD_POSITIVE, "CommandLine": "cmd /c whoami /all"}},
    {"kind": "negative", "index": 1, "description": "fixed", "event": {**BAD_NEGATIVE, "CommandLine": "cmd /c dir"}},
]}


class Workspace(unittest.TestCase):
    """A temporary rules folder, content folder, failures file and .work folder."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.rules_dir = root / "rules"
        (self.rules_dir / "windows").mkdir(parents=True)
        (self.rules_dir / "windows" / "whoami.yml").write_text(RULE_YAML, encoding="utf-8")
        (self.rules_dir / "windows" / "other.yml").write_text(OTHER_YAML, encoding="utf-8")
        self.out = root / "content"
        self.out.mkdir()
        for rule_id in (RULE_ID, OTHER_ID):
            cp.atomic_write_json(self.out / f"{rule_id}.json", content_for(rule_id))
        self.failures_path = root / "failures.json"
        cp.atomic_write_json(self.failures_path, failures_doc(FAILURES))
        self.saved_work_dir = cp.WORK_DIR
        cp.WORK_DIR = root / ".work"

    def tearDown(self) -> None:
        cp.WORK_DIR = self.saved_work_dir
        self.tmp.cleanup()

    def args(self, **overrides) -> argparse.Namespace:
        values = dict(origin="sigmahq", rules_dir=self.rules_dir, out=self.out, failures=self.failures_path,
                      model=cp.DEFAULT_MODEL,
                      effort=None, force=False, limit=0, max_cost=20.0, yes=False, dry_run=True)
        values.update(overrides)
        return argparse.Namespace(**values)

    def run_quietly(self, fn, *args):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            fn(*args)
        return buffer.getvalue()


class BuildRequestsTest(Workspace):
    def test_one_request_per_rule_with_rule_fixtures_and_reasons(self):
        rules = cp.load_rules(self.rules_dir)
        jobs, skipped = cp.plan_repairs(failures_doc(FAILURES), rules, self.out)
        self.assertEqual(skipped, [])
        self.assertEqual([j["rule"]["id"] for j in jobs], [RULE_ID])
        self.assertEqual([(f["kind"], f["index"]) for f in jobs[0]["failures"]], [("positive", 1), ("negative", 1)])

        params = cp.build_repair_params(jobs[0]["rule"], jobs[0]["content"], jobs[0]["failures"], "claude-opus-5-5", "high")
        self.assertEqual(params["model"], "claude-opus-5-5")
        self.assertEqual(params["output_config"], {"effort": "high"})
        self.assertEqual(params["tool_choice"], {"type": "auto"})
        self.assertEqual([t["name"] for t in params["tools"]], [cp.REPAIR_TOOL_NAME])
        self.assertIn("Centinela's engine evaluated the fixtures", params["system"])
        self.assertIn(cp.FIXTURE_GUIDE, params["system"])
        prompt = params["messages"][0]["content"]
        self.assertIn(RULE_YAML.strip(), prompt)
        self.assertIn("- positive #1: expected a match", prompt)
        self.assertIn("- negative #1: expected no match", prompt)
        listing = json.loads(prompt.split("```json\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual([(f["kind"], f["index"], f["status"]) for f in listing], [
            ("positive", 0, "passed"), ("positive", 1, "REJECTED"), ("negative", 0, "passed"), ("negative", 1, "REJECTED")])
        # The playbook stays as it is: it is neither sent nor asked for.
        self.assertNotIn("triage_steps", prompt)

    def test_generation_prompt_is_unchanged_by_the_shared_guides(self):
        self.assertTrue(cp.SYSTEM_PROMPT.startswith(cp.PLAYBOOK_GUIDE))
        self.assertIn("\n\n" + cp.FIXTURE_GUIDE + "\n\n", cp.SYSTEM_PROMPT)
        self.assertTrue(cp.SYSTEM_PROMPT.endswith("Always answer by calling the save_content_pack tool exactly once."))

    def test_skips_unsupported_missing_and_already_repaired_rules(self):
        rules = cp.load_rules(self.rules_dir)
        doc = failures_doc(
            FAILURES + [failure(OTHER_ID, "positive", 1, {"Image": "changed meanwhile"}, "r"),
                        failure("33333333-3333-4333-8333-333333333333", "positive", 0, {"a": 1}, "r")],
            unsupported=[{"ruleId": RULE_ID, "title": "t", "rulePath": "p", "file": "f", "reason": "modifier:expand", "fixtures": 4}],
        )
        jobs, skipped = cp.plan_repairs(doc, rules, self.out)
        self.assertEqual(jobs, [])
        reasons = dict(skipped)
        self.assertIn("does not support", reasons[RULE_ID])
        self.assertIn("already repaired", reasons[OTHER_ID])
        self.assertIn("not found", reasons["33333333-3333-4333-8333-333333333333"])

    def test_rejects_a_file_that_is_not_a_failures_file(self):
        bad = Path(self.tmp.name) / "bad.json"
        bad.write_text('{"failures": []}', encoding="utf-8")
        with self.assertRaises(SystemExit):
            cp.load_failures(bad)
        with self.assertRaises(SystemExit):
            cp.load_failures(Path(self.tmp.name) / "missing.json")


class AnswerParsingTest(unittest.TestCase):
    def test_accepts_fixtures_or_unfixable_entries(self):
        data, error = cp.repair_input_from_message(tool_message(ANSWER))
        self.assertIsNone(error)
        self.assertEqual(data, ANSWER)
        data, error = cp.repair_input_from_message(
            tool_message({"fixtures": [], "unfixable": [{"kind": "positive", "index": 0, "reason": "contradiction"}]}))
        self.assertIsNone(error)

    def test_reports_the_stop_reason_of_answers_without_the_tool(self):
        self.assertEqual(cp.repair_input_from_message(text_message("refusal")),
                         (None, "no save_fixtures tool call in the response (stop_reason: refusal)"))
        self.assertEqual(cp.repair_input_from_message(text_message("max_tokens")), (None, "output truncated (max_tokens)"))
        self.assertIsNotNone(cp.repair_input_from_message(tool_message({"fixtures": []}))[1])
        self.assertIsNotNone(cp.repair_input_from_message(tool_message(ANSWER, name=cp.TOOL_NAME))[1])


class MergeTest(unittest.TestCase):
    def test_replaces_only_the_rejected_fixtures(self):
        content = content_for(RULE_ID)
        updated, applied, problems = cp.merge_repair(content, FAILURES, ANSWER, "m", "2026-10-26T00:00:00+00:00")
        self.assertEqual(applied, ["positive/1", "negative/1"])
        self.assertEqual(problems, [])
        self.assertEqual(updated["fixtures"]["positive"][0], content["fixtures"]["positive"][0])
        self.assertEqual(updated["fixtures"]["positive"][1],
                         {"description": "fixed", "event": {**BAD_POSITIVE, "CommandLine": "cmd /c whoami /all"}})
        self.assertEqual(updated["fixtures"]["negative"][1]["event"]["CommandLine"], "cmd /c dir")
        self.assertEqual(updated["playbook"], content["playbook"])
        self.assertEqual(updated["generated"]["repairs"],
                         [{"tool": cp.TOOL_VERSION, "model": "m", "at": "2026-10-26T00:00:00+00:00",
                           "fixtures": ["positive/1", "negative/1"]}])
        # The input is left as it was.
        self.assertEqual(content, content_for(RULE_ID))

    def test_reports_missing_unfixable_invalid_and_unrequested_answers(self):
        answer = {
            "fixtures": [
                {"kind": "negative", "index": 1, "description": "x", "event": {"nested": {"no": 1}}},
                {"kind": "positive", "index": 0, "description": "not rejected", "event": {"a": 1}},
            ],
            "unfixable": [{"kind": "positive", "index": 1, "reason": "no event can match"}],
        }
        updated, applied, problems = cp.merge_repair(content_for(RULE_ID), FAILURES, answer, "m", "t")
        self.assertEqual(applied, [])
        self.assertEqual(problems, ["ignored positive/0: it was not rejected",
                                    "unfixable positive/1: no event can match",
                                    "invalid event for negative/1"])
        self.assertEqual(updated, content_for(RULE_ID))

    def test_never_overwrites_a_fixture_edited_since_validation(self):
        content = content_for(RULE_ID)
        content["fixtures"]["positive"][1]["event"] = {"Image": "edited by hand"}
        updated, applied, problems = cp.merge_repair(content, FAILURES, ANSWER, "m", "t")
        self.assertEqual(applied, ["negative/1"])
        self.assertEqual(problems, ["positive/1 changed since validation; left as it is"])
        self.assertEqual(updated["fixtures"]["positive"][1]["event"], {"Image": "edited by hand"})


class RepairCommandTest(Workspace):
    def test_dry_run_writes_the_requests_without_calling_the_api(self):
        output = self.run_quietly(cp.cmd_repair, self.args())
        self.assertIn("repairing 2 fixtures of 1 rules", output)
        lines = (cp.WORK_DIR / "repair-requests.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        request = json.loads(lines[0])
        self.assertEqual(request["custom_id"], RULE_ID)
        self.assertEqual(request["params"]["tools"][0]["name"], cp.REPAIR_TOOL_NAME)
        self.assertFalse((cp.WORK_DIR / "batches.json").exists())

    def test_refuses_to_submit_above_max_cost(self):
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stdout(io.StringIO()):
            cp.cmd_repair(self.args(max_cost=0.0001, dry_run=False))
        self.assertIn("--max-cost", str(raised.exception.code))

    def test_skips_rules_waiting_in_an_uncollected_batch(self):
        cp.atomic_write_json(cp.WORK_DIR / "batches.json",
                             [{"id": "msgbatch_1", "kind": "repair", "custom_ids": [RULE_ID], "collected": False}])
        output = self.run_quietly(cp.cmd_repair, self.args())
        self.assertIn("skipping 1 rules that are in a batch you have not collected yet", output)
        self.assertIn("nothing to repair", output)
        self.assertIn("repairing 2 fixtures", self.run_quietly(cp.cmd_repair, self.args(force=True)))


class FakeBatches:
    def __init__(self, results):
        self._results = results

    def retrieve(self, batch_id):
        return SimpleNamespace(id=batch_id, processing_status="ended")

    def results(self, batch_id):
        return iter(self._results)


def succeeded(custom_id: str, message) -> SimpleNamespace:
    return SimpleNamespace(custom_id=custom_id, result=SimpleNamespace(type="succeeded", message=message))


class CollectRepairTest(Workspace):
    def entry(self) -> dict:
        return {"id": "msgbatch_1", "kind": "repair", "model": "claude-opus-5-5", "count": 2,
                "custom_ids": [RULE_ID, OTHER_ID], "out": str(self.out),
                "fixtures": {RULE_ID: FAILURES, OTHER_ID: [failure(OTHER_ID, "positive", 1, BAD_POSITIVE, "r")]},
                "collected": False}

    def test_writes_corrections_back_and_records_failed_answers_with_their_stop_reason(self):
        api = SimpleNamespace(messages=SimpleNamespace(batches=FakeBatches([
            succeeded(RULE_ID, tool_message(ANSWER)),
            succeeded(OTHER_ID, text_message("refusal")),
        ])))
        entry = self.entry()
        repair_failed: dict = {}
        self.run_quietly(cp.collect_repair, api, entry, repair_failed)

        written = json.loads((self.out / f"{RULE_ID}.json").read_text(encoding="utf-8"))
        self.assertEqual(written["fixtures"]["positive"][1]["description"], "fixed")
        self.assertEqual(written["playbook"], content_for(RULE_ID)["playbook"])
        self.assertEqual(json.loads((self.out / f"{OTHER_ID}.json").read_text(encoding="utf-8")), content_for(OTHER_ID))
        self.assertEqual(repair_failed, {OTHER_ID: {
            "error": "no save_fixtures tool call in the response (stop_reason: refusal)", "stop_reason": "refusal"}})
        self.assertTrue(entry["collected"])
        self.assertEqual(entry["usage"]["input_tokens"], 2000)

    def test_cmd_collect_dispatches_repair_batches(self):
        cp.atomic_write_json(cp.WORK_DIR / "batches.json", [self.entry()])
        api = SimpleNamespace(messages=SimpleNamespace(batches=FakeBatches([succeeded(RULE_ID, tool_message(ANSWER))])))
        saved = cp.client
        cp.client = lambda: api
        try:
            output = self.run_quietly(cp.cmd_collect, self.args())
        finally:
            cp.client = saved
        self.assertIn("(repair): replaced 2 fixtures in 1 rules", output)
        self.assertIn("npm run content:validate", output)
        state = json.loads((cp.WORK_DIR / "batches.json").read_text(encoding="utf-8"))
        self.assertTrue(state[0]["collected"])
        self.assertEqual(json.loads((cp.WORK_DIR / "repair-failed.json").read_text(encoding="utf-8")), {})


# --------------------------------------------------------------------------- --origin centinela

BASE_ID = "5ab518e4-b4bf-44a2-9874-a8e86a590287"
SUCCESS_ID = "5a38afe9-0000-4000-8000-000000000001"
INNER_ID = "6c1f0b6e-5f5a-4e61-9a0e-1f2b3c4d5e6f"
CHAINED_ID = "1751f556-a4e2-493f-a475-ead6e0163909"

BASE_YAML = f"""title: SSH authentication failure
id: {BASE_ID}
name: centinela-ssh-auth-failure
status: experimental
author: DavidRamPari
logsource:
    product: linux
    service: sshd
detection:
    selection:
        event.action: ssh_login
        event.outcome: failure
    condition: selection
level: low
"""

SUCCESS_YAML = BASE_YAML.replace(BASE_ID, SUCCESS_ID).replace("failure", "success").replace(
    "SSH authentication success", "SSH authentication success")

INNER_YAML = f"""title: SSH brute force
id: {INNER_ID}
name: centinela-ssh-bruteforce
status: experimental
author: DavidRamPari
correlation:
    type: event_count
    rules:
        - centinela-ssh-auth-failure
    group-by:
        - source.ip
    timespan: 5m
    condition:
        gte: 10
level: high
"""

CHAINED_YAML = f"""title: Successful SSH login after a brute force
id: {CHAINED_ID}
name: centinela-ssh-bruteforce-success
status: experimental
author: DavidRamPari
correlation:
    type: temporal_ordered
    rules:
        - centinela-ssh-bruteforce
        - {SUCCESS_ID}
        - centinela-missing-rule
    group-by:
        - source.ip
    timespan: 30m
level: critical
tags:
    - attack.t1110.001
"""

PLAYBOOK_ANSWER = {"es": PLAYBOOK, "en": PLAYBOOK}
CONTENT_ANSWER = {**PLAYBOOK_ANSWER, "fixtures": {
    "positive": [{"description": "p", "event": {"event.action": "ssh_login", "event.outcome": "failure"}}],
    "negative": [{"description": "n", "event": {"event.action": "ssh_login", "event.outcome": "success"}}],
}}


class CentinelaOriginTest(unittest.TestCase):
    """--origin centinela: rules/centinela/** and rules/correlation/** into content/centinela."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.rules_root = root / "rules"
        files = {
            "centinela/linux/ssh_auth_failure.yml": BASE_YAML,
            "centinela/linux/ssh_auth_success.yml": SUCCESS_YAML,
            "correlation/ssh_bruteforce.yml": INNER_YAML,
            "correlation/ssh_bruteforce_success.yml": CHAINED_YAML,
            # SigmaHQ rules in the same root are not Centinela's.
            "sigma/windows/whoami.yml": RULE_YAML,
        }
        for rel, text in files.items():
            (self.rules_root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.rules_root / rel).write_text(text, encoding="utf-8")
        self.out = root / "content" / "centinela"
        self.saved_work_dir = cp.WORK_DIR
        cp.WORK_DIR = root / ".work"

    def tearDown(self) -> None:
        cp.WORK_DIR = self.saved_work_dir
        self.tmp.cleanup()

    def rules(self) -> list[dict]:
        return cp.load_rules(self.rules_root, "centinela")

    def by_id(self, rule_id: str) -> dict:
        return next(r for r in self.rules() if r["id"] == rule_id)

    def test_loads_centinela_and_correlation_rules_as_mit_with_their_own_attribution(self):
        rules = self.rules()
        self.assertEqual([r["path"] for r in rules], [
            "centinela/linux/ssh_auth_failure.yml", "centinela/linux/ssh_auth_success.yml",
            "correlation/ssh_bruteforce.yml", "correlation/ssh_bruteforce_success.yml"])
        self.assertEqual({r["license"] for r in rules}, {"MIT"})
        self.assertEqual({r["author"] for r in rules}, {"DavidRamPari"})
        self.assertEqual({r["url"] for r in rules}, {None})
        self.assertEqual([r["kind"] for r in rules], ["detection", "detection", "correlation", "correlation"])
        self.assertEqual(self.by_id(CHAINED_ID)["techniques"], ["T1110.001"])
        with self.assertRaises(SystemExit):
            cp.load_rules(self.rules_root / "sigma", "centinela")

    def test_sigmahq_records_keep_their_license_and_link(self):
        rules = cp.load_rules(self.rules_root / "sigma")
        self.assertEqual(len(rules), 1)
        self.assertEqual((rules[0]["license"], rules[0]["origin"], rules[0]["kind"]), ("DRL-1.1", "sigmahq", "detection"))

    def test_detection_rules_get_the_content_tool_with_a_note_on_field_names(self):
        params = cp.build_params(self.by_id(BASE_ID), "claude-opus-5-5", None, self.rules())
        self.assertEqual(params["system"], cp.SYSTEM_PROMPT)
        self.assertEqual([t["name"] for t in params["tools"]], [cp.TOOL_NAME])
        prompt = params["messages"][0]["content"]
        self.assertIn("Origin: Centinela (this project's own rule), MIT License", prompt)
        self.assertIn("event.action, event.outcome", prompt)
        self.assertIn(BASE_YAML.strip(), prompt)

    def test_correlations_get_a_playbook_only_request_with_the_rules_they_reference(self):
        params = cp.build_params(self.by_id(CHAINED_ID), "claude-opus-5-5", "high", self.rules())
        self.assertEqual(params["system"], cp.CORRELATION_SYSTEM_PROMPT)
        self.assertIn("Do not write test fixtures", params["system"])
        self.assertEqual([t["name"] for t in params["tools"]], [cp.PLAYBOOK_TOOL_NAME])
        self.assertNotIn("fixtures", params["tools"][0]["input_schema"]["properties"])
        self.assertEqual(params["output_config"], {"effort": "high"})
        prompt = params["messages"][0]["content"]
        self.assertIn(CHAINED_YAML.strip(), prompt)
        # Chained: the inner correlation, the base rule it counts and the success rule (by id).
        for text in (INNER_YAML, BASE_YAML, SUCCESS_YAML):
            self.assertIn(text.strip(), prompt)
        self.assertIn("References not found among the loaded rules: centinela-missing-rule", prompt)
        self.assertNotIn("Whoami", prompt)

    def test_playbook_only_answers_and_content_files(self):
        rule = self.by_id(CHAINED_ID)
        data, error = cp.tool_input_from_message(tool_message(PLAYBOOK_ANSWER, name=cp.PLAYBOOK_TOOL_NAME), True)
        self.assertIsNone(error)
        record = cp.record_for(rule, data, "m")
        self.assertNotIn("fixtures", record)
        self.assertEqual(record["rule"]["license"], "MIT")
        self.assertIsNone(record["rule"]["url"])
        self.assertEqual(record["rule"]["path"], "correlation/ssh_bruteforce_success.yml")
        self.assertEqual(record["generated"]["notice"], "AI-generated content. Review it before relying on it.")
        # The content tool is not accepted for a correlation, and a detection rule still needs fixtures.
        self.assertEqual(cp.tool_input_from_message(tool_message(CONTENT_ANSWER, name=cp.TOOL_NAME), True)[1],
                         "no save_playbook tool call in the response")
        self.assertEqual(cp.tool_input_from_message(tool_message(PLAYBOOK_ANSWER, name=cp.TOOL_NAME))[1],
                         "missing fixtures")
        base = cp.record_for(self.by_id(BASE_ID), CONTENT_ANSWER, "m")
        self.assertEqual(base["fixtures"], CONTENT_ANSWER["fixtures"])

    def test_main_defaults_to_the_rules_root_and_content_centinela(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            cp.main(["--origin", "centinela", "--rules-dir", str(self.rules_root), "--out", str(self.out),
                     "submit", "--dry-run"])
        self.assertIn("dry run: wrote 4 requests", output.getvalue())
        requests = [json.loads(line) for line in (cp.WORK_DIR / "requests.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([r["params"]["tools"][0]["name"] for r in requests],
                         [cp.TOOL_NAME, cp.TOOL_NAME, cp.PLAYBOOK_TOOL_NAME, cp.PLAYBOOK_TOOL_NAME])

    def test_collect_writes_playbook_only_files_for_correlations(self):
        entry = {"id": "msgbatch_2", "model": "m", "count": 2, "custom_ids": [CHAINED_ID, BASE_ID],
                 "origin": "centinela", "rules_dir": str(self.rules_root), "out": str(self.out), "collected": False}
        api = SimpleNamespace(messages=SimpleNamespace(batches=FakeBatches([
            succeeded(CHAINED_ID, tool_message(PLAYBOOK_ANSWER, name=cp.PLAYBOOK_TOOL_NAME)),
            succeeded(BASE_ID, tool_message(CONTENT_ANSWER, name=cp.TOOL_NAME)),
        ])))
        failed: dict = {}
        args = argparse.Namespace(rules_dir=self.rules_root, out=self.out)
        with contextlib.redirect_stdout(io.StringIO()):
            cp.collect_generation(api, entry, args, failed)
        self.assertEqual(failed, {})
        chained = json.loads((self.out / f"{CHAINED_ID}.json").read_text(encoding="utf-8"))
        self.assertNotIn("fixtures", chained)
        self.assertEqual(chained["playbook"]["en"], PLAYBOOK)
        base = json.loads((self.out / f"{BASE_ID}.json").read_text(encoding="utf-8"))
        self.assertEqual(base["rule"]["license"], "MIT")
        self.assertIn("fixtures", base)

    def test_main_resolves_defaults_per_origin(self):
        seen = {}
        saved = cp.cmd_estimate
        cp.cmd_estimate = lambda args: seen.update(origin=args.origin, rules=args.rules_dir, out=args.out)
        try:
            cp.main(["--origin", "centinela", "estimate"])
            self.assertEqual(seen, {"origin": "centinela", "rules": cp.REPO_ROOT / "rules",
                                    "out": cp.REPO_ROOT / "content" / "centinela"})
            cp.main(["estimate"])
            self.assertEqual(seen, {"origin": "sigmahq", "rules": cp.DEFAULT_RULES_DIR, "out": cp.DEFAULT_OUT_DIR})
        finally:
            cp.cmd_estimate = saved


# --------------------------------------------------------------------------- SigmaHQ folders

COMMIT_RE = r"[0-9a-f]{40}"


class SigmaFoldersTest(unittest.TestCase):
    """Any rule folder of a SigmaHQ checkout: the folder is recorded and decides the link."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.checkout = Path(self.tmp.name) / "sigma"
        files = {
            "rules/windows/process_creation/whoami.yml": RULE_YAML,
            "rules-emerging-threats/2024/Exploits/CVE-2024-0001/other.yml": OTHER_YAML,
            "rules-threat-hunting/windows/hunt.yml": RULE_YAML.replace(RULE_ID, "33333333-3333-4333-8333-333333333333"),
            "rules-compliance/other/compliance.yml": RULE_YAML.replace(RULE_ID, "44444444-4444-4444-8444-444444444444"),
        }
        for rel, text in files.items():
            (self.checkout / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.checkout / rel).write_text(text, encoding="utf-8")
        git = ["git", "-C", str(self.checkout), "-c", "user.name=test", "-c", "user.email=test@example.com",
               "-c", "commit.gpgsign=false"]
        subprocess.run([*git, "init", "-q"], check=True)
        subprocess.run([*git, "add", "."], check=True)
        subprocess.run([*git, "commit", "-q", "-m", "rules"], check=True)
        self.commit = subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def only(self, folder: str) -> dict:
        rules = cp.load_rules(self.checkout / folder)
        self.assertEqual(len(rules), 1)
        return rules[0]

    def test_each_folder_records_itself_and_links_into_it(self):
        base = f"https://github.com/SigmaHQ/sigma/blob/{self.commit}"
        cases = {
            "rules": ("windows/process_creation/whoami.yml", "rules/windows/process_creation/whoami.yml"),
            "rules-emerging-threats": ("2024/Exploits/CVE-2024-0001/other.yml",
                                       "rules-emerging-threats/2024/Exploits/CVE-2024-0001/other.yml"),
            "rules-threat-hunting": ("windows/hunt.yml", "rules-threat-hunting/windows/hunt.yml"),
            "rules-compliance": ("other/compliance.yml", "rules-compliance/other/compliance.yml"),
        }
        for folder, (path, link) in cases.items():
            with self.subTest(folder=folder):
                rule = self.only(folder)
                self.assertEqual((rule["folder"], rule["path"], rule["url"]), (folder, path, f"{base}/{link}"))
                self.assertEqual(rule["license"], "DRL-1.1")

    def test_a_subfolder_keeps_its_place_in_the_link(self):
        rule = self.only("rules/windows")
        self.assertEqual(rule["folder"], "rules")
        self.assertEqual(rule["path"], "process_creation/whoami.yml")
        self.assertTrue(rule["url"].endswith("/rules/windows/process_creation/whoami.yml"))

    def test_without_git_the_folder_is_still_recorded_but_there_is_no_link(self):
        plain = Path(self.tmp.name) / "download" / "rules-threat-hunting"
        (plain / "windows").mkdir(parents=True)
        (plain / "windows" / "hunt.yml").write_text(RULE_YAML, encoding="utf-8")
        self.assertEqual(cp.guess_prefix(plain / "windows"), "rules-threat-hunting/windows")
        saved = cp.subprocess.run

        def no_git(*args, **kwargs):
            raise OSError("git not installed")

        cp.subprocess.run = no_git
        try:
            rule = cp.load_rules(plain)[0]
        finally:
            cp.subprocess.run = saved
        self.assertEqual((rule["folder"], rule["url"]), ("rules-threat-hunting", None))

    def test_the_vendored_subset_links_into_rules(self):
        commit, prefix = cp.sigma_location(cp.DEFAULT_RULES_DIR)
        self.assertRegex(commit or "", COMMIT_RE)
        self.assertEqual(prefix, "rules")
        rules = cp.load_rules(cp.DEFAULT_RULES_DIR)
        self.assertEqual({r["folder"] for r in rules}, {"rules"})
        self.assertTrue(all(r["url"].startswith(f"https://github.com/SigmaHQ/sigma/blob/{commit}/rules/") for r in rules))

    def test_prompts_name_the_folder_except_for_rules(self):
        rules_rule = self.only("rules")
        self.assertEqual(cp.user_prompt(rules_rule).splitlines()[:3],
                         ["Rule file: windows/process_creation/whoami.yml",
                          "Origin: SigmaHQ, Detection Rule License 1.1", ""])
        for folder in ("rules-emerging-threats", "rules-threat-hunting", "rules-compliance"):
            with self.subTest(folder=folder):
                rule = self.only(folder)
                lines = cp.user_prompt(rule).splitlines()
                self.assertTrue(lines[2].startswith(f"SigmaHQ folder: {folder} ("))
                self.assertEqual(lines[3], "")
                self.assertIn(cp.SIGMAHQ_FOLDER_NOTES[folder], cp.repair_prompt(rule, content_for(rule["id"]), FAILURES))
        self.assertNotIn("SigmaHQ folder", cp.repair_prompt(rules_rule, content_for(RULE_ID), FAILURES))

    def test_content_files_record_the_folder(self):
        data = {"es": PLAYBOOK, "en": PLAYBOOK, "fixtures": content_for(RULE_ID)["fixtures"]}
        record = cp.record_for(self.only("rules-emerging-threats"), data, "m")
        self.assertEqual(record["rule"]["folder"], "rules-emerging-threats")
        self.assertIn("/rules-emerging-threats/", record["rule"]["url"])
        self.assertEqual(cp.record_for(self.only("rules"), data, "m")["rule"]["folder"], "rules")

    def test_repair_reads_the_failures_file_of_its_folder(self):
        out = Path(self.tmp.name) / "content"
        self.assertEqual(cp.default_failures(out, self.checkout / "rules", "sigmahq"), out.parent / "content-failures.json")
        self.assertEqual(cp.default_failures(out, self.checkout / "rules-threat-hunting", "sigmahq"),
                         out.parent / "content-rules-threat-hunting-failures.json")
        self.assertEqual(cp.default_failures(cp.DEFAULT_OUT_DIR, cp.DEFAULT_RULES_DIR, "sigmahq"),
                         cp.REPO_ROOT / "content" / "sigma-failures.json")


if __name__ == "__main__":
    unittest.main()

"""Unit tests for the `repair` command of content_pack.py.

Run from the repository root (no API key or network needed):

    python3 -m unittest discover -s tools/content-pack -v
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
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
        values = dict(rules_dir=self.rules_dir, out=self.out, failures=self.failures_path, model=cp.DEFAULT_MODEL,
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


if __name__ == "__main__":
    unittest.main()

# Content pack

`content/sigma/<rule-id>.json` holds, for each vendored SigmaHQ rule, an AI-generated bilingual investigation playbook and test fixtures, produced by `tools/content-pack` (see its README). Session S7 loads the playbooks into the dashboard and validates every fixture with Centinela's engine; fixtures that fail move to `content/sigma-rejected/` with the reason.

Each file keeps the rule's author, link and license (Detection Rule License 1.1). The content is marked `"review": "unreviewed"` until a person checks it.

# Vendored SigmaHQ rules

These detection rules are copied unchanged from the SigmaHQ repository and are licensed under the **Detection Rule License (DRL) 1.1** — see [LICENSE.Detection.Rules.md](LICENSE.Detection.Rules.md). Each rule keeps its `author` field, and Centinela shows that author, a link to the rule and the license in every alert a rule produces, as DRL 1.1 requires.

- Source: https://github.com/SigmaHQ/sigma
- Source commit: 05d1031f537e830b76da53bae2400c5814c89165 (2026-10-21)
- Rule links: `https://github.com/SigmaHQ/sigma/blob/<commit>/rules/<path below rules/sigma>`

## Included folders

| Folder here | Upstream folder | Rules | Log source |
| --- | --- | ---: | --- |
| `linux/builtin/` | `rules/linux/builtin/` | 22 | Linux syslog / auth.log (keyword rules) |
| `web/webserver_generic/` | `rules/web/webserver_generic/` | 13 | web server access logs |
| `web/product/` | `rules/web/product/` | 3 | Apache and nginx specific |
| `windows/process_creation/` | `rules/windows/process_creation/` | 1,193 | Sysmon event ID 1 / process creation |
| **Total** | | **1,231** | |

## Regression samples

`regression/windows/process_creation/<rule>/` holds SigmaHQ's JSON regression events (event logs from a test machine that must match the rule) and their `info.yml`, for the 267 vendored Windows rules that have them. `regression/pipelines/process_creation_fieldmapping.yml` is SigmaHQ's field mapping for those samples (`Event.EventData.<Field>`). The original `.evtx` files are not included.

## Do not edit

Never modify these files. Centinela's own rules go in `rules/centinela/` and `rules/correlation/`. To update the subset, copy the same folders from a newer SigmaHQ commit and update the commit line above.

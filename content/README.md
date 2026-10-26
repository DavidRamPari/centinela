# Content pack

`content/sigma/<rule-id>.json` holds, for each vendored SigmaHQ rule, an AI-generated bilingual investigation playbook and test fixtures, produced by `tools/content-pack` (see its README). Session S7 loads the playbooks into the dashboard and validates every fixture with Centinela's engine; fixtures that fail move to `content/sigma-rejected/` with the reason.

Each file keeps the rule's author, link and license (Detection Rule License 1.1). The content is marked `"review": "unreviewed"` until a person checks it.

## Generation run (2026-10-25)

- Generator: `tools/content-pack` (`content-pack/1`), model `claude-opus-5-5` with effort `high`, through the Message Batches API.
- Input: the 1,231 vendored SigmaHQ rules in `rules/sigma/` (SigmaHQ commit `05d1031f`).
- Output: 1,221 files in `content/sigma/`. Each rule had up to two attempts. Cost: about $53.
- 10 rules have no file: Anthropic's safety filter stopped the answer in both attempts (`stop_reason: refusal`). Those rules detect offensive techniques, so their test events would have to contain attack command lines; they were left out instead of working around the filter.
- The fixtures are not validated yet: session S7 runs every one of them through Centinela's engine.

### Rules without content

| Rule | File | Reason |
| --- | --- | --- |
| HackTool - DInjector PowerShell Cradle Execution | `rules/sigma/windows/process_creation/proc_creation_win_hktl_dinjector.yml` | safety filter |
| HKTL - SharpSuccessor Privilege Escalation Tool Execution | `rules/sigma/windows/process_creation/proc_creation_win_hktl_sharpsuccessor_execution.yml` | safety filter |
| Suspicious Encoded And Obfuscated Reflection Assembly Load Function Call | `rules/sigma/windows/process_creation/proc_creation_win_powershell_base64_reflection_assembly_load_obfusc.yml` | safety filter |
| Assembly Loading Via CL_LoadAssembly.ps1 | `rules/sigma/windows/process_creation/proc_creation_win_powershell_cl_loadassembly.yml` | safety filter |
| Potential Powershell ReverseShell Connection | `rules/sigma/windows/process_creation/proc_creation_win_powershell_reverse_shell_connection.yml` | safety filter |
| Potential Privilege Escalation via Service Permissions Weakness | `rules/sigma/windows/process_creation/proc_creation_win_registry_privilege_escalation_via_service_key.yml` | safety filter |
| Suspicious NTLM Authentication on the Printer Spooler Service | `rules/sigma/windows/process_creation/proc_creation_win_rundll32_ntlmrelay.yml` | safety filter |
| Registry Modification of MS-settings Protocol Handler | `rules/sigma/windows/process_creation/proc_creation_win_susp_registry_modification_of_ms_setting_protocol_handler.yml` | safety filter |
| UAC Bypass Using Disk Cleanup | `rules/sigma/windows/process_creation/proc_creation_win_uac_bypass_cleanmgr.yml` | safety filter |
| UAC Bypass Using Event Viewer RecentViews | `rules/sigma/windows/process_creation/proc_creation_win_uac_bypass_eventvwr_recentviews.yml` | safety filter |

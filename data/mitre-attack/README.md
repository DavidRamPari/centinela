# MITRE ATT&CK reference data

`enterprise-attack.min.json` is a compact extract of the MITRE ATT&CK Enterprise matrix, used to turn technique IDs from rule tags into names, tactics and links.

- Source: https://github.com/mitre/cti (`enterprise-attack/enterprise-attack.json`, master branch, Enterprise matrix modified 2026-07-31)
- Contents: 15 tactics in matrix order (`id`, `shortname`, `name`, `url`) and 706 active techniques and sub-techniques (`id`, `name`, `tactics` as shortnames, `subtechnique`, `platforms`, `url`). Revoked and deprecated objects are excluded.
- Shape:

```json
{
  "source": "MITRE ATT&CK Enterprise (https://github.com/mitre/cti)",
  "version": "mitre/cti master, Enterprise matrix modified 2026-07-31",
  "generated": "2026-10-25",
  "tactics": [{ "id": "TA0006", "shortname": "credential-access", "name": "Credential Access", "url": "https://attack.mitre.org/tactics/TA0006" }],
  "techniques": [{ "id": "T1110.001", "name": "Password Guessing", "tactics": ["credential-access"], "subtechnique": true, "platforms": ["Linux", "..."], "url": "https://attack.mitre.org/techniques/T1110/001" }]
}
```

Note: this ATT&CK release splits the former Defense Evasion tactic into **Stealth** and **Defense Impairment**; the vendored SigmaHQ rules already use those tactic names.

© The MITRE Corporation. This work is reproduced and distributed with the permission of The MITRE Corporation. MITRE ATT&CK® is a registered trademark of The MITRE Corporation.

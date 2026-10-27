# Screenshots

Taken by session S7b from `npm run demo` data (seed 42), in the production build (`vite preview`, strict Content Security Policy), English unless the name says otherwise. PNGs are reduced to 256 colours. Session S8 retook the two alert pages (they now show the copy buttons added after S7b's set) and recorded the demo GIF, both from the Docker stack on `http://localhost:8080` (nginx serving the production build) with the same data.

| File | What it shows |
| --- | --- |
| `demo.gif` | 41 s at 1280 px, 10 frames per second, recorded from the real app (S8): the Overview, the critical alert "Successful SSH login after a brute force" with its folded timeline and its playbook in Spanish, the ATT&CK matrix for the last 7 days, and a live brute force followed by a successful login sent to `POST /api/ingest`, arriving as two alerts with their notifications |
| `overview.png` | Overview at 1440 px, dark theme: the "Needs your attention" scoreboard and the alerts to start with |
| `alerts.png` | Alerts list, last 7 days, 1440 px |
| `events.png` | Events list, last 24 hours, 1440 px |
| `alert-with-playbook.png` | An alert (Windows Webshell Strings) with what happened, triage and its playbook, 1440 px |
| `attack.png` | ATT&CK matrix, techniques with alerts in the last 7 days, 1440 px |
| `sign-in.png` | Sign-in page, 1440 px |
| `overview-light.png` | Overview in the light theme, 1440 px |
| `overview-360.png` | Overview at 360 px, full page |
| `overview-es.png`, `alert-with-playbook-es.png` | The same pages in Spanish |
| `before-after/*.png` | The Overview, the alert with its playbook, the events list, the ATT&CK matrix and the sign-in page before (S7) and after (S7b, with the revised colours of S7b-16) the redesign |

The brand files (mark, lockups, favicon) are in `packages/web/public/brand/`; the brand sheet is in `docs/decisions/S7b.md`.

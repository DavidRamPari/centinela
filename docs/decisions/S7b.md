# Session S7b decisions: dashboard polish

David's design direction for this session overrides `docs/PLAN.md` where they conflict. This file holds the concept, the brand sheet, the design plan (written and critiqued before any code) and the decisions taken while building.

## S7b-01 — Starting point: what the S3 to S7 dashboard looked like (2026-10-27, S7b)

`npm run demo` (199,550 lines, 37 alerts) and every page captured at 1440, 768 and 360 px, in English and Spanish, dark and light. What was weak:

- **No identity.** A generic shield icon, system fonts, slate surfaces with a sky-blue accent: it could be any admin template.
- **Grey cards everywhere.** Every block on every page was the same rounded, bordered, slightly lighter box, so nothing told the eye where to start.
- **Overview answered nothing first.** Four equal KPI cards with all-caps labels, two charts, four ranked lists, and the latest alerts at the very bottom. The events chart cut its four-digit axis labels (",000", ",500"). At 360 px the latest alerts wrapped one word per line.
- **Alert detail buried the story.** The summary was a definition list that mixed analyst facts with internals (deduplication key, group key) at the same weight. A correlation alert listed 47 near-identical timeline rows. The empty playbook panel was a dashed box that looked like a failed load.
- **ATT&CK matrix.** 14 columns of mostly "Alerts: 0" cells, 4,000 px tall, id before name in every cell, the few active techniques lost in the noise.
- **Header.** Live status, API status, theme, language, user and sign-out in one right-aligned row with no grouping.
- **Sign-in.** A small grey card on a dark page with the generic shield.
- **Details.** Small grey text in most labels, uppercase table headers, monospace for host names and users, a sidebar background that stopped at the first screen height, `·` separators in rule dates and log sources, arrow icons after external links.

## S7b-02 — Concept (2026-10-27, S7b)

**Centinela is the defender that hunts down the attackers and eats them.** The idea and the palette come from the 1980 arcade game Pac-Man: a yellow hero, red threats, a blue maze. Nothing else does: there is no character, ghost, maze sprite, logo, font or sound from the game anywhere.

Three colours carry the whole story. **Yellow is the defender**: in the interface, it is whatever the analyst does or where they are. **Red is the threat**, and in the interface it means danger and nothing else. **Blue is the ground** the defender guards: the structure of the screen. Black is the arcade screen everything sits on.

## S7b-03 — Brand sheet (2026-10-27, S7b)

### The mark: "Containment"

Two L-shaped pieces close in from opposite corners: the yellow one (the defender) from the top left, the blue one (the ground) from the bottom right. Between them sits a red square, the threat, contained. Containment is also the incident-response phase that follows detection, which is what an analyst does in Centinela.

- Drawn on a 16-unit grid, so the favicon is pixel-aligned: each piece is 3 units thick with a 3.5-unit outer radius and a 0.75-unit inner radius (the rounded corners of a maze wall); the red square is 4 units with a 0.5-unit radius; the pieces never touch, so the mark survives in one colour.
- It was chosen from five sketches rendered at 16, 24, 32, 64 and 160 px. Rejected: an arch over the threat (read as a padlock or a doorway, and its dome echoed the game's ghosts), a bracket pair `[■]` (read as code, and its yellow half was a C, which is a mouth), an eye in a frame (generic surveillance, mushy at 16 px), and a sharp-cornered version of the chosen mark (harsher, and less like the maze).

Variants (`packages/web/src/components/brand/`, `packages/web/public/`):

| Variant | Use |
| --- | --- |
| Full colour on black | default: sidebar, sign-in page, favicon (`favicon.svg` has its own black tile, so it reads on light browser tabs too) |
| Full colour on white | light theme: the yellow piece gains a thin dark keyline, because yellow alone disappears on white |
| One colour | `currentColor`; for monochrome contexts (print, embossing, a one-ink sticker) |

Clear space: one piece thickness (3/16 of the mark's width) on every side. Minimum size: 16 px for the mark alone; 20 px mark height for the lockup with the wordmark. Never: rotate it, recolour the pieces among themselves, outline it, add shadows or glows, or put it on a colour other than black or white.

### The wordmark and the "Corridor" letters

`centinela` in lowercase letters drawn for Centinela on the same grid: one-unit monoline strokes that turn corners with a one-unit radius, like a corridor of the maze. Every letter is orthogonal; there are no diagonals. The letters are yellow and the tittle of the `i` is a red square, the same threat as in the mark, so the lockup (mark plus wordmark) always shows the three primaries together. The same construction gives ten digits, a comma and a full stop: the **Corridor numerals**, used for the Overview's scoreboard. Corridor is drawn as SVG paths, so it costs no font file; screen readers get the number as text.

### Palette

Values tuned from the arcade references so they read vivid but never glow on black; every text pair passes WCAG AA (4.5:1) and every graphical mark (pips, chart lines, control borders) passes 3:1, checked by `test/theme.test.ts`.

| Name | Dark theme | Light theme | Role |
| --- | --- | --- | --- |
| Arcade black | `#000000` | `#FFFFFF` (paper) | the base; areas are separated by lines, spacing and alignment, not by grey cards |
| Defender yellow | `#FFDE3D` (15.8:1 on black) | `#FFD60A` fill, `#8F6B00` for rings and text | primary actions, selection, focus, "you are here"; reference `#FFFF00`, warmed and softened |
| Threat red | `#FF453A` (6.2:1) | `#D0180F` (5.5:1 on white) | danger only: critical alerts, destructive actions, errors; reference `#FF0000` |
| Maze blue | `#2E2EE8` walls, `#4747F0` control borders (3.4:1), `#20208F` hairlines | `#2121DE` | structure: navigation, frames, dividers; reference `#2121DE` |
| Link blue | `#9494FF` (7.9:1) | `#2121DE` (9.0:1) | links: the same blue family, lightened for text on black |
| Orange | `#FFAE57` | `#B35400` | high severity; warnings (degraded API, reconnecting) |
| Pink | `#F5A3EE` | `#A8239A` | medium severity; the alerts series in charts |
| Cyan | `#5ED8E4` | `#00737E` | low severity; "connected" and "API online"; the events series in charts |
| Pellet peach | `#FFB8AE` on frightened blue | `#FFD9D3` on frightened blue | the acknowledged ("frightened") status, nothing else |
| Frightened blue | `#1C1CA8` | `#1C1CA8` | acknowledged alerts (see S7b-05) |
| Text | `#F2F0EA` warm white (18.4:1), muted `#A9A9C2` (9.1:1) | `#0B0B14`, muted `#4C4C66` | warm white, not pure white, so long reading on black does not bloom |

### Type

| Face | Licence | Role |
| --- | --- | --- |
| Atkinson Hyperlegible Next (variable 200 to 800) | SIL OFL 1.1, Braille Institute | the one UI face: every label, table, heading and paragraph. Designed for low-vision readers, so `l`, `I`, `1`, `|` and `0`, `O` never look alike: exactly the confusions that matter in IP addresses, host names and user names. It has tabular figures (`tnum`), switched on for the whole interface |
| Atkinson Hyperlegible Mono (variable 200 to 800) | SIL OFL 1.1 | only raw log lines, ids (UUIDs, keys), YAML, commands and field names; the same skeleton as the UI face, so switching between them does not jar |
| Corridor (drawn, see above) | part of Centinela, MIT | the wordmark and the Overview scoreboard numbers only; never body text or tables |

The font files are the Latin and Latin Extended subsets from Fontsource 5.3.0, vendored with their licences in `packages/web/src/assets/fonts/` and served from the same origin, so the Content Security Policy keeps `font-src 'self'`. This supersedes ARCHITECTURE §11's "monospace from the system stack, no web font downloads": a self-hosted face makes no third-party request either, and it gives raw logs the same unambiguous glyphs on every operating system. Host names, IP addresses and user names move from monospace to the UI face (which already tells similar glyphs apart and has tabular figures); monospace stays for raw lines, ids and code, as David asked.

## S7b-04 — Design plan (2026-10-27, S7b)

### Principles

1. **Each page answers one question first**, in the first screen, before anything else.
2. **Structure, not boxes.** Pages sit on black and are organised with blue hairlines, spacing and alignment. The arcade maze wall (a blue double stroke with rounded corners) frames **one area per page: the area that answers that page's question.** Everything else is open.
3. **Each colour has one job** (palette table). If something is yellow, the analyst can act on it or is on it; if it is red, it is dangerous.
4. **Severity never relies on colour**: every level shows a label and a five-pip meter (one pip for informational, five for critical), so a column of levels reads as a bar chart even in greyscale.
5. **Plain words.** Sentence case, no all-caps labels, no `·` separators, the same verb for the same action everywhere.

### Scales

- Type (root 87.5%, so 14 px follows the browser's font-size setting): 12 caption (axis ticks, pips captions), 13 secondary, 14 body and tables, 16 section headings and lead text, 22 page titles, 40 to 56 Corridor numerals. Weights: 400 text, 600 headings, labels and buttons, 700 emphasis.
- Spacing: multiples of 4 px (4, 8, 12, 16, 24, 32, 48). Page gutter 16 px on phones, 32 px from 1024 px.
- Radii by hierarchy: 14 px for the maze-wall frame, 8 px for drawers, menus and toasts, 6 px for controls, 4 px for badges and chips, 1 px for pips.
- Motion: only in answer to an action (drawer slide 160 ms, button press 1 px); none at all under `prefers-reduced-motion`.

### Components

- **Buttons** in four kinds with the same heights (36 px, 30 px small; the hit area is never under 24 px): primary (yellow fill, black text), secondary (blue outline), quiet (text only), destructive (red outline that fills red on hover). Each has designed hover, pressed (1 px down, darker fill), focus-visible (yellow ring with a black gap), disabled (flat dark fill, dim text, not just transparency) and loading (spinner in place of the icon, `aria-busy`, a progressive label such as "Signing in…") states.
- **Inputs, selects and checkboxes** share the 36 px height, the blue control border, the yellow focus ring and the red error state; selects get a drawn chevron and checkboxes a drawn yellow check, so they look the same in every browser.
- **Segmented controls** (language, ATT&CK colouring): the selected segment is yellow, because selection is yellow.
- **Badges**: severity (pips and label; the critical label is red), status (new: bright dot and bold label; acknowledged: frightened blue; closed: check and muted label).
- **Tables**: 40 px rows, sentence-case sticky headers on a blue rule, right-aligned tabular numbers, long values cut with an ellipsis that shows the full value on hover (tooltip) and on keyboard focus (the focused row expands).
- **Drawer and toasts** on a near-black raised surface with a blue edge; the drawer's leading edge is a maze wall.
- **Empty states** are calm: an icon, one sentence saying what is going on, one saying what to do next. Never a dashed box.
- **Icons**: one set (Lucide), 1.75 px stroke, 16 or 20 px, always next to text or with an accessible name. External links lose their arrow icon; their text says where they go.

### Shell

- Desktop: a left rail and the workspace. The rail holds, from top to bottom, the lockup, the navigation (the current page has a yellow pip and bold label), and a footer grouped in three labelled parts: **System** (one status line: connected, reconnecting or API problem, with the detail on the second line), **Display** (language EN/ES and theme) and **Account** (user name and sign out). That removes the crowded header entirely and gives every control a home a first-time user can predict. The rail's edge is a maze wall.
- Phone (under 768 px): a top bar with the lockup, the status dot and a menu button that opens the same rail as a sheet.

### Pages

- **Overview: "what needs my attention now?"** A maze-framed scoreboard first: new alerts, new critical, new high (Corridor numerals) and acknowledged, then "Start with these": up to five new alerts, most severe first, each a full-width link showing level, title, host, user or IP and how long ago; a yellow "Review new alerts" button. Then Activity: events and alerts over time, each with its total and a plain-language trend against the previous period of the same length ("12% more than the previous 24 hours"). Then "Where alerts come from": by level, top source IPs, top users, top rules, as four ranked lists divided by blue rules. Axis widths are measured from the largest label, so four-digit counts fit.
- **Alerts: "which alert do I look at next?"** Filters in one quiet band (chips apply at once, text filters on Enter), then the bulk action bar, then the table. Acknowledged rows carry the frightened badge.
- **Alert detail: "what happened, to which host and user, and what do I do next?"** Breadcrumb, level and status, title. Left: the maze-framed "What happened" (the rule's description, then host, user, source IP, first and last seen with the duration, matches, ATT&CK techniques by name), the grouped timeline, the rule and its DRL attribution, and a collapsed "Technical details" (alert id, rule id, group key, deduplication key, timestamps). Right, beside the facts: "What to do next", the triage actions and the playbook. Identical consecutive timeline events fold into one line ("46 failed sign-ins from 203.0.113.77 for deploy between 8:18:00 and 8:20:19") that expands.
- **ATT&CK: "which techniques have we seen, and where are we blind?"** Shows only techniques with activity by default ("Show all techniques" brings the full matrix back); cells name the technique first and show the id second, in monospace; zero cells are quiet text; alert counts use a pink scale ("where the threats showed up"), rule coverage a blue scale ("the ground we guard"). Tactic headers stay visible while scrolling.
- **Events, Rules, Ingest, Security**: the shared table and form system; Windows users shown as `DOMAIN\name`; the audit table gets fixed column widths.
- **Sign-in**: the large lockup, a one-line description of the product, the maze-framed form, language and theme at the top.

### The one memorable element

The Overview scoreboard: the number of new alerts drawn in Corridor numerals inside a maze wall, the first thing anyone sees after signing in. It is where the arcade idea earns its place, and it answers the page's question.

### Critique of this plan against David's brief (before building)

- *Black base, structure not grey cards*: yes; the only raised surfaces are the drawer, menus and toasts, which float above content.
- *Each primary has one job*: checked component by component. Two traps found and fixed in the plan: success outcomes were green (no green in the palette; now a neutral check icon and label) and the old accent coloured chart bars (now cyan and pink, which are chart colours).
- *Pink, cyan, orange for severities and charts*: high orange, medium pink, low cyan; informational is neutral grey because it is not a threat level.
- *One symbolic touch*: the frightened blue on acknowledged alerts, nothing else. Considered and dropped as theme-park: pellet-dot dividers, a dot-matrix display font (Doto was tested: arcade, but the dotted digits read worse than Corridor at a glance), ghost-like empty-state art.
- *Nothing AI-looking*: no identical cards, no uppercase labels above headings, no gradients, no emoji, no arrow suffixes, no `·`.
- *Fonts self-hosted under open licences*: OFL files vendored with their licence texts; Corridor is ours.
- *First-time user*: every page now leads with its question; the alert page explains itself in a sentence before showing internals.
- *Risk*: moving status, language, theme and sign-out into the rail changes where tests find them; the tests move with them. The ATT&CK default changes from "all techniques" to "only active"; the URL keeps the choice (`?all=1`).

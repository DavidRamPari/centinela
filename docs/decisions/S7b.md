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

Variants (drawn by `packages/web/src/components/brand/`; standalone files in `packages/web/public/brand/` and `public/favicon.svg`, generated from the same geometry, S7b-12):

| Variant | Use |
| --- | --- |
| Full colour on black | default: sidebar, sign-in page, favicon (`favicon.svg` has its own black tile, so it reads on light browser tabs too) |
| Full colour on white | light theme: the yellow piece gains a thin dark keyline and the wordmark is written in ink (`#0B0B14`), because yellow alone disappears on white; the mark still carries all three primaries |
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
- Spacing: Tailwind's quarter-rem steps (3.5 px at the default 14 px root), mostly 1, 1.5, 2, 3 and 4 rem between groups. Page gutter 1 rem on phones, 1.5 rem on tablets, 2 to 2.5 rem next to the rail.
- Radii by hierarchy: 14 px for the maze-wall frame, 8 px for drawers, menus and toasts, 6 px for controls, 4 px for badges and chips, 1 px for pips.
- Motion: only in answer to an action (drawer slide 160 ms, button press 1 px); none at all under `prefers-reduced-motion`.

### Components

- **Buttons** in four kinds with the same heights (35 px, and 28 px small: 2.5 and 2 rem at the default 14 px root; the hit area is never under 24 px): primary (yellow fill, black text), secondary (blue outline), quiet (text only), destructive (red outline that fills red on hover). Each has designed hover, pressed (1 px down, darker fill), focus-visible (yellow ring with a black gap), disabled (flat dark fill, dim text, not just transparency) and loading (spinner in place of the icon, `aria-busy`, a progressive label such as "Signing in…") states.
- **Inputs, selects and checkboxes** share the 35 px height, the blue control border, the yellow focus ring and the red error state; selects get a drawn chevron and checkboxes a drawn yellow check, so they look the same in every browser.
- **Segmented controls** (language, theme, ATT&CK colouring): the selected segment takes the selection treatment, a yellow edge on a dark yellow tint, the same as selected table rows. A solid yellow fill was tried first and competed with the page's primary button.
- **Badges**: severity (pips and label; the critical label is red), status (new: bright dot and bold label; acknowledged: frightened blue; closed: check and muted label).
- **Tables**: 40 px rows, sentence-case sticky headers on a blue rule, right-aligned tabular numbers, long values cut with an ellipsis that shows the full value on hover (tooltip) and on keyboard focus (the focused row expands).
- **Drawer and toasts** on a near-black raised surface with a blue edge; the drawer's leading edge is a maze wall.
- **Empty states** are calm: an icon, one sentence saying what is going on, one saying what to do next. Never a dashed box.
- **Icons**: one set (Lucide), 1.75 px stroke, 16 or 20 px, always next to text or with an accessible name. External links lose their arrow icon; their text says where they go.

### Shell

- Desktop: a left rail and the workspace. The rail holds, from top to bottom, the lockup, the navigation (the current page has a yellow pip and bold label), and a footer grouped in three labelled parts: **System** (live updates and API status, one line each), **Preferences** (language and theme) and **Account** (user name and sign out). That removes the crowded header entirely and gives every control a home a first-time user can predict. The rail's edge is a maze wall.
- Under 1024 px: a top bar with the lockup and a menu button that opens the same rail as a sheet (S7b-06).

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

## S7b-05 — The one arcade touch: acknowledged alerts turn "frightened" blue (2026-10-27, S7b)

In the game, threats turn deep blue when the hero can catch them. In Centinela the acknowledged status badge is a deep blue fill (`#1C1CA8`) with pellet-peach text (7.1:1): the threat has been seen and someone is on it. New alerts are bright (a white dot and a bold label), closed ones step back (a check and muted text). Nothing else borrows from the game: no pellet dividers, no maze sprites, no sounds.

## S7b-06 — Shell: a rail with grouped controls, from 1024 px (2026-10-27, S7b)

The crowded header is gone. The rail carries the navigation and, at its foot, three labelled groups: System (live updates, API), Preferences (language, theme) and Account (user, sign out). Language is a two-button control whose labels are written in their own language (English, Español, each with its `lang`), and theme is Dark or Light, so the current state is always visible instead of hidden behind an icon. The rail only shows from 1024 px: at 768 px it left 480 px for tables. Below 1024 px a top bar opens the rail as a sheet (Escape and following a link close it; focus moves into it and back to the menu button). The rail sits in a full-height wrapper so its maze wall runs the whole page.

## S7b-07 — Tables and lists size themselves by container, not by viewport (2026-10-27, S7b)

With a rail next to the content, viewport breakpoints lie about the room a table has. `DataTable` is a Tailwind `@container`, and columns hide with container variants (`@xl:table-cell`, `@3xl:table-cell`…); the Overview's "Start with these" rows switch layout the same way. Headers are sticky from 768 px (the wrapper uses `overflow-x: clip` there, which keeps sticky working; narrower screens scroll the table sideways). Long values are cut with an ellipsis by `Truncate`: the full value is in a tooltip on hover and, when a row has keyboard focus, the row expands to show it, so keyboard users see what mouse users see. On phones the alert's status and age move under its title.

## S7b-08 — Overview data without API changes (2026-10-27, S7b)

The scoreboard counts come from `GET /api/alerts?status=new&limit=200` in the selected range (critical and high counted from that page; a full page shows as "200+"), plus `byStatus.acknowledged` from the stats. "Start with these" sorts the same page most severe first, then newest. Each activity total is compared with the previous period of the same length, fetched with a second `GET /api/stats/overview` (`previousPeriod` in `lib/time-range.ts`), and said in words and neutral colour ("8% fewer than the previous 24 hours"): more events is not bad news by itself, and red means danger. The y axis width is measured from the largest label (`features/overview/axis.ts`), which fixes the clipped "1,500" S4 reported.

## S7b-09 — Alert detail: facts first, internals folded, playbook beside (2026-10-27, S7b)

"What happened" (the page's maze frame) holds the rule's description, then host, users, source IPs, when (a range with its length), times matched and ATT&CK techniques by name. The timeline folds consecutive events with the same host, action, outcome and source IP when there are at least three of them ("40 failed sign-ins from 203.0.113.77 as deploy between 8:18:00 AM and 8:20:19 AM", or "for 25 users" for a password spray); two identical lines are not worth folding, because the fold hides what differs between them (the webshell's `whoami` and `net user`). Actions are named in words in both languages (`timeline.what.*`), with the raw action as a fallback. Alert id, rule id, group key, deduplication key and timestamps sit in a native `<details>` "Technical details". The right column, "What to do next", has the triage actions (with a sentence saying where the alert stands and what comes next) and the playbook. Playbook sections now lead with the triage and response steps, then false positives, then what it detects, why it matters and why this level: the page already explains what happened, so the playbook starts with what to do. A rule without a playbook gets a calm explanation that depends on its origin: Centinela's own rules ("on the way, in a later release") or a SigmaHQ rule the content pack skipped.

## S7b-10 — ATT&CK: active techniques by default, names first (2026-10-27, S7b)

The matrix used to open as 14 columns and 4,000 px of "Alerts: 0". It now shows only techniques with activity and folds away tactics without any, saying how many it hid; "Show all techniques" (`?all=1`, replacing S3's `?active=1`) brings the full matrix back. Cells name the technique first and show the id second in monospace; empty cells are plain text and still say "0 rules" to screen readers. Alert counts use a pink scale and rule coverage a blue one. Visible tactics share the width (an inline `grid-template-columns`, set through the CSSOM, which the CSP allows) and the page scrolls sideways only when they cannot fit. The legend's ranges now follow `heatLevel` exactly; S3's legend computed them differently and showed overlapping ranges ("1–2", "2–3"). On the alert and rule pages, technique lists wait for the ATT&CK names before rendering, so ids never flash before names.

## S7b-11 — Fonts vendored, not installed (2026-10-27, S7b)

The four WOFF2 files (Atkinson Hyperlegible Next and Mono, Latin and Latin Extended, variable weight 200 to 800, from Fontsource 5.3.0) and their SIL OFL 1.1 texts live in `packages/web/src/assets/fonts/`; `index.css` declares them with `unicode-range`, so Latin Extended only loads when a page needs it (about 52 kB of fonts for an English or Spanish page). Vendoring rather than adding the Fontsource packages keeps the licences next to the files, adds no runtime dependency and leaves `package-lock.json` untouched. Vite serves them from `/assets/`, so `font-src 'self'` holds. The Next face has tabular figures, turned on for the whole page; its slashed zero and distinct `l`/`I`/`1` are why it was chosen for IP addresses and host names. ARCHITECTURE §11's "monospace from the system stack, no web font downloads" is updated in the same change.

## S7b-12 — The brand is drawn, and its files are generated (2026-10-27, S7b)

The mark (`Mark`), the wordmark (`Wordmark`, `Lockup`) and the scoreboard numerals (`CorridorNumber`) are SVG drawn from one geometry module (`mark-paths.ts`, `corridor.ts`). `npx tsx packages/web/scripts/brand-assets.ts` writes the standalone files (mark on black, on white and in one colour, three lockups, and the favicon), and `test/brand.test.ts` fails when a file no longer matches the components or contains a script or external reference. A Corridor number keeps its formatted text in the DOM (visually hidden), so screen readers and copy-paste get "64,213".

## S7b-13 — Component decisions (2026-10-27, S7b)

- `Button` has four variants (primary, secondary, quiet, danger; S3's `ghost` became `quiet`), two sizes, an `icon` prop and a `loading` prop that keeps the colours, shows a spinner and sets `aria-busy`. Disabled buttons get a flat dark fill rather than transparency.
- The sign-in button is no longer disabled until both fields are filled: a grey primary made the page look broken. Submitting empty fields says "Enter your user name and password." and marks the fields invalid.
- Checkboxes and the file picker are drawn. The native file input printed "Choose File / No file chosen" in the browser's language, not the app's.
- External links lose the arrow icon David asked to avoid; their text says where they go and screen readers hear "(opens in a new tab)".
- Severity badges show five pips plus the label (the label is red only for critical); outcomes show a check, a cross or a question mark next to the word.
- Empty states are an icon, a sentence on what is going on and one on what to do next, with no dashed box. Errors keep `role="alert"` with a red rule on the left and a retry.
- Motion: the drawer, the phone sheet and toasts slide in for 160 ms; everything stops under `prefers-reduced-motion`.

## S7b-14 — Tests (2026-10-27, S7b)

Kept: contrast, i18n parity, hostile strings, keyboard tables and drawer, CSP. Changed with the redesign: the theme test now checks text pairs at 4.5:1 and graphical pairs (control borders, focus ring, pips, chart colours, the yellow button's edge) at 3:1, and that the dark base is true black; the i18n test understands plural keys (`x_one`/`x_other`) and requires the same plural forms in both languages; tests that looked for the old header controls, copy or ATT&CK default follow the new ones; the hostile-string and timeline tests open folded timeline groups before looking for raw lines. Added: `test/presentation.test.tsx` (timeline folding and its sentences in both languages, Windows users as `DOMAIN\name`, previous-period and trend maths, axis widths, urgency order, Corridor glyph coverage, accessible drawn numbers, mark variants) and `test/brand.test.ts`.

## S7b-15 — Known gaps (2026-10-27, S7b)

- Alert entities carry user names without their Windows domain. The alert page maps them to `DOMAIN\name` through the alert's own events; the alerts table, which has no events, shows the bare name.
- The scoreboard counts the first 200 new alerts of the range and shows "200+" beyond that; an exact count would need a count in the API, which this session does not change.
- The y-axis width is estimated from the label length (7.2 px per character at 12 px), not measured from the rendered text.
- Toast colour and placement were reviewed with one live alert; a burst of alerts stacks at most four toasts, as before.

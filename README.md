# Hoppr Landing

Marketing landing page for Hoppr — "for people who never know where to go."

Sections: hero, how-it-works ("it learns"), decision-fatigue callout, swipeable
picks demo, menu-picker demo, group ("together") mode, an interactive
"try Hoppr" quiz, social proof marquee, and an email waitlist form.

## Files

- `index.html` — the page itself. Sourced from Claude Design (`Hoppr Landing.dc.html`).
- `support.js` — the DC (Design Compiler) runtime. On `DOMContentLoaded` it
  loads React, ReactDOM, and Babel Standalone from unpkg, transpiles the
  inline component script in `index.html`, and mounts the page. No build
  step or bundler involved.
- `hoppr-lockup-v2-trimmed.png`, `hoppr-mark.png`, `hoppr-wordmark-v2-trimmed.png` —
  brand assets referenced by `index.html`.

## Running locally

Static site, no build step. Serve the directory and open it:

```bash
python3 -m http.server 8934
# then visit http://localhost:8934/index.html
```

Requires internet access on first load (React/ReactDOM/Babel are fetched
from unpkg at runtime).

## Editing

The page content, copy, and component logic all live in `index.html`:
- Markup/styling: inside the `<x-dc>...</x-dc>` template.
- Behavior/state: inside the `<script type="text/x-dc" data-dc-script>` block
  (a single `Component extends DCLogic` class — scroll-linked reveals, the
  hero/menu/together demo animations, the waitlist form, etc).

To pull future updates from the source Claude Design project, re-export
`Hoppr Landing.dc.html` and replace `index.html` (keeping the `support.js`
`<script>` tag and relative image paths intact).
# hoppr_landing

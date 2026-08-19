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
- `supabase/schema.sql` — waitlist table, RLS, and the `join_waitlist` RPC.
  Paste into the Supabase SQL Editor for a new project.
- `supabase/functions/send-confirmation/index.ts` — Edge Function that sends
  the waitlist confirmation email via Resend, triggered by a Database Webhook
  on `waitlist` INSERT.

## Waitlist backend (Supabase)

The waitlist form submits to a Supabase project via `supabase-js` (loaded
from CDN in `index.html`, no build step needed). To run it locally end to
end:

1. Create a Supabase project, run `supabase/schema.sql` in its SQL Editor.
2. In `index.html`, replace the placeholder `supabaseClient` URL/anon key
   (search for `YOUR-PROJECT-REF`) with your project's values from
   Project Settings → API. The anon key is meant to be public and is safe to
   ship in client code — access is restricted entirely by the RLS policy
   (none) and the `join_waitlist` RPC, not by hiding the key.
3. To get confirmation emails working: create a Resend account/API key,
   deploy `supabase/functions/send-confirmation` (`supabase functions deploy
   send-confirmation`), set it as an Edge Function secret
   (`supabase secrets set RESEND_API_KEY=...`), and add a Database Webhook
   on `waitlist` INSERT pointing at that function.

Without step 3, signups still work — email sending is decoupled via the
webhook and failing/missing email config doesn't block the form.

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

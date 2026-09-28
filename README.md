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
- `supabase/schema.sql` — waitlist/cohort/notification/audit tables, RLS, the
  `join_waitlist`, `release_waitlist_batch`, and `claim_waitlist_invite` RPCs,
  and a per-IP rate limit on signups. Paste into the Supabase SQL Editor for a
  new project (safe to re-run; uses `if not exists` / `or replace`).
- `claim.html` — the page an invitation link points to. Calls
  `claim_waitlist_invite`, then redirects to the cohort's `app_url`.
- `supabase/functions/send-confirmation/index.ts` — Edge Function that sends
  the waitlist confirmation email via Resend, triggered by a Database Webhook
  on `waitlist` INSERT.
- `supabase/functions/send-otp/index.ts`, `verify-otp/index.ts` — phone
  verification. The waitlist form calls `send-otp` right after signup when a
  member opted into SMS; `verify-otp` checks the 6-digit code the user enters.
  Both are public (no Supabase Auth session) but give deliberately generic
  responses so they can't be used to enumerate members.
- `supabase/functions/send-invitation/index.ts` — internal-only (shared-secret
  header), called by `admin-release` for each newly invited member. Sends the
  access email always, and an SMS reminder only if that number is verified,
  consented, and not unsubscribed.
- `supabase/functions/admin-release/index.ts` — admin-only (shared-secret
  header). Calls `release_waitlist_batch` for a cohort/limit, then triggers
  `send-invitation` for each invited member. This is the "release a batch"
  button — call it directly, there's no UI for it (see below).
- `supabase/functions/sms-inbound/index.ts` — Twilio's "a message comes in"
  webhook. Handles STOP (revokes SMS consent), START (re-opts in), HELP.

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

## Phone verification, invitations, and admin release (Supabase)

4. Deploy the remaining functions. Supabase's gateway rejects requests
   without a valid `apikey`/`Authorization` header by default; `send-otp`,
   `verify-otp`, and `send-invitation` are called with a real key (anon or
   service role — see below) so they deploy normally, but `sms-inbound`
   (called by Twilio) and `admin-release` (called by you, from outside
   Supabase) can't supply one, so deploy those two with `--no-verify-jwt` and
   rely on their own header checks (`x-twilio-signature` / `x-admin-key`)
   instead:
   ```bash
   supabase functions deploy send-otp
   supabase functions deploy verify-otp
   supabase functions deploy send-invitation
   supabase functions deploy admin-release --no-verify-jwt
   supabase functions deploy sms-inbound --no-verify-jwt
   ```
5. Set secrets (`supabase secrets set KEY=value`):
   - `RESEND_API_KEY`, `EMAIL_FROM` — already needed for `send-confirmation`.
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — for
     `send-otp`, `send-invitation`, and `sms-inbound`. Without these, phone
     signups still work and the checkbox/consent are still recorded — SMS
     just silently doesn't send (logged as `failed` with a clear reason in
     `waitlist_notifications`).
   - `SITE_URL` — the base URL claim links point at (defaults to
     `https://hopwithhoppr.com`). Point it at wherever `claim.html` is actually
     hosted.
   - `INTERNAL_FUNCTION_SECRET` — any random string; shared between
     `admin-release` and `send-invitation` so `send-invitation` can't be
     called from outside.
   - `ADMIN_API_KEY` — any random string; required to call `admin-release`.
6. On the Twilio number, set the "A message comes in" webhook to the deployed
   `sms-inbound` function URL, POST, so STOP/HELP/START are handled.
7. Set each cohort's real app/deep-link destination:
   ```sql
   update cohorts set app_url = 'https://apps.apple.com/...' where slug = 'ann-arbor';
   ```
   `claim_waitlist_invite` reads this at claim time, so the destination can
   change without touching any code.

### Releasing a batch

There's no admin UI — call the function directly with the admin key:

```bash
curl -X POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/admin-release \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"cohort": "ann-arbor", "limit": 50}'
```

This invites the oldest 50 waiting Ann Arbor members (in `created_at, id`
order), gives each a 7-day claim window, and emails/texts them. Queue
position, delivery status, consent, and claim state are all queryable
directly:

```sql
select waitlist_position, email, status, invited_at, claim_deadline, email_delivery_state, sms_delivery_state
from waitlist where cohort = 'ann-arbor' order by waitlist_position;

select * from waitlist_notifications where waitlist_id = '...' order by created_at desc;
select * from waitlist_audit_log where waitlist_id = '...' order by created_at desc;
```

To manually resend an invitation or revoke one, update `waitlist.status` /
`claim_deadline` directly in SQL, or clear `invited_at`/`invitation_token_hash`
to return someone to `waiting` so the next `admin-release` batch picks them up
again. Expired, unclaimed invites already return to the queue automatically —
`release_waitlist_batch` sweeps them (and logs `invitation_expired`) at the
start of every run.

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

// Admin-only: invites the next batch of waiting members for a cohort. Calls
// release_waitlist_batch (service role, bypasses RLS) then triggers
// send-invitation for each newly invited member. Never exposed to the browser
// — call it directly (curl/Postman) with the admin key. Queue viewing, delivery
// status, and manual resend/revoke are done via the Supabase SQL editor against
// waitlist / waitlist_notifications / waitlist_audit_log.
// Configure ADMIN_API_KEY and INTERNAL_FUNCTION_SECRET (shared with send-invitation).

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const adminKey = Deno.env.get('ADMIN_API_KEY');
    if (!adminKey || req.headers.get('x-admin-key') !== adminKey) {
      return new Response('unauthorized', { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const cohort = String(body.cohort || 'ann-arbor');
    const limit = Number(body.limit || 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return new Response(JSON.stringify({ error: 'limit must be an integer between 1 and 500' }), { status: 400 });
    }

    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/release_waitlist_batch`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_cohort: cohort, p_limit: limit }),
    });
    if (!rpcRes.ok) {
      const errBody = await rpcRes.text();
      return new Response(JSON.stringify({ error: 'release_failed', detail: errBody.slice(0, 1000) }), { status: 500 });
    }
    const invited: Array<{ member_id: string; email: string; first_name: string | null; invitation_token: string; claim_deadline: string }> = await rpcRes.json();

    const internalSecret = Deno.env.get('INTERNAL_FUNCTION_SECRET') || '';
    const results = await Promise.allSettled(
      invited.map((row) =>
        fetch(`${supabaseUrl}/functions/v1/send-invitation`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': internalSecret,
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ ...row, cohort }),
        })
      )
    );
    const notified = results.filter((r) => r.status === 'fulfilled' && (r.value as Response).ok).length;

    return new Response(JSON.stringify({ ok: true, invited: invited.length, notified, cohort }));
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
});

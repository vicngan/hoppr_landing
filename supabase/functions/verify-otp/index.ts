// Verifies a one-time SMS code and marks the phone as verified. Only after this
// succeeds may future SMS (invitation reminders) be sent to that number.

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const MAX_ATTEMPTS = 5;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sb(path: string, init: RequestInit = {}) {
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function normalizeEmail(email: unknown): string | null {
  const v = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: corsHeaders });
    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const phone = String(body.phone || '').replace(/[^0-9+]/g, '');
    const code = String(body.code || '').trim();
    if (!email || !/^\+[1-9][0-9]{7,14}$/.test(phone) || !/^\d{6}$/.test(code)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_request' }), { status: 400, headers: corsHeaders });
    }

    const memberRes = await sb(`waitlist?email=eq.${encodeURIComponent(email)}&select=id,phone_e164,phone_verified_at`);
    const members = await memberRes.json();
    const member = Array.isArray(members) ? members[0] : null;
    const fail = new Response(JSON.stringify({ ok: false, error: 'invalid_or_expired_code' }), { status: 400, headers: corsHeaders });
    if (!member || member.phone_e164 !== phone) return fail;
    if (member.phone_verified_at) return new Response(JSON.stringify({ ok: true, already_verified: true }), { headers: corsHeaders });

    const activeRes = await sb(
      `phone_verification_codes?waitlist_id=eq.${member.id}&consumed_at=is.null&expires_at=gt.${new Date().toISOString()}&order=created_at.desc&limit=1`
    );
    const active = await activeRes.json();
    const record = Array.isArray(active) ? active[0] : null;
    if (!record) return fail;
    if (record.attempts >= MAX_ATTEMPTS) return fail;

    const codeHash = await sha256Hex(code);
    if (codeHash !== record.code_hash) {
      await sb(`phone_verification_codes?id=eq.${record.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ attempts: record.attempts + 1 }),
      });
      return fail;
    }

    await sb(`phone_verification_codes?id=eq.${record.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ consumed_at: new Date().toISOString() }),
    });
    await sb(`waitlist?id=eq.${member.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ phone_verified_at: new Date().toISOString() }),
    });
    await sb('waitlist_audit_log', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ waitlist_id: member.id, event_type: 'phone_verified' }),
    });

    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ ok: false, error: 'server_error' }), { status: 500, headers: corsHeaders });
  }
});

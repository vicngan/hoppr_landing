// Sends a one-time SMS verification code for a waitlist member's phone number.
// Callable from the browser (no Supabase Auth session needed) but only ever
// acts on a row that already has matching email + phone + recorded consent —
// it never returns any waitlist data, so it can't be used to enumerate members.
// Configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CODE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  return res;
}

function normalizeEmail(email: unknown): string | null {
  const v = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const phone = String(body.phone || '').replace(/[^0-9+]/g, '');
    if (!email || !/^\+[1-9][0-9]{7,14}$/.test(phone)) {
      return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 });
    }

    const memberRes = await sb(`waitlist?email=eq.${encodeURIComponent(email)}&select=id,phone_e164,sms_consent,phone_verified_at,sms_unsubscribed_at`);
    const members = await memberRes.json();
    const member = Array.isArray(members) ? members[0] : null;
    // Deliberately generic response: never reveal whether the email exists,
    // whether the phone matched, or whether it's already verified.
    const genericOk = new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (!member || member.phone_e164 !== phone || !member.sms_consent || member.sms_unsubscribed_at) {
      return genericOk;
    }
    if (member.phone_verified_at) return genericOk;

    const recentRes = await sb(
      `phone_verification_codes?waitlist_id=eq.${member.id}&consumed_at=is.null&order=created_at.desc&limit=1&select=created_at`
    );
    const recent = await recentRes.json();
    if (Array.isArray(recent) && recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
      return genericOk;
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await sha256Hex(code);
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

    await sb('phone_verification_codes', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ waitlist_id: member.id, code_hash: codeHash, expires_at: expiresAt }),
    });

    const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const token = Deno.env.get('TWILIO_AUTH_TOKEN');
    const from = Deno.env.get('TWILIO_FROM_NUMBER');
    if (sid && token && from) {
      const twilioRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: phone, From: from, Body: `Your Hoppr verification code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.` }),
      });
      const twilioBody = await twilioRes.json().catch(() => ({}));
      await sb('waitlist_notifications', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          waitlist_id: member.id, channel: 'sms', event_type: 'otp_sent',
          status: twilioRes.ok ? 'sent' : 'failed',
          provider_message_id: twilioBody.sid || null,
          error_detail: twilioRes.ok ? null : JSON.stringify(twilioBody).slice(0, 1000),
          attempts: 1, sent_at: twilioRes.ok ? new Date().toISOString() : null,
        }),
      });
    }

    return genericOk;
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
});

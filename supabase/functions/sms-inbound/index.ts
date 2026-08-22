// Twilio inbound-SMS webhook. Handles STOP (revokes SMS consent so no future
// invite/OTP messages go out) and HELP (replies with support info). Configure
// this URL as the "A message comes in" webhook on the Twilio number, and set
// TWILIO_AUTH_TOKEN so requests can be verified as genuinely from Twilio.

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function sb(path: string, init: RequestInit = {}) {
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function verifyTwilioSignature(req: Request, url: string, params: Record<string, string>): Promise<boolean> {
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
  const signature = req.headers.get('x-twilio-signature');
  if (!authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

function twiml(message?: string) {
  const body = message ? `<Message>${message.replace(/[<>&]/g, '')}</Message>` : '';
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status: 200, headers: { 'Content-Type': 'text/xml' },
  });
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const rawBody = await req.text();
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const webhookUrl = Deno.env.get('SMS_INBOUND_URL') || req.url;
    if (!(await verifyTwilioSignature(req, webhookUrl, params))) {
      return new Response('unauthorized', { status: 401 });
    }

    const from = String(params.From || '').trim();
    const text = String(params.Body || '').trim().toLowerCase();
    if (!from) return twiml();

    if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/.test(text)) {
      const nowIso = new Date().toISOString();
      const res = await sb(`waitlist?phone_e164=eq.${encodeURIComponent(from)}&sms_unsubscribed_at=is.null&select=id`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ sms_unsubscribed_at: nowIso }),
      });
      const updated = await res.json().catch(() => []);
      for (const row of Array.isArray(updated) ? updated : []) {
        await sb('waitlist_audit_log', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ waitlist_id: row.id, event_type: 'sms_unsubscribed' }),
        });
      }
      return twiml("You're unsubscribed from Hoppr SMS alerts and won't receive more texts. Reply START to opt back in.");
    }

    if (text === 'start') {
      const res = await sb(`waitlist?phone_e164=eq.${encodeURIComponent(from)}&select=id`);
      const rows = await res.json().catch(() => []);
      const member = Array.isArray(rows) ? rows[0] : null;
      if (member) {
        await sb(`waitlist?id=eq.${member.id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ sms_unsubscribed_at: null, sms_consent: true, sms_consent_at: new Date().toISOString() }),
        });
        await sb('waitlist_audit_log', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ waitlist_id: member.id, event_type: 'sms_resubscribed' }),
        });
      }
      return twiml("You're re-subscribed to Hoppr SMS alerts.");
    }

    if (text === 'help') {
      return twiml('Hoppr waitlist alerts. Msg & data rates may apply. Reply STOP to unsubscribe. Support: hello@hoppr.app');
    }

    return twiml();
  } catch (error) {
    console.error(error);
    return twiml();
  }
});

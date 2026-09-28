// Sends a first-release invitation: always an email with the claim link, and an
// SMS reminder only when the number is verified, opted in, and not unsubscribed.
// Internal-only — called by admin-release right after release_waitlist_batch,
// authenticated with a shared secret rather than exposed to the browser.
// Configure RESEND_API_KEY, EMAIL_FROM, SITE_URL, INTERNAL_FUNCTION_SECRET, and
// (for SMS) TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function sb(path: string, init: RequestInit = {}) {
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function logNotification(waitlistId: string, channel: 'email' | 'sms', status: string, providerId?: string, error?: string) {
  await sb('waitlist_notifications', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      waitlist_id: waitlistId, channel, event_type: 'invited', status,
      provider_message_id: providerId, error_detail: error, attempts: 1,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
    }),
  });
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const internalSecret = Deno.env.get('INTERNAL_FUNCTION_SECRET');
    if (!internalSecret || req.headers.get('x-internal-secret') !== internalSecret) {
      return new Response('unauthorized', { status: 401 });
    }
    const body = await req.json();
    const { member_id, email, first_name, invitation_token, claim_deadline, cohort } = body;
    if (!member_id || !email || !invitation_token) {
      return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 });
    }

    const memberRes = await sb(`waitlist?id=eq.${member_id}&select=phone_e164,sms_consent,phone_verified_at,sms_unsubscribed_at`);
    const rows = await memberRes.json();
    const member = Array.isArray(rows) ? rows[0] : null;

    const siteUrl = Deno.env.get('SITE_URL') || 'https://hopwithhoppr.com';
    const claimLink = `${siteUrl.replace(/\/$/, '')}/claim.html?token=${encodeURIComponent(invitation_token)}`;
    const name = String(first_name || 'there').replace(/[<>&"']/g, '');
    const deadline = new Date(claim_deadline);
    const deadlineText = isNaN(deadline.getTime()) ? 'in 7 days' : `by ${deadline.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;

    const apiKey = Deno.env.get('RESEND_API_KEY');
    const from = Deno.env.get('EMAIL_FROM');
    if (apiKey && from) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: email, subject: "Your Hoppr spot is ready",
          html: `<p>Hey ${name},</p><p>Your spot in the Hoppr ${cohort || 'Ann Arbor'} waitlist just opened. Claim it ${deadlineText}:</p><p><a href="${claimLink}">${claimLink}</a></p><p>After that the spot goes back into the queue.</p><p>— The Hoppr team</p>`,
        }),
      });
      const resBody = await res.json().catch(() => ({}));
      await logNotification(member_id, 'email', res.ok ? 'sent' : 'failed', resBody.id, res.ok ? undefined : JSON.stringify(resBody).slice(0, 1000));
      await sb(`waitlist?id=eq.${member_id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ email_delivery_state: res.ok ? 'sent' : 'failed' }),
      });
    } else {
      await logNotification(member_id, 'email', 'failed', undefined, 'Email provider is not configured');
    }

    const canSms = member && member.phone_e164 && member.sms_consent && member.phone_verified_at && !member.sms_unsubscribed_at;
    if (canSms) {
      const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
      const token = Deno.env.get('TWILIO_AUTH_TOKEN');
      const smsFrom = Deno.env.get('TWILIO_FROM_NUMBER');
      if (sid && token && smsFrom) {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: member.phone_e164, From: smsFrom, Body: `Hoppr: your spot is open! Claim it ${deadlineText}: ${claimLink} Reply STOP to unsubscribe.` }),
        });
        const resBody = await res.json().catch(() => ({}));
        await logNotification(member_id, 'sms', res.ok ? 'sent' : 'failed', resBody.sid, res.ok ? undefined : JSON.stringify(resBody).slice(0, 1000));
        await sb(`waitlist?id=eq.${member_id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ sms_delivery_state: res.ok ? 'sent' : 'failed' }),
        });
      } else {
        await logNotification(member_id, 'sms', 'failed', undefined, 'SMS provider is not configured');
      }
    }

    return new Response(JSON.stringify({ ok: true }));
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
});

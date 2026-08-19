// Database-webhook handler for waitlist INSERTs. Delivery failures are recorded
// but never make the signup RPC fail. Configure RESEND_API_KEY and EMAIL_FROM.

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function logNotification(record: Record<string, unknown>, status: string, providerId?: string, error?: string) {
  await fetch(`${supabaseUrl}/rest/v1/waitlist_notifications`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ waitlist_id: record.id, channel: 'email', event_type: 'waitlist_joined', status, provider_message_id: providerId, error_detail: error, attempts: 1, sent_at: status === 'sent' ? new Date().toISOString() : null })
  });
  await fetch(`${supabaseUrl}/rest/v1/waitlist?id=eq.${record.id}`, {
    method: 'PATCH',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ email_delivery_state: status })
  });
}

Deno.serve(async (req: Request) => {
  try {
    const { record } = await req.json();
    if (!record?.email || !record?.id) return new Response('invalid webhook payload', { status: 400 });
    const apiKey = Deno.env.get('RESEND_API_KEY');
    const from = Deno.env.get('EMAIL_FROM');
    if (!apiKey || !from) {
      await logNotification(record, 'failed', undefined, 'Email provider is not configured');
      return new Response('accepted', { status: 202 });
    }
    const referralLink = `https://hoppr.app/v/${encodeURIComponent(record.referral_code)}`;
    const name = String(record.first_name || 'there').replace(/[<>&"']/g, '');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: record.email, subject: "You're in the Hoppr waitlist",
        html: `<p>Hey ${name},</p><p>You’re in the Hoppr waitlist for <strong>Ann Arbor</strong>. We’ll email you when your spot opens.</p><p>Your place in line is based on signup time. Share Hoppr with your people: <a href="${referralLink}">${referralLink}</a></p><p>— The Hoppr team</p>`
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      await logNotification(record, 'failed', undefined, JSON.stringify(body).slice(0, 1000));
      return new Response('accepted', { status: 202 });
    }
    await logNotification(record, 'sent', body.id);
    return new Response('ok');
  } catch (error) {
    console.error(error);
    return new Response('accepted', { status: 202 });
  }
});

// Database-webhook handler for waitlist INSERTs. Delivery failures are recorded
// but never make the signup RPC fail. Configure RESEND_API_KEY and EMAIL_FROM.

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Called directly from the browser (index.html), so CORS headers are required
// or the fetch is silently blocked with no error surfaced to the page.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { record } = await req.json();
    if (!record?.email || !record?.id) return new Response('invalid webhook payload', { status: 400, headers: corsHeaders });
    const apiKey = Deno.env.get('RESEND_API_KEY');
    const from = Deno.env.get('EMAIL_FROM');
    if (!apiKey || !from) {
      await logNotification(record, 'failed', undefined, 'Email provider is not configured');
      return new Response('accepted', { status: 202, headers: corsHeaders });
    }
    const referralLink = `https://hopwithhoppr.com/v/${encodeURIComponent(record.referral_code)}`;
    const name = String(record.first_name || 'there').replace(/[<>&"']/g, '');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: record.email,
        subject: `You're on the Hoppr list, ${name} 🎉`,
        html: `
<div style="background:#faf6ef;padding:32px 16px;font-family:'DM Sans',Helvetica,Arial,sans-serif;color:#14110d">
  <div style="display:none;font-size:1px;color:#faf6ef;max-height:0;overflow:hidden">
    Less “what should we do?” More “let’s go.” Your Hoppr invite is inside.
  </div>

  <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#fff;border-radius:20px;padding:36px 32px">
    <tr><td>
      <p style="font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 10px">
        You're officially on the list
      </p>

      <h1 style="font-size:32px;line-height:1.15;margin:0 0 20px">
        Hey ${name}, your next night out starts here. 🐸
      </h1>

      <p style="font-size:16px;line-height:1.7;margin:0 0 18px">
        You know how it goes: someone says, “We should do something tonight,” and then the group chat spends an hour deciding what “something” is.
      </p>

      <p style="font-size:16px;line-height:1.7;margin:0 0 18px">
        That's why we're making Hoppr. We're here to make getting out in Ann Arbor feel easier, more spontaneous, and a lot more fun—especially when you're trying to make a plan with friends.
      </p>

      <p style="font-size:16px;line-height:1.7;margin:0 0 26px">
        And now you're one step closer. You're on the waitlist, and we'll email you as soon as it's your turn to get in.
      </p>

      <div style="background:#faf6ef;border-radius:16px;padding:22px 24px;margin:0 0 26px">
        <p style="font-size:16px;font-weight:700;margin:0 0 12px">
          Here's the plan:
        </p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 10px">
          <strong>1.</strong> Keep an eye on your inbox. We'll let you know when your spot opens.
        </p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 10px">
          <strong>2.</strong> Earlier signups get in first. You're already ahead of everyone who hasn't joined yet.
        </p>
        <p style="font-size:15px;line-height:1.6;margin:0">
          <strong>3.</strong> Share your link with friends to move up the list—and make sure your favorite people are there when you get in.
        </p>
      </div>

      <p style="font-size:16px;line-height:1.7;margin:0 0 22px">
        Think of the friends who are always down to go out, the ones who need a little convincing, and the one who somehow knows every place in town. Send them your link. The best plans are better together.
      </p>

      <a href="${referralLink}" style="display:inline-block;background:#14110d;color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:15px 26px;border-radius:999px">
        Invite your crew →
      </a>

      <p style="font-size:13px;line-height:1.5;color:#77716a;margin:20px 0 0">
        Or copy your personal link:
        <a href="${referralLink}" style="color:#14110d;word-break:break-all">${referralLink}</a>
      </p>

      <p style="font-size:16px;line-height:1.7;margin:32px 0 0">
        We're excited to have you here. Good nights are coming.
      </p>

      <p style="font-size:15px;line-height:1.6;margin:18px 0 0">
        See you out there,<br>
        <strong>The Hoppr team 🐸</strong>
      </p>
    </td></tr>
  </table>
</div>`
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      await logNotification(record, 'failed', undefined, JSON.stringify(body).slice(0, 1000));
      return new Response('accepted', { status: 202, headers: corsHeaders });
    }
    await logNotification(record, 'sent', body.id);
    return new Response('ok', { headers: corsHeaders });
  } catch (error) {
    console.error(error);
    return new Response('accepted', { status: 202, headers: corsHeaders });
  }
});

-- Hoppr waitlist schema. Run in the Supabase SQL Editor.
-- Browser clients have no table policies: the only public database entrypoint is
-- join_waitlist(). Operational actions are performed by an Edge Function using
-- the service-role key.

create extension if not exists pgcrypto;
create sequence if not exists waitlist_position_seq;

create table if not exists cohorts (
  slug text primary key,
  display_name text not null,
  app_url text,
  is_open boolean not null default true,
  created_at timestamptz not null default now()
);
insert into cohorts (slug, display_name)
values ('ann-arbor', 'Ann Arbor, MI') on conflict (slug) do nothing;

create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  first_name text,
  city_or_zip text,
  phone_e164 text unique,
  sms_consent boolean not null default false,
  sms_consent_at timestamptz,
  phone_verified_at timestamptz,
  sms_unsubscribed_at timestamptz,
  referral_code text unique,
  referred_by uuid references waitlist(id),
  referral_count integer not null default 0,
  waitlist_position bigint not null default nextval('waitlist_position_seq'),
  cohort text not null default 'ann-arbor' references cohorts(slug),
  status text not null default 'waiting' check (status in ('waiting', 'invited', 'activated', 'revoked')),
  invited_at timestamptz,
  invitation_token_hash text,
  claim_deadline timestamptz,
  claimed_at timestamptz,
  activated_at timestamptz,
  email_delivery_state text not null default 'pending',
  sms_delivery_state text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Makes this safe to run after the original Phase 1 schema.
alter table waitlist add column if not exists phone_e164 text;
alter table waitlist add column if not exists sms_consent boolean not null default false;
alter table waitlist add column if not exists sms_consent_at timestamptz;
alter table waitlist add column if not exists phone_verified_at timestamptz;
alter table waitlist add column if not exists sms_unsubscribed_at timestamptz;
alter table waitlist add column if not exists invitation_token_hash text;
alter table waitlist add column if not exists claim_deadline timestamptz;
alter table waitlist add column if not exists claimed_at timestamptz;
alter table waitlist add column if not exists email_delivery_state text not null default 'pending';
alter table waitlist add column if not exists sms_delivery_state text;
alter table waitlist add column if not exists updated_at timestamptz not null default now();
alter table waitlist alter column cohort set default 'ann-arbor';
alter table waitlist alter column cohort set not null;
create unique index if not exists waitlist_phone_e164_key on waitlist (phone_e164) where phone_e164 is not null;
alter table waitlist drop constraint if exists waitlist_status_check;
alter table waitlist add constraint waitlist_status_check check (status in ('waiting', 'invited', 'activated', 'revoked'));
create index if not exists waitlist_queue_idx on waitlist (cohort, created_at, id) where status = 'waiting';
create index if not exists waitlist_invitation_idx on waitlist (invitation_token_hash) where invitation_token_hash is not null;
create index if not exists waitlist_referred_by_idx on waitlist(referred_by);

create table if not exists waitlist_notifications (
  id uuid primary key default gen_random_uuid(),
  waitlist_id uuid not null references waitlist(id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  event_type text not null,
  provider_message_id text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'suppressed')),
  error_detail text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists phone_verification_codes (
  id uuid primary key default gen_random_uuid(),
  waitlist_id uuid not null references waitlist(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists phone_verification_active_idx on phone_verification_codes(waitlist_id, expires_at) where consumed_at is null;

create table if not exists waitlist_audit_log (
  id bigint generated always as identity primary key,
  waitlist_id uuid references waitlist(id) on delete set null,
  actor_id uuid,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function waitlist_set_referral_code() returns trigger language plpgsql set search_path = public, extensions as $$
declare candidate text; attempt int := 0;
begin
  if new.referral_code is not null then return new; end if;
  loop
    candidate := lower(regexp_replace(substr(encode(gen_random_bytes(9), 'base64'), 1, 10), '[^a-z0-9]', '', 'g'));
    exit when length(candidate) >= 8 and not exists (select 1 from waitlist where referral_code = candidate);
    attempt := attempt + 1;
    if attempt > 10 then raise exception 'referral code generation failed'; end if;
  end loop;
  new.referral_code := candidate;
  return new;
end; $$;

create or replace function waitlist_touch() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end; $$;
create or replace function waitlist_bump_referral_count() returns trigger language plpgsql as $$ begin
  if new.referred_by is not null then update waitlist set referral_count = referral_count + 1 where id = new.referred_by; end if;
  return new;
end; $$;
drop trigger if exists trg_waitlist_referral_code on waitlist;
create trigger trg_waitlist_referral_code before insert on waitlist for each row execute function waitlist_set_referral_code();
drop trigger if exists trg_waitlist_touch on waitlist;
create trigger trg_waitlist_touch before update on waitlist for each row execute function waitlist_touch();
drop trigger if exists trg_waitlist_bump_referral on waitlist;
create trigger trg_waitlist_bump_referral after insert on waitlist for each row execute function waitlist_bump_referral_count();

create table if not exists waitlist_rate_limit (
  ip_hash text primary key,
  window_start timestamptz not null,
  count integer not null default 0
);

alter table waitlist enable row level security;
alter table waitlist_notifications enable row level security;
alter table phone_verification_codes enable row level security;
alter table waitlist_audit_log enable row level security;
alter table waitlist_rate_limit enable row level security;

-- Normalizes and validates browser input. A phone is only retained if explicit
-- consent was supplied; verification is a separate server-side operation.
create or replace function join_waitlist(
  p_email text,
  p_first_name text default null,
  p_city_or_zip text default null,
  p_referred_by_code text default null,
  p_phone text default null,
  p_sms_consent boolean default false
) returns table(id uuid, "position" bigint, cohort text, referral_code text, phone_verification_required boolean)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_phone text := null;
  v_referrer_id uuid;
  v_id uuid;
  v_ip text;
  v_ip_hash text;
  v_count int;
  v_headers json;
  v_xff_parts text[];
begin
  begin
    v_headers := current_setting('request.headers', true)::json;
    -- x-forwarded-for is attacker-controllable at the client hop (each proxy
    -- appends, it doesn't overwrite), so the trustworthy value is whichever
    -- entry Supabase's own edge network added: cf-connecting-ip when present,
    -- otherwise the *last* x-forwarded-for entry, never the first.
    v_ip := coalesce(v_headers->>'cf-connecting-ip', v_headers->>'x-real-ip');
    if v_ip is null then
      v_xff_parts := string_to_array(coalesce(v_headers->>'x-forwarded-for', ''), ',');
      if array_length(v_xff_parts, 1) > 0 then
        v_ip := trim(v_xff_parts[array_length(v_xff_parts, 1)]);
      end if;
    end if;
  exception when others then v_ip := null; end;
  if coalesce(trim(v_ip), '') <> '' then
    v_ip_hash := encode(digest(trim(v_ip), 'sha256'), 'hex');
    insert into waitlist_rate_limit (ip_hash, window_start, count) values (v_ip_hash, now(), 1)
      on conflict (ip_hash) do update set
        count = case when waitlist_rate_limit.window_start < now() - interval '1 hour' then 1 else waitlist_rate_limit.count + 1 end,
        window_start = case when waitlist_rate_limit.window_start < now() - interval '1 hour' then now() else waitlist_rate_limit.window_start end
      returning count into v_count;
    if v_count > 5 then raise exception 'rate_limited'; end if;
  end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email) > 254 then
    raise exception 'invalid_request';
  end if;
  if coalesce(length(trim(p_first_name)), 0) > 80 or coalesce(length(trim(p_city_or_zip)), 0) > 100 then
    raise exception 'invalid_request';
  end if;
  if p_phone is not null and trim(p_phone) <> '' then
    v_phone := regexp_replace(trim(p_phone), '[^0-9+]', '', 'g');
    if v_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'invalid_request'; end if;
  end if;
  if p_sms_consent and v_phone is null then raise exception 'invalid_request'; end if;
  if p_referred_by_code is not null then
    select w.id into v_referrer_id from waitlist w where w.referral_code = lower(trim(p_referred_by_code));
  end if;
  insert into waitlist (email, first_name, city_or_zip, phone_e164, sms_consent, sms_consent_at, referred_by)
  values (v_email, nullif(trim(p_first_name), ''), nullif(trim(p_city_or_zip), ''),
    case when p_sms_consent then v_phone else null end, p_sms_consent,
    case when p_sms_consent then now() else null end, v_referrer_id)
  returning id into v_id;
  insert into waitlist_audit_log (waitlist_id, event_type, details) values (v_id, 'joined', jsonb_build_object('cohort', 'ann-arbor'));
  return query select w.id, w.waitlist_position, w.cohort, w.referral_code, (w.sms_consent and w.phone_e164 is not null) from waitlist w where w.id = v_id;
exception when unique_violation then
  -- Deliberately non-enumerating: the browser presents one generic response.
  raise exception 'already_registered';
end; $$;

-- Atomically invite the oldest eligible members in one cohort. This is callable
-- only by the service role through the admin Edge Function.
create or replace function release_waitlist_batch(p_cohort text, p_limit integer)
returns table(member_id uuid, email text, first_name text, invitation_token text, claim_deadline timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare r record; v_token text; v_deadline timestamptz := now() + interval '7 days';
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'invalid batch size'; end if;
  -- Expired access is returned to the queue and explicitly audited before release.
  update waitlist set status = 'waiting', invitation_token_hash = null, claim_deadline = null
   where cohort = p_cohort and status = 'invited' and claim_deadline < now() and claimed_at is null;
  insert into waitlist_audit_log (waitlist_id, event_type, details)
    select id, 'invitation_expired', jsonb_build_object('cohort', cohort) from waitlist
    where cohort = p_cohort and status = 'waiting' and updated_at >= now() - interval '1 second';
  for r in select id, email, first_name from waitlist
      where cohort = p_cohort and status = 'waiting'
      order by created_at, id for update skip locked limit p_limit
  loop
    v_token := encode(gen_random_bytes(32), 'hex');
    update waitlist set status = 'invited', invited_at = now(), claim_deadline = v_deadline,
      invitation_token_hash = crypt(v_token, gen_salt('bf')), email_delivery_state = 'pending' where id = r.id;
    insert into waitlist_audit_log (waitlist_id, event_type, details) values (r.id, 'invited', jsonb_build_object('cohort', p_cohort, 'claim_deadline', v_deadline));
    member_id := r.id; email := r.email; first_name := r.first_name; invitation_token := v_token; claim_deadline := v_deadline; return next;
  end loop;
end; $$;

create or replace function claim_waitlist_invite(p_token text)
returns table(destination text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_member waitlist%rowtype; v_url text;
begin
  select * into v_member from waitlist where status = 'invited' and claim_deadline >= now()
    and invitation_token_hash = crypt(p_token, invitation_token_hash) for update;
  if not found then raise exception 'invalid_or_expired_invite'; end if;
  update waitlist set status = 'activated', claimed_at = now(), activated_at = now(), invitation_token_hash = null where id = v_member.id;
  insert into waitlist_audit_log (waitlist_id, event_type) values (v_member.id, 'activated');
  select app_url into v_url from cohorts where slug = v_member.cohort;
  return query select coalesce(v_url, 'https://hoppr.app');
end; $$;

revoke all on table waitlist, waitlist_notifications, phone_verification_codes, waitlist_audit_log, waitlist_rate_limit from anon, authenticated;
revoke all on function release_waitlist_batch(text, integer), claim_waitlist_invite(text) from public, anon, authenticated;
grant execute on function join_waitlist(text, text, text, text, text, boolean) to anon;
-- Safe to expose: the token itself (32 random bytes, hashed at rest, single-use,
-- deadline-bound) is the credential, the same trust model as a password-reset link.
grant execute on function claim_waitlist_invite(text) to anon;

-- Raw source tables, one row per record as received. Loaded once; never edited afterwards.
-- Every table has org_id. Row-level security limits each session to the org set in
-- app.org_id, so a query cannot return another customer's rows even if the app has a bug.
-- Local development only: the app runs as renewal_app, which RLS applies to.
-- (Production would take the org from the signed-in user's token instead of a session setting.)

create role renewal_app nologin;

create table sf_accounts (
  org_id text not null,
  sf_id text not null,
  company_name text not null,
  email_domain text,
  owner_csm_id text,
  contract_value numeric,
  renewal_date date,
  billing_cycle text not null,
  start_date date,
  primary key (org_id, sf_id)
);

create table sf_contacts (
  org_id text not null,
  contact_id text not null,
  sf_id text not null,
  email text,
  role text,
  is_active boolean not null,
  primary key (org_id, contact_id)
);

create table zd_tickets (
  org_id text not null,
  ticket_id text not null,
  org_name text,
  requester_email text,
  opened_at timestamp not null,
  closed_at timestamp,
  reopen_count integer not null,
  priority text not null,
  ingested_at timestamp not null,
  primary key (org_id, ticket_id)
);

-- event_id repeats on replayed copies, so the row key is a surrogate id.
create table product_events (
  id bigserial primary key,
  org_id text not null,
  event_id text not null,
  account_domain text,
  user_id text,
  event_type text not null,
  event_time timestamp not null,
  ingested_at timestamp not null
);

create table stripe_invoices (
  org_id text not null,
  invoice_id text not null,
  customer_ref text not null,
  billing_email text,
  amount numeric not null,
  due_date date,
  status text not null,
  attempt_count integer not null,
  sent_at timestamp,
  viewed_at timestamp,
  paid_at timestamp,
  primary key (org_id, invoice_id)
);

create table stripe_subscription_events (
  id bigserial primary key,
  org_id text not null,
  event_id text not null,
  customer_ref text not null,
  event_type text not null,
  event_time timestamp not null,
  ingested_at timestamp not null
);

create index product_events_org_domain on product_events (org_id, account_domain);
create index zd_tickets_org_email on zd_tickets (org_id, requester_email);
create index stripe_invoices_org_email on stripe_invoices (org_id, billing_email);
create index stripe_subscription_events_org_ref on stripe_subscription_events (org_id, customer_ref);

do $$
declare
  t text;
begin
  foreach t in array array[
    'sf_accounts', 'sf_contacts', 'zd_tickets',
    'product_events', 'stripe_invoices', 'stripe_subscription_events'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (org_id = current_setting(''app.org_id'', true))
         with check (org_id = current_setting(''app.org_id'', true))',
      t
    );
    execute format('grant select, insert, delete on %I to renewal_app', t);
  end loop;
end $$;

grant usage on schema public to renewal_app;
grant usage, select on all sequences in schema public to renewal_app;

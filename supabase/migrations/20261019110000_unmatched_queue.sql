-- Source records that could not be linked to exactly one customer. The nightly run rewrites an
-- org's queue each night, so a record leaves the queue once it matches (for example, after the
-- CRM gains the missing domain). Same tenant rule as the other tables.
create table unmatched_records (
  id bigserial primary key,
  org_id text not null,
  source text not null check (source in ('events', 'tickets', 'invoices', 'subs', 'contacts')),
  record_id text not null,
  hint text not null,            -- what we tried to match on: a domain, email, company name or Stripe id
  seen_on date not null
);
create index unmatched_records_org on unmatched_records (org_id, source);

alter table unmatched_records enable row level security;
create policy tenant_isolation on unmatched_records
  using (org_id = (auth.jwt() ->> 'org_id'))
  with check (org_id = (auth.jwt() ->> 'org_id'));
grant select, insert, update, delete on unmatched_records to authenticated;
grant usage, select on all sequences in schema public to authenticated;

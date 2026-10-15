-- Gmail metadata only: who, when, which direction, and reply time. No message content is stored.
-- Not used in scoring in v1. Stored so the source exists and is governed like the others.
create table gmail_messages (
  id bigserial primary key,
  org_id text not null,
  message_id text not null,
  contact_id text,
  counterpart_domain text,
  direction text not null,
  sent_at timestamp not null,
  ingested_at timestamp not null,
  thread_id text not null,
  reply_latency_hours numeric
);

create index gmail_messages_org_domain on gmail_messages (org_id, counterpart_domain);

alter table gmail_messages enable row level security;
create policy tenant_isolation on gmail_messages
  using (org_id = (auth.jwt() ->> 'org_id'))
  with check (org_id = (auth.jwt() ->> 'org_id'));
grant select, insert, delete on gmail_messages to authenticated;
grant usage, select on all sequences in schema public to authenticated;

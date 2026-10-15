-- Scoring output, run log, and outreach records. Every table carries org_id and the same
-- tenant rule as the source tables: a session sees only rows for the org in its verified token.

-- Model parameters are shared across orgs. They hold weights, not customer rows.
create table models (
  model_id text primary key,
  trained_at timestamptz not null default now(),
  feature_names text[] not null,
  feature_mean double precision[] not null,
  feature_scale double precision[] not null,
  weights double precision[] not null,
  bias double precision not null,
  test_auc double precision,
  training_rows integer not null,
  training_leavers integer not null
);

create table runs (
  run_id uuid primary key default gen_random_uuid(),
  org_id text not null,
  as_of date not null,
  model_id text references models(model_id),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  scored_count integer,
  unknown_count integer
);

create table scores (
  id bigserial primary key,
  org_id text not null,
  run_id uuid not null references runs(run_id),
  sf_id text not null,
  owner_csm_id text,
  company_name text not null,
  renewal_date date,
  days_to_renewal integer,
  contract_value numeric,
  probability double precision,        -- null when unknown
  money_at_risk numeric,               -- probability x contract value, null when unknown
  unknown_reason text,                 -- set when the customer is not scored
  reasons jsonb not null default '[]'  -- each reason: feature, plain label, value, weight, contribution, source ids
);
create index scores_run on scores (run_id);

create table published_runs (
  org_id text primary key,
  run_id uuid not null references runs(run_id),
  published_at timestamptz not null default now()
);

create table alerts (
  id bigserial primary key,
  org_id text not null,
  run_id uuid references runs(run_id),
  sf_id text not null,
  owner_csm_id text,
  alert_type text not null,            -- csm_review, card_failed
  status text not null default 'open', -- open, handled, suppressed
  suppressed_reason text,
  created_at timestamptz not null default now()
);

-- The one automatic customer message: a card-update reminder. Written here, not sent by a mail
-- provider, so the send is visible in the database.
create table card_reminders (
  id bigserial primary key,
  org_id text not null,
  sf_id text not null,
  invoice_id text not null,
  sent_at timestamptz not null default now(),
  channel text not null default 'log'
);

create table opt_outs (
  org_id text not null,
  sf_id text not null,
  set_at timestamptz not null default now(),
  primary key (org_id, sf_id)
);

create table csm_actions (
  id bigserial primary key,
  org_id text not null,
  sf_id text not null,
  csm_id text not null,
  action_date date not null,
  action_type text not null
);

do $$
declare
  t text;
begin
  foreach t in array array['runs', 'scores', 'published_runs', 'alerts', 'card_reminders', 'opt_outs', 'csm_actions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (org_id = (auth.jwt() ->> ''org_id''))
         with check (org_id = (auth.jwt() ->> ''org_id''))',
      t
    );
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

-- Models are readable by everyone signed in; only the pipeline writes them.
grant select on models to authenticated;
grant usage, select on all sequences in schema public to authenticated;

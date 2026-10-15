-- Isolation now comes from a signed token, not from a session setting.
-- The Supabase API (PostgREST) verifies the token's signature, then exposes its claims through
-- auth.jwt(). The app cannot change a signed claim, so it cannot pick another org.
-- Direct Postgres connections have no verified token: auth.jwt() is null, so they see nothing.

do $$
declare
  t text;
begin
  foreach t in array array[
    'sf_accounts', 'sf_contacts', 'zd_tickets',
    'product_events', 'stripe_invoices', 'stripe_subscription_events'
  ]
  loop
    execute format('drop policy tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I
         using (org_id = (auth.jwt() ->> ''org_id''))
         with check (org_id = (auth.jwt() ->> ''org_id''))',
      t
    );
    execute format('grant select, insert, delete on %I to authenticated', t);
  end loop;
end $$;

grant usage on schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

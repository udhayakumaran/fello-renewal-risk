-- Isolation reads the org from auth.jwt(). Through the Supabase API (PostgREST) the token is
-- verified by signature, so a caller cannot change its org. The CSM web app is different: it has no
-- PostgREST token. It sets the same claims itself from its own signed session cookie (see
-- src/db.ts asUser), so isolation there depends on that cookie check. See README "Tenancy".
-- Direct Postgres connections without those claims: auth.jwt() is null, so they see nothing.

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

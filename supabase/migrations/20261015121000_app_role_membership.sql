-- Lets the local admin role switch to renewal_app, so tests can run queries under RLS.
-- Production would connect as renewal_app directly.
grant renewal_app to postgres;

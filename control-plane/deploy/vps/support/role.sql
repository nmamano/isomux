-- The read role of the Hosted support reader (task fd71c74c). Run it as the
-- database superuser on the control-plane database. It is idempotent: run it
-- again after every restore.sh, which keeps only the bootstrap's grants.
--
-- The role logs in with no password over the db container's local socket. It
-- has SELECT on exactly the columns lookup.sql reads, and nothing else: the
-- revoke first removes any grant an older version of this file gave.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hostedsupport_read') then
    create role hostedsupport_read login;
  end if;
end
$$;
alter role hostedsupport_read login nosuperuser nocreatedb nocreaterole
  noinherit noreplication nobypassrls;
alter role hostedsupport_read set default_transaction_read_only = on;
alter role hostedsupport_read set statement_timeout = '20s';

revoke all privileges on all tables in schema public from hostedsupport_read;
grant usage on schema public to hostedsupport_read;
grant select (id, email, stripe_customer_id, created_at)
  on accounts to hostedsupport_read;
grant select (name, id, account_id, instance_id, checkout_state, created_at)
  on name_reservations to hostedsupport_read;
grant select (id, name, plan, service_state, goal, attention_state,
  attention_reason, created_at, updated_at)
  on instances to hostedsupport_read;
grant select (id, account_id, instance_id, status, stripe_customer_id,
  current_period_end, cancel_at_period_end, ended_at, canceled_at,
  cancellation_reason, cancellation_policy, latest_invoice_id,
  payment_failures, episode_state, created_at, updated_at)
  on subscriptions to hostedsupport_read;
grant select (id, instance_id, kind, status, attempt, evidence_at,
  inactivity_deadline_at, absolute_deadline_at, created_at, updated_at)
  on operations to hostedsupport_read;
grant select (id, instance_id, reason_class, reason, severity, raised_at,
  cleared_at)
  on attention_reasons to hostedsupport_read;
grant select (id, instance_id, provider, asset_state, service_ends_at,
  created_at, updated_at)
  on provider_assets to hostedsupport_read;
grant select (seq, ts, actor, instance_id, action, target, outcome)
  on audit_events to hostedsupport_read;
grant select (id, type, created, received_at, subscription_id, outcome)
  on stripe_events to hostedsupport_read;

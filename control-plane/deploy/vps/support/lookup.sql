-- The Hosted support lookup (task fd71c74c): every account whose email equals
-- $1 case-insensitively, with the records internal-docs/support-runbook.md
-- checks. One statement, one jsonb value. Keys are the column names.
--
-- hosted-support-read sends this text verbatim, as the body of a prepared
-- statement. Each column read here needs a column grant in role.sql: a column
-- left out of role.sql cannot be read here by accident. Left out on purpose:
-- operations.evidence, the detail columns, accounts.google_subject, customer SSH
-- keys, provider addresses and host keys, checkout session ids, and the
-- certificate_credentials and reinstatement_attempts tables.
select jsonb_build_object(
  'generated_at', (extract(epoch from now()) * 1000)::bigint,
  'accounts', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id,
      'email', a.email,
      'stripe_customer_id', a.stripe_customer_id,
      'created_at', a.created_at,
      'offices', coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', r.name,
          'id', r.id,
          'created_at', r.created_at,
          'checkout_state', r.checkout_state,
          'instance', (
            select jsonb_build_object(
              'id', i.id,
              'name', i.name,
              'plan', i.plan,
              'service_state', i.service_state,
              'goal', i.goal,
              'attention_state', i.attention_state,
              'attention_reason', i.attention_reason,
              'created_at', i.created_at,
              'updated_at', i.updated_at)
            from instances i where i.id = r.instance_id),
          'subscriptions', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', s.id,
              'status', s.status,
              'stripe_customer_id', s.stripe_customer_id,
              'current_period_end', s.current_period_end,
              'cancel_at_period_end', s.cancel_at_period_end,
              'ended_at', s.ended_at,
              'canceled_at', s.canceled_at,
              'cancellation_reason', s.cancellation_reason,
              'cancellation_policy', s.cancellation_policy,
              'latest_invoice_id', s.latest_invoice_id,
              'payment_failures', s.payment_failures,
              'episode_state', s.episode_state,
              'created_at', s.created_at,
              'updated_at', s.updated_at) order by s.created_at, s.id)
            from subscriptions s
            where s.account_id = a.id and s.instance_id = r.instance_id), '[]'::jsonb),
          'operations', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', o.id,
              'kind', o.kind,
              'status', o.status,
              'attempt', o.attempt,
              'evidence_at', o.evidence_at,
              'inactivity_deadline_at', o.inactivity_deadline_at,
              'absolute_deadline_at', o.absolute_deadline_at,
              'created_at', o.created_at,
              'updated_at', o.updated_at) order by o.created_at, o.id)
            from operations o where o.instance_id = r.instance_id), '[]'::jsonb),
          'attention_reasons', coalesce((
            select jsonb_agg(jsonb_build_object(
              'reason_class', ar.reason_class,
              'reason', ar.reason,
              'severity', ar.severity,
              'raised_at', ar.raised_at,
              'cleared_at', ar.cleared_at) order by ar.raised_at, ar.id)
            from attention_reasons ar where ar.instance_id = r.instance_id), '[]'::jsonb),
          'provider_assets', coalesce((
            select jsonb_agg(jsonb_build_object(
              'provider', p.provider,
              'asset_state', p.asset_state,
              'service_ends_at', p.service_ends_at,
              'created_at', p.created_at,
              'updated_at', p.updated_at) order by p.created_at, p.id)
            from provider_assets p where p.instance_id = r.instance_id), '[]'::jsonb),
          'audit_events', coalesce((
            select jsonb_agg(jsonb_build_object(
              'ts', e.ts,
              'actor', e.actor,
              'action', e.action,
              'target', e.target,
              'outcome', e.outcome) order by e.seq)
            from audit_events e where e.instance_id = r.instance_id), '[]'::jsonb),
          'stripe_events', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', se.id,
              'type', se.type,
              'created', se.created,
              'received_at', se.received_at,
              'outcome', se.outcome) order by se.created, se.id)
            from stripe_events se
            where se.subscription_id in (
              select s.id from subscriptions s
              where s.account_id = a.id and s.instance_id = r.instance_id)), '[]'::jsonb)
        ) order by r.created_at, r.name)
        from name_reservations r where r.account_id = a.id), '[]'::jsonb),
      'other_subscriptions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id,
          'status', s.status,
          'stripe_customer_id', s.stripe_customer_id,
          'current_period_end', s.current_period_end,
          'cancel_at_period_end', s.cancel_at_period_end,
          'ended_at', s.ended_at,
          'canceled_at', s.canceled_at,
          'cancellation_reason', s.cancellation_reason,
          'cancellation_policy', s.cancellation_policy,
          'latest_invoice_id', s.latest_invoice_id,
          'payment_failures', s.payment_failures,
          'episode_state', s.episode_state,
          'created_at', s.created_at,
          'updated_at', s.updated_at) order by s.created_at, s.id)
        from subscriptions s
        where s.account_id = a.id
          and (s.instance_id is null or s.instance_id not in (
            select r.instance_id from name_reservations r where r.account_id = a.id))), '[]'::jsonb)
    ) order by a.created_at, a.id)
    from accounts a where lower(a.email) = lower($1::text)), '[]'::jsonb)
) as lookup

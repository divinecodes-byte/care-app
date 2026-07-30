-- Fix a real constraint bug found by scripts/routine-audit/run.ts (BG):
-- routine_instances_source_check required *exactly one* of
-- source_template_id / built_in_pack_id to be non-null at all times. But
-- source_template_id uses ON DELETE SET NULL specifically so deleting a
-- personal template never disturbs an already-applied routine instance
-- (see migration 20260730000000) -- and when that SET NULL actually fires
-- for a personal-template-sourced instance (built_in_pack_id already null),
-- the row becomes (null, null), which the old exact-XOR constraint
-- rejected outright, turning a routine's own source-template deletion into
-- a hard failure instead of the intended silent, harmless degradation.
--
-- The real invariant that matters is just "never both set" (a single
-- instance can never claim to come from a personal template AND a built-in
-- pack simultaneously) -- "neither set" is a legitimate, expected state
-- once a source template is deleted, and title/source_version snapshots on
-- the row already preserve enough context for display.

alter table public.routine_instances drop constraint routine_instances_source_check;
alter table public.routine_instances add constraint routine_instances_source_check check (
    not (source_template_id is not null and built_in_pack_id is not null)
);

-- ─── Rollback ───────────────────────────────────────────────────────────────
-- alter table public.routine_instances drop constraint routine_instances_source_check;
-- alter table public.routine_instances add constraint routine_instances_source_check check (
--     (source_template_id is not null and built_in_pack_id is null) or
--     (source_template_id is null and built_in_pack_id is not null)
-- );

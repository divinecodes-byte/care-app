-- Week 1 launch hardening task #8: clear_stale_reminder_deliveries()
-- (added in the prior reminder-lifecycle task) is fully superseded by
-- update_reminder_schedule()'s atomic, in-place delivery reconciliation --
-- keeping both would leave two competing, overlapping mechanisms for the
-- same concern, one of them (delete + wait for next claim) strictly worse
-- than the other (update in place immediately). No code calls it anymore
-- (edit-reminder.tsx now calls update_reminder_schedule exclusively) --
-- confirmed via repository search before dropping.
drop function if exists public.clear_stale_reminder_deliveries(uuid);

-- migrate_phase3_identity.sql
--
-- Phase 3 (session/identity consolidation): adds the capability flag that lets
-- a group opt into a standing self-service shift instead of the old bespoke
-- POST /auth/barrio-identify code path (now deleted — see
-- handle_shift_login()/_sync_group_standing_shift() in
-- public/api/routes/auth.php / public/api/routes/admin/groups.php).
--
-- Run after migrate_groups_holder_model.sql (needs groups, shifts.is_standing,
-- shifts.group_id, group_roles — all created there).
--
-- Additive only; safe to run while the app is live.
--
-- Run via: mysql -u user -p db_name < migrate_phase3_identity.sql

SET NAMES utf8mb4;

-- New groups default to opt-out (matches the enable_arrival_tracking /
-- enable_consumable_entitlements capability-flag pattern) — an admin must
-- explicitly turn this on per group going forward.
ALTER TABLE groups
  ADD COLUMN enable_self_service_shift TINYINT(1) NOT NULL DEFAULT 0
    AFTER enable_consumable_entitlements;

-- Preserve existing behavior for groups already in production: the old
-- handle_barrio_identify() worked unconditionally for any group with a
-- qr_code, so flip the flag on for every existing group rather than
-- silently revoking a capability people may already rely on at events.
UPDATE groups SET enable_self_service_shift = 1;

-- Provision the standing shift + token for every group now flagged on,
-- mirroring _sync_group_standing_shift(). Skips groups that somehow already
-- have one (re-run safety).
INSERT INTO shifts (name, dept_id, group_id, is_standing, permissions, active_from, active_until, created_by)
SELECT CONCAT(g.name, ' — Self Service'), NULL, g.id, 1, '["request_fills"]',
       '2000-01-01 00:00:00', '2099-12-31 23:59:59', NULL
FROM groups g
WHERE g.enable_self_service_shift = 1
  AND NOT EXISTS (
    SELECT 1 FROM shifts s WHERE s.group_id = g.id AND s.is_standing = 1
  );

INSERT INTO shift_tokens (shift_id, token, label)
SELECT s.id, g.qr_code, 'Group QR'
FROM groups g
JOIN shifts s ON s.group_id = g.id AND s.is_standing = 1
WHERE g.enable_self_service_shift = 1
  AND g.qr_code IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM shift_tokens st WHERE st.shift_id = s.id AND st.token = g.qr_code
  );

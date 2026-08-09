-- Phase 5: water/fill subsystem fixes.
-- Run once: mysql -u user -p else_inventory < migrate_phase5_water.sql
-- Depends on migrate_groups_holder_model.sql and migrate_phase3_identity.sql already
-- being applied (uses the groups/holder-model shape introduced there).

-- ─── Physical-voucher fallback: issuance bookkeeping, decoupled from real credits ──
-- See handle_barrio_distribute()/handle_group_arrival() in consumables.php/groups.php,
-- which explicitly refuse to distribute water_fill itself through this generic path.
INSERT IGNORE INTO consumable_types (name, key_name, sort_order)
VALUES ('Water Vouchers (Physical)', 'water_voucher_physical', 11);

-- ─── Physical-voucher redemption marker on fill_requests ──────────────────────────
ALTER TABLE fill_requests
  ADD COLUMN via_physical_voucher TINYINT(1) NOT NULL DEFAULT 0 AFTER notes;

-- ─── Separate voucher-redemption QR, distinct from groups.qr_code ─────────────────
-- Deliberately NEVER inserted into shift_tokens.token — that's what keeps it
-- incapable of starting a group's self-service session. See handle_scan_lookup()
-- and handle_create_fill_request() in fill_requests.php/scan.php, which resolve
-- either qr_code or fill_voucher_code to the same group.
ALTER TABLE groups
  ADD COLUMN fill_voucher_code VARCHAR(64) NULL AFTER qr_code,
  ADD UNIQUE KEY uq_groups_fill_voucher_code (fill_voucher_code);

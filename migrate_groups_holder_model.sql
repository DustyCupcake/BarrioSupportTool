-- migrate_groups_holder_model.sql
--
-- Foundational simplification migration:
--   1. Merges `barrios` and `artists` into a single `groups` entity type
--      (barrio-specific behavior becomes optional capability flags on a
--      group rather than a hardcoded type split), and adds `group_roles`
--      as schema groundwork for per-group membership.
--   2. Replaces the four-nullable-holder-column design on `equipment_items`
--      (current_dept_id/current_barrio_id/current_artist_id/current_person_id)
--      and the equivalent columns on `transactions` with a single
--      holder_type/holder_id pair, enforced consistent with `status` by a
--      DB trigger. This is the design that let a barrio-held item silently
--      keep status='available' before (migrate_fix_barrio_visibility_and_status.sql
--      had to hand-patch that class of bug once already).
--
-- ⚠ NOT staged for zero-downtime and NOT safely re-runnable — this is a
-- single-shot transformation intended to run while the app is offline
-- (between events). It mixes DDL and DML; MySQL does not support
-- transactional DDL, so a partial failure can leave the schema mid-migration.
--
-- TAKE A FULL BACKUP FIRST:
--   mysqldump -u user -p db_name > backup_before_groups_migration.sql
--
-- Run via: mysql -u user -p db_name < migrate_groups_holder_model.sql

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Create groups + group_roles
-- ═══════════════════════════════════════════════════════════════════════════
-- _legacy_barrio_id / _legacy_artist_id are temporary remap columns, dropped
-- at the end of this script once every dependent table has been repointed
-- at the new group ids (barrios.id and artists.id both started their own
-- auto-increment sequence, so old ids cannot be assumed to carry over).
CREATE TABLE groups (
    id                              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    name                            VARCHAR(128)  NOT NULL,
    qr_code                         VARCHAR(64)   NULL,
    dept_id                         INT UNSIGNED  NULL,
    assigned_staff_id               INT UNSIGNED  NULL,
    enable_arrival_tracking         TINYINT(1)    NOT NULL DEFAULT 0,
    enable_consumable_entitlements  TINYINT(1)    NOT NULL DEFAULT 0,
    sort_order                      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    arrival_status                  ENUM('expected','on-site','departed') NOT NULL DEFAULT 'expected',
    arrived_at                      DATETIME      NULL,
    arrived_by                      INT UNSIGNED  NULL,
    arrived_by_name                 VARCHAR(128)  NULL,
    orientation_done                TINYINT(1)    NOT NULL DEFAULT 0,
    departed_at                     DATETIME      NULL,
    departed_by                     INT UNSIGNED  NULL,
    departed_by_name                VARCHAR(128)  NULL,
    created_at                      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _legacy_barrio_id               INT UNSIGNED  NULL,
    _legacy_artist_id               INT UNSIGNED  NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_group_dept_name (dept_id, name),
    UNIQUE KEY uq_group_qr_code   (qr_code),
    KEY idx_group_arrival_status (arrival_status),
    KEY idx_group_dept           (dept_id),
    KEY idx_group_assigned       (assigned_staff_id),
    CONSTRAINT fk_group_dept        FOREIGN KEY (dept_id)           REFERENCES departments(id) ON DELETE SET NULL,
    CONSTRAINT fk_group_staff       FOREIGN KEY (assigned_staff_id) REFERENCES users(id)       ON DELETE SET NULL,
    CONSTRAINT fk_group_arrived_by  FOREIGN KEY (arrived_by)        REFERENCES users(id)       ON DELETE SET NULL,
    CONSTRAINT fk_group_departed_by FOREIGN KEY (departed_by)       REFERENCES users(id)       ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE group_roles (
    user_id  INT UNSIGNED NOT NULL,
    group_id INT UNSIGNED NOT NULL,
    role     ENUM('group_lead','group_member') NOT NULL DEFAULT 'group_member',
    PRIMARY KEY (user_id, group_id),
    CONSTRAINT fk_gr_user  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    CONSTRAINT fk_gr_group FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO groups (name, qr_code, dept_id, sort_order, enable_arrival_tracking, enable_consumable_entitlements,
                     arrival_status, arrived_at, arrived_by, arrived_by_name, orientation_done,
                     departed_at, departed_by, departed_by_name, created_at, _legacy_barrio_id)
SELECT name, qr_code, dept_id, sort_order, 1, 1,
       arrival_status, arrived_at, arrived_by, arrived_by_name, orientation_done,
       departed_at, departed_by, departed_by_name, created_at, id
FROM barrios;

-- Artists never had their own qr_code column — same as barrio_qr.php's lazy
-- backfill pattern, a group's qr_code is generated on first admin QR view.
INSERT INTO groups (name, dept_id, assigned_staff_id, sort_order,
                     enable_arrival_tracking, enable_consumable_entitlements, created_at, _legacy_artist_id)
SELECT name, dept_id, assigned_staff_id, sort_order, 0, 0, created_at, id
FROM artists;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. departments.sub_entity -> manages_groups
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE departments ADD COLUMN manages_groups TINYINT(1) NOT NULL DEFAULT 0 AFTER slug;
UPDATE departments SET manages_groups = 1 WHERE sub_entity IN ('barrio','artist');
ALTER TABLE departments DROP COLUMN sub_entity;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. storage_locations.barrio_id -> group_id
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE storage_locations DROP FOREIGN KEY fk_loc_barrio;
ALTER TABLE storage_locations ADD COLUMN group_id INT UNSIGNED NULL AFTER id;
UPDATE storage_locations sl JOIN groups g ON g._legacy_barrio_id = sl.barrio_id SET sl.group_id = g.id;
ALTER TABLE storage_locations DROP COLUMN barrio_id;
ALTER TABLE storage_locations ADD CONSTRAINT fk_loc_group FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. distribution_events.barrio_id -> group_id
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE distribution_events DROP FOREIGN KEY fk_dist_barrio;
ALTER TABLE distribution_events DROP INDEX idx_barrio;
ALTER TABLE distribution_events ADD COLUMN group_id INT UNSIGNED NULL AFTER id;
UPDATE distribution_events de JOIN groups g ON g._legacy_barrio_id = de.barrio_id SET de.group_id = g.id;
ALTER TABLE distribution_events MODIFY COLUMN group_id INT UNSIGNED NOT NULL;
ALTER TABLE distribution_events DROP COLUMN barrio_id;
ALTER TABLE distribution_events ADD KEY idx_group (group_id);
ALTER TABLE distribution_events ADD CONSTRAINT fk_dist_group FOREIGN KEY (group_id) REFERENCES groups(id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. barrio_entitlements -> group_entitlements
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE barrio_entitlements DROP FOREIGN KEY fk_ent_barrio;
ALTER TABLE barrio_entitlements DROP INDEX uq_barrio_type;
ALTER TABLE barrio_entitlements ADD COLUMN group_id INT UNSIGNED NULL AFTER id;
UPDATE barrio_entitlements be JOIN groups g ON g._legacy_barrio_id = be.barrio_id SET be.group_id = g.id;
ALTER TABLE barrio_entitlements MODIFY COLUMN group_id INT UNSIGNED NOT NULL;
ALTER TABLE barrio_entitlements DROP COLUMN barrio_id;
ALTER TABLE barrio_entitlements ADD UNIQUE KEY uq_group_type (group_id, type_id);
ALTER TABLE barrio_entitlements ADD CONSTRAINT fk_ent_group FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
RENAME TABLE barrio_entitlements TO group_entitlements;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. barrio_equipment_orders -> group_equipment_orders
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE barrio_equipment_orders DROP FOREIGN KEY fk_eqord_barrio;
ALTER TABLE barrio_equipment_orders DROP INDEX uq_barrio_type;
ALTER TABLE barrio_equipment_orders ADD COLUMN group_id INT UNSIGNED NULL AFTER id;
UPDATE barrio_equipment_orders beo JOIN groups g ON g._legacy_barrio_id = beo.barrio_id SET beo.group_id = g.id;
ALTER TABLE barrio_equipment_orders MODIFY COLUMN group_id INT UNSIGNED NOT NULL;
ALTER TABLE barrio_equipment_orders DROP COLUMN barrio_id;
ALTER TABLE barrio_equipment_orders ADD UNIQUE KEY uq_group_type (group_id, equipment_type_id);
ALTER TABLE barrio_equipment_orders ADD CONSTRAINT fk_eqord_group FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
RENAME TABLE barrio_equipment_orders TO group_equipment_orders;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. shifts.barrio_id -> group_id, add is_standing (Phase 3 groundwork)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE shifts DROP FOREIGN KEY fk_shift_barrio;
ALTER TABLE shifts ADD COLUMN group_id INT UNSIGNED NULL AFTER dept_id;
UPDATE shifts s JOIN groups g ON g._legacy_barrio_id = s.barrio_id SET s.group_id = g.id;
ALTER TABLE shifts DROP COLUMN barrio_id;
ALTER TABLE shifts ADD COLUMN is_standing TINYINT(1) NOT NULL DEFAULT 0 AFTER group_id;
ALTER TABLE shifts ADD KEY idx_group (group_id);
ALTER TABLE shifts ADD CONSTRAINT fk_shift_group FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. fill_requests.entity_type/entity_id -> group_id
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE fill_requests DROP FOREIGN KEY fk_fr_barrio;
ALTER TABLE fill_requests DROP INDEX idx_fr_entity;
ALTER TABLE fill_requests ADD COLUMN group_id INT UNSIGNED NULL AFTER id;
UPDATE fill_requests fr JOIN groups g ON g._legacy_barrio_id = fr.entity_id
    SET fr.group_id = g.id WHERE fr.entity_type = 'barrio';
ALTER TABLE fill_requests MODIFY COLUMN group_id INT UNSIGNED NOT NULL;
ALTER TABLE fill_requests DROP COLUMN entity_type;
ALTER TABLE fill_requests DROP COLUMN entity_id;
ALTER TABLE fill_requests ADD KEY idx_fr_group (group_id);
ALTER TABLE fill_requests ADD CONSTRAINT fk_fr_group FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. equipment_items holder model
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE equipment_items
    DROP FOREIGN KEY fk_item_dept,
    DROP FOREIGN KEY fk_item_barrio,
    DROP FOREIGN KEY fk_item_artist,
    DROP FOREIGN KEY fk_item_person;
ALTER TABLE equipment_items
    DROP INDEX idx_dept_item,
    DROP INDEX idx_barrio,
    DROP INDEX idx_artist_item,
    DROP INDEX idx_item_person;

ALTER TABLE equipment_items
    ADD COLUMN holder_type ENUM('department','group','person') NULL AFTER current_person_id,
    ADD COLUMN holder_id INT UNSIGNED NULL AFTER holder_type;

-- Backfill priority person > group > department, matching the priority
-- handle_checkin() already used to decide tier (is_sub_lent / is_person_prod)
-- from these same four columns.
UPDATE equipment_items
SET holder_type = 'person', holder_id = current_person_id
WHERE current_person_id IS NOT NULL;

UPDATE equipment_items i
JOIN groups g ON g._legacy_barrio_id = i.current_barrio_id
SET i.holder_type = 'group', i.holder_id = g.id
WHERE i.current_person_id IS NULL AND i.current_barrio_id IS NOT NULL;

UPDATE equipment_items i
JOIN groups g ON g._legacy_artist_id = i.current_artist_id
SET i.holder_type = 'group', i.holder_id = g.id
WHERE i.current_person_id IS NULL AND i.current_barrio_id IS NULL AND i.current_artist_id IS NOT NULL;

-- Plain dept-level checkout (handle_checkout) sets current_dept_id + status
-- ='checked-out' with no barrio/artist/person; handle_checkin's plain-dept
-- branch always clears current_dept_id back to NULL on return, so an
-- 'available' item should never reach this branch in well-formed data.
UPDATE equipment_items
SET holder_type = 'department', holder_id = current_dept_id
WHERE holder_type IS NULL AND current_dept_id IS NOT NULL AND status IN ('checked-out','activated','used');

-- Anything left with a holder-ish status but no resolvable holder was already
-- inconsistent before this migration (the exact bug class
-- migrate_fix_barrio_visibility_and_status.sql patched once already) — force
-- it back to available so the new trigger's invariant holds for every row.
UPDATE equipment_items
SET status = 'available'
WHERE holder_type IS NULL AND status NOT IN ('available','retired');

ALTER TABLE equipment_items CHANGE COLUMN current_dept_id owning_dept_id INT UNSIGNED NULL;
ALTER TABLE equipment_items DROP COLUMN current_barrio_id;
ALTER TABLE equipment_items DROP COLUMN current_artist_id;
ALTER TABLE equipment_items DROP COLUMN current_person_id;

ALTER TABLE equipment_items
    ADD KEY idx_dept_item (owning_dept_id),
    ADD KEY idx_item_holder (holder_type, holder_id),
    ADD CONSTRAINT fk_item_dept FOREIGN KEY (owning_dept_id) REFERENCES departments(id) ON DELETE SET NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. transactions holder model
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE transactions
    DROP FOREIGN KEY fk_txn_barrio,
    DROP FOREIGN KEY fk_txn_artist;
ALTER TABLE transactions
    DROP INDEX idx_barrio,
    DROP INDEX idx_txn_artist,
    DROP INDEX idx_trans_person;

ALTER TABLE transactions
    ADD COLUMN holder_type ENUM('department','group','person') NULL AFTER dept_id,
    ADD COLUMN holder_id INT UNSIGNED NULL AFTER holder_type;

UPDATE transactions
SET holder_type = 'person', holder_id = person_id
WHERE person_id IS NOT NULL;

UPDATE transactions t
JOIN groups g ON g._legacy_barrio_id = t.barrio_id
SET t.holder_type = 'group', t.holder_id = g.id
WHERE t.person_id IS NULL AND t.barrio_id IS NOT NULL;

UPDATE transactions t
JOIN groups g ON g._legacy_artist_id = t.artist_id
SET t.holder_type = 'group', t.holder_id = g.id
WHERE t.person_id IS NULL AND t.barrio_id IS NULL AND t.artist_id IS NOT NULL;

-- Plain production<->dept checkout/checkin rows had no barrio/artist/person —
-- dept_id alone was the holder. Restrict to those two types specifically
-- (not fill_* rows, whose dept_id if any is incidental context, not a holder).
UPDATE transactions
SET holder_type = 'department', holder_id = dept_id
WHERE holder_type IS NULL AND dept_id IS NOT NULL AND type IN ('checkout','checkin');

ALTER TABLE transactions DROP COLUMN barrio_id;
ALTER TABLE transactions DROP COLUMN artist_id;
ALTER TABLE transactions DROP COLUMN person_id;

ALTER TABLE transactions ADD KEY idx_txn_holder (holder_type, holder_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. Consistency trigger (see schema.sql for the equivalent fresh-install DDL)
-- ═══════════════════════════════════════════════════════════════════════════
DELIMITER $$
CREATE TRIGGER trg_equipment_items_holder_ins
BEFORE INSERT ON equipment_items
FOR EACH ROW
IF (NEW.holder_type IS NULL) != (NEW.status IN ('available','retired'))
    OR (NEW.holder_type IS NULL) != (NEW.holder_id IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'equipment_items: holder_type/holder_id/status inconsistent';
END IF$$

CREATE TRIGGER trg_equipment_items_holder_upd
BEFORE UPDATE ON equipment_items
FOR EACH ROW
IF (NEW.holder_type IS NULL) != (NEW.status IN ('available','retired'))
    OR (NEW.holder_type IS NULL) != (NEW.holder_id IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'equipment_items: holder_type/holder_id/status inconsistent';
END IF$$
DELIMITER ;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. Drop legacy tables and temp remap columns
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE groups DROP COLUMN _legacy_barrio_id, DROP COLUMN _legacy_artist_id;
DROP TABLE artists;
DROP TABLE barrios;

SET FOREIGN_KEY_CHECKS = 1;

-- After running, sanity-check before trusting the migration:
--   SELECT COUNT(*) FROM equipment_items WHERE holder_type IS NULL AND status NOT IN ('available','retired');
--   SELECT COUNT(*) FROM equipment_items WHERE holder_type IS NOT NULL AND status IN ('available','retired');
-- Both should return 0 (the trigger guarantees this going forward, but confirms the backfill itself).

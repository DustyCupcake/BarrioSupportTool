-- Migration: consumable entitlements + equipment orders
-- Run once against the live database.
-- MySQL 5.7+ / MariaDB 10.3+

SET NAMES utf8mb4;
SET foreign_key_checks = 0;

-- ─── 1. Consumable types ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS consumable_types (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name       VARCHAR(128) NOT NULL,
    key_name   VARCHAR(64)  NOT NULL,
    sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_key  (key_name),
    UNIQUE KEY uq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO consumable_types (name, key_name, sort_order) VALUES
    ('Water Vouchers', 'water_vouchers', 0),
    ('Ice Tokens',     'ice_tokens',     1);

-- ─── 2. Per-barrio purchased / distributed totals ─────────────────────────────

CREATE TABLE IF NOT EXISTS barrio_entitlements (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    barrio_id   INT UNSIGNED NOT NULL,
    type_id     INT UNSIGNED NOT NULL,
    purchased   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    distributed SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_barrio_type (barrio_id, type_id),
    CONSTRAINT fk_ent_barrio FOREIGN KEY (barrio_id) REFERENCES barrios(id) ON DELETE CASCADE,
    CONSTRAINT fk_ent_type   FOREIGN KEY (type_id)   REFERENCES consumable_types(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 3. Distribution event audit log ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS distribution_events (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    barrio_id       INT UNSIGNED NOT NULL,
    type_id         INT UNSIGNED NOT NULL,
    quantity        SMALLINT     NOT NULL,
    performed_by    INT UNSIGNED,
    user_name_cache VARCHAR(128),
    occurred_at     DATETIME NOT NULL,
    notes           TEXT,
    PRIMARY KEY (id),
    KEY idx_barrio   (barrio_id),
    KEY idx_occurred (occurred_at),
    CONSTRAINT fk_dist_barrio FOREIGN KEY (barrio_id)    REFERENCES barrios(id),
    CONSTRAINT fk_dist_type   FOREIGN KEY (type_id)      REFERENCES consumable_types(id),
    CONSTRAINT fk_dist_user   FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 4. Equipment orders ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS barrio_equipment_orders (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    barrio_id         INT UNSIGNED NOT NULL,
    equipment_type_id INT UNSIGNED NOT NULL,
    quantity_ordered  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_barrio_type (barrio_id, equipment_type_id),
    CONSTRAINT fk_eqord_barrio FOREIGN KEY (barrio_id)         REFERENCES barrios(id) ON DELETE CASCADE,
    CONSTRAINT fk_eqord_type   FOREIGN KEY (equipment_type_id) REFERENCES equipment_types(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 5. Migrate existing water_vouchers / ice_tokens ─────────────────────────

INSERT IGNORE INTO barrio_entitlements (barrio_id, type_id, purchased, distributed)
SELECT b.id, ct.id, 0, b.water_vouchers
FROM barrios b CROSS JOIN consumable_types ct
WHERE ct.key_name = 'water_vouchers' AND b.water_vouchers > 0;

INSERT IGNORE INTO barrio_entitlements (barrio_id, type_id, purchased, distributed)
SELECT b.id, ct.id, 0, b.ice_tokens
FROM barrios b CROSS JOIN consumable_types ct
WHERE ct.key_name = 'ice_tokens' AND b.ice_tokens > 0;

INSERT IGNORE INTO distribution_events
    (barrio_id, type_id, quantity, user_name_cache, occurred_at, notes)
SELECT b.id, ct.id, b.water_vouchers, b.arrived_by_name,
       COALESCE(b.arrived_at, NOW()), 'Migrated from check-in record'
FROM barrios b CROSS JOIN consumable_types ct
WHERE ct.key_name = 'water_vouchers' AND b.water_vouchers > 0;

INSERT IGNORE INTO distribution_events
    (barrio_id, type_id, quantity, user_name_cache, occurred_at, notes)
SELECT b.id, ct.id, b.ice_tokens, b.arrived_by_name,
       COALESCE(b.arrived_at, NOW()), 'Migrated from check-in record'
FROM barrios b CROSS JOIN consumable_types ct
WHERE ct.key_name = 'ice_tokens' AND b.ice_tokens > 0;

-- ─── 6. Drop old hardcoded columns ───────────────────────────────────────────

ALTER TABLE barrios
    DROP COLUMN IF EXISTS water_vouchers,
    DROP COLUMN IF EXISTS ice_tokens;

SET foreign_key_checks = 1;

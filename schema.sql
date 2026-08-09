-- Barrio Support — database schema
-- MySQL 5.7+ / MariaDB 10.3+
-- Import via phpMyAdmin or: mysql -u user -p else_inventory < schema.sql
--
-- This file reflects the complete current schema including all migrations.
-- For upgrading an existing database, run the migrate_*.sql files instead.

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET FOREIGN_KEY_CHECKS = 0;

-- ─── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    username      VARCHAR(64)     NULL,
    display_name  VARCHAR(128)    NOT NULL,
    password_hash VARCHAR(255)    NULL,
    role          ENUM('production_admin','production_staff','dept_admin','dept_staff',
                       'person','admin','staff','validator')
                                  NOT NULL DEFAULT 'dept_staff',
    language      VARCHAR(5)      NOT NULL DEFAULT 'en',
    qr_token      VARCHAR(64)     NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login    DATETIME,
    is_active     TINYINT(1)      NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    UNIQUE KEY uq_username      (username),
    UNIQUE KEY uq_user_qr_token (qr_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Departments ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name           VARCHAR(128) NOT NULL,
    qr_code        VARCHAR(64)  NULL,
    slug           VARCHAR(64)  NOT NULL,
    manages_groups TINYINT(1)   NOT NULL DEFAULT 0,
    sort_order     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    is_active      TINYINT(1)   NOT NULL DEFAULT 1,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_slug    (slug),
    UNIQUE KEY uq_name    (name),
    UNIQUE KEY uq_qr_code (qr_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Groups ───────────────────────────────────────────────────────────────────
-- Unifies what used to be two parallel entity types (barrios and artists): a
-- group is any team/camp/collective that a department lends equipment to.
-- enable_arrival_tracking / enable_consumable_entitlements are per-group
-- capability flags rather than a hardcoded type split — a barrio-like group
-- sets both, an artist-like group sets neither. enable_self_service_shift
-- opts a group into a standing shift (see shifts.is_standing below) so
-- scanning the group's QR logs anyone in via the normal shift-token flow.
CREATE TABLE IF NOT EXISTS groups (
    id                              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    name                            VARCHAR(128)  NOT NULL,
    qr_code                         VARCHAR(64)   NULL,
    fill_voucher_code               VARCHAR(64)   NULL COMMENT 'Separate from qr_code — resolves to this group for fill requests only, never accepted as a shift_tokens.token, so it cannot start a self-service session',
    dept_id                         INT UNSIGNED  NULL,
    assigned_staff_id               INT UNSIGNED  NULL,
    enable_arrival_tracking         TINYINT(1)    NOT NULL DEFAULT 0,
    enable_consumable_entitlements  TINYINT(1)    NOT NULL DEFAULT 0,
    enable_self_service_shift       TINYINT(1)    NOT NULL DEFAULT 0,
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
    PRIMARY KEY (id),
    UNIQUE KEY uq_group_dept_name (dept_id, name),
    UNIQUE KEY uq_group_qr_code   (qr_code),
    UNIQUE KEY uq_group_fill_voucher_code (fill_voucher_code),
    KEY idx_group_arrival_status (arrival_status),
    KEY idx_group_dept           (dept_id),
    KEY idx_group_assigned       (assigned_staff_id),
    CONSTRAINT fk_group_dept        FOREIGN KEY (dept_id)           REFERENCES departments(id) ON DELETE SET NULL,
    CONSTRAINT fk_group_staff       FOREIGN KEY (assigned_staff_id) REFERENCES users(id)       ON DELETE SET NULL,
    CONSTRAINT fk_group_arrived_by  FOREIGN KEY (arrived_by)        REFERENCES users(id)       ON DELETE SET NULL,
    CONSTRAINT fk_group_departed_by FOREIGN KEY (departed_by)       REFERENCES users(id)       ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Group roles ──────────────────────────────────────────────────────────────
-- Per-group membership/role, mirroring user_dept_roles but scoped to a group
-- instead of a department. Wired into compute_permissions() (GROUP_ROLE_PERMISSIONS
-- in public/api/auth.php) — currently grants view_groups only, since the
-- permission model has no per-group scoping yet for mutating operations like
-- sub_checkout (only per-department, via dept_ids). Broader group-scoped write
-- permissions are a follow-up, not part of Phase 3.
CREATE TABLE IF NOT EXISTS group_roles (
    user_id  INT UNSIGNED NOT NULL,
    group_id INT UNSIGNED NOT NULL,
    role     ENUM('group_lead','group_member') NOT NULL DEFAULT 'group_member',
    PRIMARY KEY (user_id, group_id),
    CONSTRAINT fk_gr_user  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    CONSTRAINT fk_gr_group FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Shifts ───────────────────────────────────────────────────────────────────
-- is_standing marks a group's self-service shift: a group with
-- enable_self_service_shift=1 gets exactly one standing shift (group_id set,
-- wide-open active window, its single shift_tokens row equal to the group's
-- own qr_code — see _sync_group_standing_shift() in
-- public/api/routes/admin/groups.php), so scanning its QR is an ordinary
-- shift-token login (handle_shift_login() in public/api/routes/auth.php) that
-- replaced the old bespoke handle_barrio_identify() code path.
CREATE TABLE IF NOT EXISTS shifts (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name         VARCHAR(128) NOT NULL,
    dept_id      INT UNSIGNED NULL,
    group_id     INT UNSIGNED NULL,
    is_standing  TINYINT(1)   NOT NULL DEFAULT 0,
    permissions  TEXT         NOT NULL,
    active_from  DATETIME     NOT NULL,
    active_until DATETIME     NOT NULL,
    created_by   INT UNSIGNED NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_dept   (dept_id),
    KEY idx_group  (group_id),
    KEY idx_active (active_from, active_until),
    CONSTRAINT fk_shift_dept    FOREIGN KEY (dept_id)    REFERENCES departments(id) ON DELETE SET NULL,
    CONSTRAINT fk_shift_group   FOREIGN KEY (group_id)   REFERENCES groups(id)      ON DELETE SET NULL,
    CONSTRAINT fk_shift_creator FOREIGN KEY (created_by) REFERENCES users(id)       ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Shift tokens ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shift_tokens (
    id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
    shift_id INT UNSIGNED NOT NULL,
    token    VARCHAR(64)  NOT NULL,
    label    VARCHAR(64)  NULL,
    used_at  DATETIME     NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_token (token),
    KEY idx_shift (shift_id),
    CONSTRAINT fk_stok_shift FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── User department roles ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_dept_roles (
    user_id INT UNSIGNED NOT NULL,
    dept_id INT UNSIGNED NOT NULL,
    role    ENUM('dept_admin','dept_staff') NOT NULL DEFAULT 'dept_staff',
    PRIMARY KEY (user_id, dept_id),
    CONSTRAINT fk_udr_user FOREIGN KEY (user_id) REFERENCES users(id)       ON DELETE CASCADE,
    CONSTRAINT fk_udr_dept FOREIGN KEY (dept_id) REFERENCES departments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── User permission overrides ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_permissions (
    user_id    INT UNSIGNED NOT NULL,
    permission VARCHAR(64)  NOT NULL,
    granted    TINYINT(1)   NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, permission),
    CONSTRAINT fk_uperm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Invite tokens ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invite_tokens (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    token      VARCHAR(64)  NOT NULL,
    role       ENUM('production_admin','production_staff','dept_admin','dept_staff') NOT NULL,
    dept_id    INT UNSIGNED NULL,
    use_count  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_by INT UNSIGNED NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_token (token),
    KEY idx_expires (expires_at),
    CONSTRAINT fk_itok_dept    FOREIGN KEY (dept_id)    REFERENCES departments(id) ON DELETE SET NULL,
    CONSTRAINT fk_itok_creator FOREIGN KEY (created_by) REFERENCES users(id)       ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Consumable types ─────────────────────────────────────────────────────────
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

INSERT IGNORE INTO consumable_types (name, key_name, sort_order)
VALUES ('Water Fill', 'water_fill', 10);

-- Physical-voucher fallback: pure issuance bookkeeping ("how many paper
-- vouchers did we hand this group at arrival"), tracked via the same
-- group_entitlements/distribution_events mechanism as any other consumable
-- type, but deliberately a distinct type_id from water_fill so it can never
-- touch the real fill-credit ledger. See handle_barrio_distribute() and
-- handle_group_arrival(), which explicitly refuse to let water_fill itself
-- be distributed through this generic path.
INSERT IGNORE INTO consumable_types (name, key_name, sort_order)
VALUES ('Water Vouchers (Physical)', 'water_voucher_physical', 11);

-- ─── Group consumable entitlements ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_entitlements (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    group_id    INT UNSIGNED NOT NULL,
    type_id     INT UNSIGNED NOT NULL,
    purchased   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    distributed SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_group_type (group_id, type_id),
    CONSTRAINT fk_ent_group FOREIGN KEY (group_id) REFERENCES groups(id)          ON DELETE CASCADE,
    CONSTRAINT fk_ent_type  FOREIGN KEY (type_id)  REFERENCES consumable_types(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Distribution event log ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS distribution_events (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    group_id        INT UNSIGNED NOT NULL,
    type_id         INT UNSIGNED NOT NULL,
    quantity        SMALLINT     NOT NULL,
    performed_by    INT UNSIGNED,
    user_name_cache VARCHAR(128),
    occurred_at     DATETIME NOT NULL,
    notes           TEXT,
    PRIMARY KEY (id),
    KEY idx_group    (group_id),
    KEY idx_occurred (occurred_at),
    CONSTRAINT fk_dist_group FOREIGN KEY (group_id)     REFERENCES groups(id),
    CONSTRAINT fk_dist_type  FOREIGN KEY (type_id)      REFERENCES consumable_types(id),
    CONSTRAINT fk_dist_user  FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Storage locations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_locations (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    group_id    INT UNSIGNED NULL,
    name        VARCHAR(128) NOT NULL,
    description TEXT,
    latitude    DECIMAL(10,7) NULL,
    longitude   DECIMAL(10,7) NULL,
    qr_code     VARCHAR(64)  NOT NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_loc_qr (qr_code),
    CONSTRAINT fk_loc_group FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Equipment types ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS equipment_types (
    id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name                 VARCHAR(128) NOT NULL,
    category             VARCHAR(64),
    order_deadline       DATETIME     NULL,
    secure_qr            TINYINT(1)   NOT NULL DEFAULT 0,
    borrowable           TINYINT(1)   NOT NULL DEFAULT 0,
    is_crate             TINYINT(1)   NOT NULL DEFAULT 0,
    deployment_destination VARCHAR(255) NULL,
    home_location_id     INT UNSIGNED NULL,
    require_home_location TINYINT(1)  NOT NULL DEFAULT 0,
    require_any_location  TINYINT(1)  NOT NULL DEFAULT 0,
    created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_name (name),
    CONSTRAINT fk_type_home_loc FOREIGN KEY (home_location_id) REFERENCES storage_locations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Equipment items ──────────────────────────────────────────────────────────
-- Holder model: owning_dept_id is the department whose pool the item belongs to
-- (persists through sub-lending). holder_type/holder_id is who physically has
-- it right now — NULL means it's sitting in the production pool (available).
-- holder_id is polymorphic (departments/groups/users depending on holder_type)
-- so it cannot carry a single FK constraint; the trigger below instead enforces
-- that holder_type and status always agree, which is the invariant that
-- actually caused bugs under the old four-nullable-column design.
CREATE TABLE IF NOT EXISTS equipment_items (
    id                   INT UNSIGNED      NOT NULL AUTO_INCREMENT,
    equipment_type_id    INT UNSIGNED      NOT NULL,
    item_number          SMALLINT UNSIGNED NOT NULL,
    qr_code              VARCHAR(128)      NOT NULL,
    status               ENUM('available','checked-out','activated','used','retired') NOT NULL DEFAULT 'available',
    owning_dept_id       INT UNSIGNED      NULL,
    dept_label           VARCHAR(128)      NULL,
    holder_type          ENUM('department','group','person') NULL,
    holder_id            INT UNSIGNED      NULL,
    current_location_id  INT UNSIGNED      NULL,
    home_location_id     INT UNSIGNED      NULL,
    require_home_location TINYINT(1)       NULL,
    require_any_location  TINYINT(1)       NULL,
    notes                TEXT,
    route_position       SMALLINT UNSIGNED NULL,
    latitude             DECIMAL(10,7)     NULL,
    longitude            DECIMAL(10,7)     NULL,
    spec_values          TEXT              NULL     COMMENT 'JSON map of field_key -> value',
    photo                VARCHAR(255)      NULL     COMMENT 'Relative path to item photo',
    created_at           DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_qr          (qr_code),
    UNIQUE KEY uq_type_number (equipment_type_id, item_number),
    KEY idx_status      (status),
    KEY idx_dept_item   (owning_dept_id),
    KEY idx_item_holder (holder_type, holder_id),
    CONSTRAINT fk_item_type       FOREIGN KEY (equipment_type_id)   REFERENCES equipment_types(id),
    CONSTRAINT fk_item_dept       FOREIGN KEY (owning_dept_id)      REFERENCES departments(id)       ON DELETE SET NULL,
    CONSTRAINT fk_item_cur_loc    FOREIGN KEY (current_location_id) REFERENCES storage_locations(id) ON DELETE SET NULL,
    CONSTRAINT fk_item_home_loc   FOREIGN KEY (home_location_id)    REFERENCES storage_locations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Enforce holder_type/status consistency at the DB level — the exact gap that
-- previously required a hand-run repair migration when app code set a holder
-- without updating status (or vice versa).
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

-- ─── Equipment type spec fields ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS equipment_type_spec_fields (
    id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    equipment_type_id INT UNSIGNED  NOT NULL,
    field_key         VARCHAR(64)   NOT NULL,
    label             VARCHAR(128)  NOT NULL,
    field_type        ENUM('number','text','boolean','select') NOT NULL DEFAULT 'text',
    unit              VARCHAR(32)   NULL,
    options           TEXT          NULL,
    sort_order        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_type_key (equipment_type_id, field_key),
    KEY idx_sf_type (equipment_type_id),
    CONSTRAINT fk_sf_type FOREIGN KEY (equipment_type_id)
        REFERENCES equipment_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Group equipment orders ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_equipment_orders (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    group_id          INT UNSIGNED NOT NULL,
    equipment_type_id INT UNSIGNED NOT NULL,
    quantity_ordered  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_group_type (group_id, equipment_type_id),
    CONSTRAINT fk_eqord_group FOREIGN KEY (group_id)          REFERENCES groups(id)          ON DELETE CASCADE,
    CONSTRAINT fk_eqord_type  FOREIGN KEY (equipment_type_id) REFERENCES equipment_types(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Department equipment orders ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dept_equipment_orders (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    dept_id           INT UNSIGNED NOT NULL,
    equipment_type_id INT UNSIGNED NOT NULL,
    quantity_ordered  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    submitted_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    submitted_by      INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_dept_type (dept_id, equipment_type_id),
    CONSTRAINT fk_dord_dept FOREIGN KEY (dept_id)           REFERENCES departments(id)    ON DELETE CASCADE,
    CONSTRAINT fk_dord_type FOREIGN KEY (equipment_type_id) REFERENCES equipment_types(id),
    CONSTRAINT fk_dord_user FOREIGN KEY (submitted_by)      REFERENCES users(id)          ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Transactions ─────────────────────────────────────────────────────────────
-- holder_type/holder_id record who the item was assigned to or released from
-- by this transaction, mirroring equipment_items' holder model. dept_id is
-- always the owning department context (who lent it), independent of holder.
CREATE TABLE IF NOT EXISTS transactions (
    id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    type             ENUM('checkout','checkin','sub_checkout','sub_checkin','person_checkout','person_checkin','used','activated','fill_confirmed','fill_flagged','fill_requested','fill_adhoc','fill_cancelled','fill_delivered') NOT NULL,
    item_id          INT UNSIGNED  NOT NULL,
    dept_id          INT UNSIGNED  NULL,
    holder_type      ENUM('department','group','person') NULL,
    holder_id        INT UNSIGNED  NULL,
    location_id      INT UNSIGNED  NULL,
    performed_by     INT UNSIGNED  NULL,
    user_name_cache  VARCHAR(128)  NULL,
    is_offline_entry TINYINT(1)    NOT NULL DEFAULT 0,
    occurred_at      DATETIME      NOT NULL,
    created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes            TEXT,
    PRIMARY KEY (id),
    KEY idx_item        (item_id),
    KEY idx_txn_dept    (dept_id),
    KEY idx_txn_holder  (holder_type, holder_id),
    KEY idx_occurred    (occurred_at),
    KEY idx_type        (type),
    CONSTRAINT fk_txn_item     FOREIGN KEY (item_id)      REFERENCES equipment_items(id),
    CONSTRAINT fk_txn_dept     FOREIGN KEY (dept_id)      REFERENCES departments(id)        ON DELETE SET NULL,
    CONSTRAINT fk_txn_user     FOREIGN KEY (performed_by) REFERENCES users(id)              ON DELETE SET NULL,
    CONSTRAINT fk_txn_location FOREIGN KEY (location_id)  REFERENCES storage_locations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Named events ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name        VARCHAR(128) NOT NULL,
    event_date  DATE         NULL,
    is_active   TINYINT(1)   NOT NULL DEFAULT 0,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_events_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Per-item per-event deployment record ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_deployments (
    id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    item_id     INT UNSIGNED  NOT NULL,
    event_id    INT UNSIGNED  NOT NULL,
    notes       TEXT          NULL,
    latitude    DECIMAL(10,7) NULL,
    longitude   DECIMAL(10,7) NULL,
    logged_by   INT UNSIGNED  NULL,
    logged_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_item_event (item_id, event_id),
    KEY idx_dep_item  (item_id),
    KEY idx_dep_event (event_id),
    CONSTRAINT fk_dep_item  FOREIGN KEY (item_id)  REFERENCES equipment_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_dep_event FOREIGN KEY (event_id) REFERENCES events(id)          ON DELETE CASCADE,
    CONSTRAINT fk_dep_user  FOREIGN KEY (logged_by) REFERENCES users(id)          ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Item photo gallery ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_photos (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    item_id       INT UNSIGNED NOT NULL,
    deployment_id INT UNSIGNED NULL,
    path          VARCHAR(255) NOT NULL,
    caption       VARCHAR(255) NULL,
    uploaded_by   INT UNSIGNED NULL,
    uploaded_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_photo_item (item_id),
    KEY idx_photo_dep  (deployment_id),
    CONSTRAINT fk_photo_item FOREIGN KEY (item_id)       REFERENCES equipment_items(id)  ON DELETE CASCADE,
    CONSTRAINT fk_photo_dep  FOREIGN KEY (deployment_id) REFERENCES item_deployments(id) ON DELETE SET NULL,
    CONSTRAINT fk_photo_user FOREIGN KEY (uploaded_by)   REFERENCES users(id)            ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Equipment borrow rules ───────────────────────────────────────────────────
-- If ANY rules exist for a type/item, only matching users/depts can borrow.
-- If no rules exist, any user with person_checkout permission can borrow.
-- item_id rules take precedence over type-level rules for that item.
CREATE TABLE IF NOT EXISTS equipment_borrow_rules (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    equipment_type_id INT UNSIGNED NULL,
    item_id           INT UNSIGNED NULL,
    allowed_dept_id   INT UNSIGNED NULL,
    allowed_user_id   INT UNSIGNED NULL,
    PRIMARY KEY (id),
    KEY idx_type (equipment_type_id),
    KEY idx_item (item_id),
    CONSTRAINT fk_brule_type FOREIGN KEY (equipment_type_id) REFERENCES equipment_types(id) ON DELETE CASCADE,
    CONSTRAINT fk_brule_item FOREIGN KEY (item_id)           REFERENCES equipment_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_brule_dept FOREIGN KEY (allowed_dept_id)   REFERENCES departments(id)     ON DELETE CASCADE,
    CONSTRAINT fk_brule_user FOREIGN KEY (allowed_user_id)   REFERENCES users(id)           ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Person badge QR pool ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS person_tokens (
    id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    token        VARCHAR(64)   NOT NULL,
    label        VARCHAR(64)   NULL,
    user_id      INT UNSIGNED  NULL,
    display_name VARCHAR(128)  NULL,
    claimed_at   DATETIME      NULL,
    created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_token (token),
    KEY idx_user (user_id),
    CONSTRAINT fk_person_token_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Fill run direction claims ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fill_run_claims (
    id          INT UNSIGNED      NOT NULL AUTO_INCREMENT,
    direction   ENUM('asc','desc') NOT NULL,
    user_name   VARCHAR(128)      NULL,
    user_id     INT UNSIGNED      NULL,
    claimed_at  DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released    TINYINT(1)        NOT NULL DEFAULT 0,
    released_at DATETIME          NULL,
    PRIMARY KEY (id),
    KEY idx_frc_dir     (direction),
    KEY idx_frc_claimed (claimed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Fill requests: per-run truck route feed ─────────────────────────────────
-- cube_item_id NULL  → group-level request (any of their cubes filled, up to fills_requested)
-- cube_item_id SET   → cube-specific request (NWP: route truck to that exact cube)
CREATE TABLE IF NOT EXISTS fill_requests (
    id               INT UNSIGNED      NOT NULL AUTO_INCREMENT,
    group_id         INT UNSIGNED      NOT NULL,
    cube_item_id     INT UNSIGNED      NULL,
    fills_requested  TINYINT UNSIGNED  NOT NULL DEFAULT 1,
    fills_completed  TINYINT UNSIGNED  NOT NULL DEFAULT 0,
    status           ENUM('pending','partial','filled','cancelled') NOT NULL DEFAULT 'pending',
    requested_at     DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    requested_by     INT UNSIGNED      NULL,
    filled_at        DATETIME          NULL,
    filled_by        INT UNSIGNED      NULL,
    notes            TEXT              NULL,
    via_physical_voucher TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'Requested on the group''s behalf via a redeemed paper voucher, not the digital flow',
    PRIMARY KEY (id),
    KEY idx_fr_group   (group_id),
    KEY idx_fr_cube    (cube_item_id),
    KEY idx_fr_status  (status),
    CONSTRAINT fk_fr_cube     FOREIGN KEY (cube_item_id)  REFERENCES equipment_items(id) ON DELETE SET NULL,
    CONSTRAINT fk_fr_group    FOREIGN KEY (group_id)      REFERENCES groups(id)          ON DELETE CASCADE,
    CONSTRAINT fk_fr_req_user FOREIGN KEY (requested_by)  REFERENCES users(id)           ON DELETE SET NULL,
    CONSTRAINT fk_fr_fil_user FOREIGN KEY (filled_by)     REFERENCES users(id)           ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── QR Print Templates ──────────────────────────────────────────────────────
-- Stores PDF/image templates and zone definitions for QR label generation.
CREATE TABLE IF NOT EXISTS qr_templates (
    id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    name           VARCHAR(128)  NOT NULL,
    pdf_filename   VARCHAR(256)  NULL,
    item_filter    VARCHAR(64)   NULL,
    layout_mode    ENUM('page','grid') NOT NULL DEFAULT 'page',
    tag_width_mm   FLOAT NULL,
    tag_height_mm  FLOAT NULL,
    page_cols      TINYINT UNSIGNED NOT NULL DEFAULT 1,
    page_rows      TINYINT UNSIGNED NOT NULL DEFAULT 1,
    margin_mm      FLOAT NOT NULL DEFAULT 10,
    gap_mm         FLOAT NOT NULL DEFAULT 5,
    page_width_mm  FLOAT NULL,
    page_height_mm FLOAT NULL,
    created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS qr_template_zones (
    id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    template_id  INT UNSIGNED  NOT NULL,
    zone_type    ENUM('qr_code','item_number','item_name','custom_text') NOT NULL,
    page         TINYINT UNSIGNED NOT NULL DEFAULT 1,
    x_mm         FLOAT         NOT NULL,
    y_mm         FLOAT         NOT NULL,
    size_mm      FLOAT         NOT NULL,
    custom_value VARCHAR(256)  NULL,
    font_size    TINYINT UNSIGNED NOT NULL DEFAULT 12,
    PRIMARY KEY (id),
    KEY idx_ztpl (template_id),
    CONSTRAINT fk_zone_template FOREIGN KEY (template_id) REFERENCES qr_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Crate manifest ──────────────────────────────────────────────────────────
-- Stores the current contents list for crate-type equipment items.
CREATE TABLE IF NOT EXISTS crate_manifest (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    item_id       INT UNSIGNED NOT NULL,
    content_name  VARCHAR(255) NOT NULL,
    quantity      SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    notes         VARCHAR(255) NULL,
    sort_order    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_crate_manifest_item (item_id),
    CONSTRAINT fk_crate_manifest_item FOREIGN KEY (item_id)
        REFERENCES equipment_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Site map overlay ────────────────────────────────────────────────────────
-- Per-event KMZ/KML site plan (structures, containers, barrio footprints)
-- rendered as a reference layer on the Fill Route maps. Singleton in
-- practice — the app deletes any existing row before inserting a new upload.
CREATE TABLE IF NOT EXISTS map_overlays (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name          VARCHAR(255) NOT NULL,
    geojson       LONGTEXT     NOT NULL,
    feature_count INT UNSIGNED NOT NULL DEFAULT 0,
    uploaded_by   INT UNSIGNED NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_map_overlay_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

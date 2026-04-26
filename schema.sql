-- Barrio Support — database schema
-- MySQL 5.7+ / MariaDB 10.3+
-- Import via phpMyAdmin or: mysql -u user -p barrio_support < schema.sql

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ─── Users ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    username      VARCHAR(64)     NOT NULL,
    display_name  VARCHAR(128)    NOT NULL,
    password_hash VARCHAR(255)    NOT NULL,
    role          ENUM('admin','staff') NOT NULL DEFAULT 'staff',
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login    DATETIME,
    is_active     TINYINT(1)      NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    UNIQUE KEY uq_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Barrios ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS barrios (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name       VARCHAR(128) NOT NULL,
    sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Equipment types ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS equipment_types (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name       VARCHAR(128) NOT NULL,
    category   VARCHAR(64),
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Equipment items ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS equipment_items (
    id                INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    equipment_type_id INT UNSIGNED     NOT NULL,
    item_number       SMALLINT UNSIGNED NOT NULL,
    qr_code           VARCHAR(128)     NOT NULL,
    status            ENUM('available','checked-out','retired') NOT NULL DEFAULT 'available',
    current_barrio_id INT UNSIGNED,
    notes             TEXT,
    created_at        DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_qr (qr_code),
    UNIQUE KEY uq_type_number (equipment_type_id, item_number),
    KEY idx_status (status),
    KEY idx_barrio (current_barrio_id),
    CONSTRAINT fk_item_type   FOREIGN KEY (equipment_type_id) REFERENCES equipment_types(id),
    CONSTRAINT fk_item_barrio FOREIGN KEY (current_barrio_id) REFERENCES barrios(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── Transactions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
    id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    type             ENUM('checkout','checkin') NOT NULL,
    item_id          INT UNSIGNED  NOT NULL,
    barrio_id        INT UNSIGNED,
    performed_by     INT UNSIGNED,
    user_name_cache  VARCHAR(128),
    is_offline_entry TINYINT(1)    NOT NULL DEFAULT 0,
    occurred_at      DATETIME      NOT NULL,
    created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes            TEXT,
    PRIMARY KEY (id),
    KEY idx_item      (item_id),
    KEY idx_barrio    (barrio_id),
    KEY idx_occurred  (occurred_at),
    KEY idx_type      (type),
    CONSTRAINT fk_txn_item     FOREIGN KEY (item_id)      REFERENCES equipment_items(id),
    CONSTRAINT fk_txn_barrio   FOREIGN KEY (barrio_id)    REFERENCES barrios(id),
    CONSTRAINT fk_txn_user     FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

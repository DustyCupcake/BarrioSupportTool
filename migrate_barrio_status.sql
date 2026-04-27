-- Barrio arrival/departure tracking migration
-- Run via phpMyAdmin: Import this file against the barrio_support database

ALTER TABLE barrios
  ADD COLUMN arrival_status  ENUM('expected','on-site','departed') NOT NULL DEFAULT 'expected' AFTER sort_order,
  ADD COLUMN arrived_at       DATETIME     NULL,
  ADD COLUMN arrived_by       INT UNSIGNED NULL,
  ADD COLUMN arrived_by_name  VARCHAR(128) NULL,
  ADD COLUMN water_vouchers   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN ice_tokens       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN orientation_done TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN departed_at      DATETIME     NULL,
  ADD COLUMN departed_by      INT UNSIGNED NULL,
  ADD COLUMN departed_by_name VARCHAR(128) NULL,
  ADD CONSTRAINT fk_barrio_arrived_by  FOREIGN KEY (arrived_by)  REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_barrio_departed_by FOREIGN KEY (departed_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_barrios_arrival_status ON barrios (arrival_status);

-- Activation status migration for split-voucher water run scheduling
-- Run once: mysql -u user -p barrio_support < migrate_activate.sql

ALTER TABLE equipment_items
  MODIFY status ENUM('available','checked-out','activated','used','retired') NOT NULL DEFAULT 'available';

ALTER TABLE transactions
  MODIFY type ENUM('checkout','checkin','used','activated') NOT NULL;

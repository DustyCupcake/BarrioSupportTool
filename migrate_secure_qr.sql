-- Secure QR voucher migration
-- Run once: mysql -u user -p barrio_support < migrate_secure_qr.sql

ALTER TABLE equipment_types
  ADD COLUMN secure_qr TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE equipment_items
  MODIFY status ENUM('available','checked-out','retired','used') NOT NULL DEFAULT 'available';

ALTER TABLE transactions
  MODIFY type ENUM('checkout','checkin','used') NOT NULL;

ALTER TABLE users
  MODIFY role ENUM('admin','staff','validator') NOT NULL DEFAULT 'staff';

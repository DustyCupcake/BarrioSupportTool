<?php
/**
 * First-run seed script.
 * Run once from the command line (NOT via the web) to create the first admin user:
 *
 *   php seed.php
 *
 * Or to specify credentials directly:
 *
 *   php seed.php admin MySecretPassword123 "Your Name"
 */

declare(strict_types=1);

require_once __DIR__ . '/api/lib/db.php';

$username     = $argv[1] ?? readline('Admin username: ');
$password     = $argv[2] ?? readline('Admin password (min 8 chars): ');
$display_name = $argv[3] ?? readline('Display name: ');

$username     = trim($username);
$display_name = trim($display_name);

if (strlen($username) < 2 || strlen($password) < 8 || strlen($display_name) < 1) {
    echo "Error: username (min 2 chars), password (min 8 chars), and display name are all required.\n";
    exit(1);
}

try {
    $hash = password_hash($password, PASSWORD_BCRYPT);
    $stmt = db()->prepare(
        "INSERT INTO users (username, display_name, password_hash, role)
         VALUES (?, ?, ?, 'admin')
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin'"
    );
    $stmt->execute([$username, $display_name, $hash]);
    echo "Admin user '{$username}' created (or updated) successfully.\n";
} catch (PDOException $e) {
    echo "Database error: " . $e->getMessage() . "\n";
    exit(1);
}

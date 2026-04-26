<?php
/**
 * One-time web setup script — creates the first admin user.
 * Use when SSH is unavailable (e.g. Namecheap shared hosting).
 *
 * Usage:
 *   1. Set SETUP_TOKEN in your .env to a long random string.
 *   2. Visit https://yourdomain.com/setup.php?token=<your_token>
 *   3. Fill in the form and submit.
 *   4. DELETE this file from the server immediately after use.
 */

declare(strict_types=1);

// ── Token check ────────────────────────────────────────────────────────────

$env = parse_ini_file(__DIR__ . '/.env');
$setup_token = trim((string) ($env['SETUP_TOKEN'] ?? ''));

$provided_token = trim((string) ($_REQUEST['token'] ?? ''));

if (
    $setup_token === '' ||
    $setup_token === 'change_me' ||
    !hash_equals($setup_token, $provided_token)
) {
    http_response_code(403);
    die('Forbidden.');
}

// ── DB connection ──────────────────────────────────────────────────────────

require_once __DIR__ . '/api/lib/db.php';

// ── Already-seeded check ───────────────────────────────────────────────────

$admin_count = (int) db()->query("SELECT COUNT(*) FROM users WHERE role = 'admin'")->fetchColumn();
if ($admin_count > 0) {
    http_response_code(403);
    die('<p style="font-family:sans-serif;color:#c00;padding:2rem">Setup already complete. <strong>Delete setup.php from your server.</strong></p>');
}

// ── Handle form POST ───────────────────────────────────────────────────────

$error   = '';
$success = false;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username     = trim($_POST['username']     ?? '');
    $display_name = trim($_POST['display_name'] ?? '');
    $password     = $_POST['password']          ?? '';
    $password2    = $_POST['password2']         ?? '';

    if (strlen($username) < 2) {
        $error = 'Username must be at least 2 characters.';
    } elseif (strlen($display_name) < 1) {
        $error = 'Display name is required.';
    } elseif (strlen($password) < 8) {
        $error = 'Password must be at least 8 characters.';
    } elseif ($password !== $password2) {
        $error = 'Passwords do not match.';
    } else {
        try {
            $hash = password_hash($password, PASSWORD_BCRYPT);
            $stmt = db()->prepare(
                "INSERT INTO users (username, display_name, password_hash, role)
                 VALUES (?, ?, ?, 'admin')
                 ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin'"
            );
            $stmt->execute([$username, $display_name, $hash]);
            $success = true;
        } catch (PDOException $e) {
            $error = 'Database error: ' . htmlspecialchars($e->getMessage());
        }
    }
}

$token_html = htmlspecialchars($provided_token);
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Barrio Support — First-time Setup</title>
<style>
  body { font-family: sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1   { font-size: 1.4rem; margin-bottom: .25rem; }
  p.sub{ color: #666; margin-top: 0; font-size: .9rem; }
  label{ display: block; margin-top: 1rem; font-weight: 600; font-size: .9rem; }
  input{ width: 100%; box-sizing: border-box; padding: .5rem .75rem; margin-top: .3rem;
         border: 1px solid #bbb; border-radius: 4px; font-size: 1rem; }
  button{ margin-top: 1.5rem; width: 100%; padding: .75rem; background: #1a73e8;
          color: #fff; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #1558b0; }
  .error  { background: #fde8e8; border: 1px solid #e57373; padding: .75rem 1rem;
            border-radius: 4px; color: #c00; margin-top: 1rem; }
  .success{ background: #e8f5e9; border: 1px solid #81c784; padding: 1rem;
            border-radius: 4px; margin-top: 1rem; }
  .warn   { background: #fff3e0; border: 1px solid #ffb74d; padding: .75rem 1rem;
            border-radius: 4px; margin-top: 1.5rem; font-size: .9rem; }
</style>
</head>
<body>

<h1>Barrio Support — First-time Setup</h1>
<p class="sub">Create the initial admin account.</p>

<?php if ($success): ?>

  <div class="success">
    <strong>Admin account created successfully.</strong>
    You can now <a href="login.html">log in</a>.
  </div>
  <div class="warn">
    <strong>Important:</strong> Delete <code>setup.php</code> from your server immediately
    (via cPanel File Manager or FTP). This page will be inaccessible once any admin exists.
  </div>

<?php else: ?>

  <?php if ($error !== ''): ?>
    <div class="error"><?= htmlspecialchars($error) ?></div>
  <?php endif; ?>

  <form method="post" action="?token=<?= $token_html ?>">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username"
           value="<?= htmlspecialchars($_POST['username'] ?? '') ?>" required>

    <label for="display_name">Display name</label>
    <input id="display_name" name="display_name" type="text"
           value="<?= htmlspecialchars($_POST['display_name'] ?? '') ?>" required>

    <label for="password">Password <small style="font-weight:normal">(min 8 chars)</small></label>
    <input id="password" name="password" type="password" autocomplete="new-password" required>

    <label for="password2">Confirm password</label>
    <input id="password2" name="password2" type="password" autocomplete="new-password" required>

    <button type="submit">Create Admin Account</button>
  </form>

<?php endif; ?>

</body>
</html>

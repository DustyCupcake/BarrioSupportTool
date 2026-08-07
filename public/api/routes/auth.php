<?php
declare(strict_types=1);

function handle_login(): void {
    require_method('POST');
    start_session();

    $b        = body();
    $username = trim($b['username'] ?? '');
    $password = $b['password'] ?? '';

    if ($username === '' || $password === '') {
        json_error('Username and password required');
    }

    $stmt = db()->prepare(
        'SELECT id, username, display_name, password_hash, role, language, is_active
         FROM users WHERE username = ?'
    );
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if (!$user || !$user['is_active']) {
        json_error('Invalid credentials', 401);
    }
    if ($user['role'] === 'person' || $user['password_hash'] === null) {
        json_error('Use your badge QR code to sign in', 401);
    }
    if (!password_verify($password, $user['password_hash'])) {
        json_error('Invalid credentials', 401);
    }

    db()->prepare('UPDATE users SET last_login = NOW() WHERE id = ?')->execute([$user['id']]);

    // Load dept memberships with manages_groups info
    $dept_stmt = db()->prepare(
        'SELECT udr.dept_id, udr.role, d.manages_groups, d.name AS dept_name
         FROM user_dept_roles udr
         JOIN departments d ON d.id = udr.dept_id
         WHERE udr.user_id = ?'
    );
    $dept_stmt->execute([$user['id']]);
    $memberships = $dept_stmt->fetchAll();

    $dept_ids            = array_column($memberships, 'dept_id');
    $dept_roles          = [];
    $dept_manages_groups = [];
    foreach ($memberships as $m) {
        $dept_roles[(int)$m['dept_id']]          = $m['role'];
        $dept_manages_groups[(int)$m['dept_id']] = (bool)$m['manages_groups'];
    }

    // Load per-user permission overrides
    $perm_stmt = db()->prepare('SELECT permission, granted FROM user_permissions WHERE user_id = ?');
    $perm_stmt->execute([$user['id']]);
    $perm_overrides = $perm_stmt->fetchAll();

    // Load group_roles memberships (per-group access independent of department staff status)
    $group_stmt = db()->prepare('SELECT group_id, role FROM group_roles WHERE user_id = ?');
    $group_stmt->execute([$user['id']]);
    $group_memberships = $group_stmt->fetchAll();
    $group_ids          = array_map('intval', array_column($group_memberships, 'group_id'));

    $permissions = compute_permissions($user['role'], $memberships, $perm_overrides, $group_memberships);

    $qr_token = ensure_user_qr_token((int)$user['id']);
    $csrf     = bin2hex(random_bytes(32));
    $_SESSION = [
        'user_id'             => (int)$user['id'],
        'username'            => $user['username'],
        'display_name'        => $user['display_name'],
        'role'                => $user['role'],
        'dept_ids'            => array_map('intval', $dept_ids),
        'dept_roles'          => $dept_roles,
        'dept_manages_groups' => $dept_manages_groups,
        'group_ids'           => $group_ids,
        'permissions'         => $permissions,
        'language'            => $user['language'] ?? 'en',
        'is_shift'            => false,
        'shift_id'            => null,
        'shift_name'          => null,
        'qr_token'            => $qr_token,
        'csrf_token'          => $csrf,
    ];

    json_ok([
        'id'                  => (int)$user['id'],
        'username'            => $user['username'],
        'display_name'        => $user['display_name'],
        'role'                => $user['role'],
        'dept_ids'            => $_SESSION['dept_ids'],
        'dept_roles'          => $_SESSION['dept_roles'],
        'dept_manages_groups' => $dept_manages_groups,
        'group_ids'           => $group_ids,
        'permissions'         => $permissions,
        'language'            => $_SESSION['language'],
        'is_shift'            => false,
        'qr_token'            => $qr_token,
        'csrf_token'          => $csrf,
    ]);
}

function handle_logout(): void {
    require_method('POST');
    start_session();
    session_destroy();
    json_ok(['success' => true]);
}

function handle_me(): void {
    require_method('GET');
    $user = require_auth();
    json_ok(array_merge($user, ['csrf_token' => csrf_token()]));
}

function handle_csrf(): void {
    require_method('GET');
    start_session();
    json_ok(['csrf_token' => csrf_token()]);
}

function handle_register(): void {
    require_method('POST');

    $b            = body();
    $invite_token = trim($b['invite_token'] ?? '');
    $username     = trim($b['username'] ?? '');
    $display_name = trim($b['display_name'] ?? '');
    $password     = $b['password'] ?? '';
    $confirm      = $b['confirm_password'] ?? '';

    if ($invite_token === '') {
        json_error('An invite link is required to register', 403);
    }

    $tok_stmt = db()->prepare(
        'SELECT * FROM invite_tokens
         WHERE token = ? AND use_count < 1 AND expires_at > NOW()'
    );
    $tok_stmt->execute([$invite_token]);
    $tok = $tok_stmt->fetch();

    if (!$tok) {
        json_error('Invite link is invalid or has expired', 403);
    }

    if ($username === '' || $display_name === '' || $password === '') {
        json_error('All fields are required', 400);
    }
    if (strlen($password) < 8) {
        json_error('Password must be at least 8 characters', 400);
    }
    if ($password !== $confirm) {
        json_error('Passwords do not match', 400);
    }

    $hash = password_hash($password, PASSWORD_BCRYPT);
    $pdo  = db();
    $pdo->beginTransaction();
    try {
        $pdo->prepare(
            'INSERT INTO users (username, display_name, password_hash, role, is_active)
             VALUES (?, ?, ?, ?, 1)'
        )->execute([$username, $display_name, $hash, $tok['role']]);

        $new_user_id = (int)$pdo->lastInsertId();

        // Add dept membership if role is dept-level
        if ($tok['dept_id'] && in_array($tok['role'], ['dept_admin', 'dept_staff'], true)) {
            $pdo->prepare(
                'INSERT INTO user_dept_roles (user_id, dept_id, role) VALUES (?, ?, ?)'
            )->execute([$new_user_id, $tok['dept_id'], $tok['role']]);
        }

        $pdo->prepare(
            'UPDATE invite_tokens SET use_count = use_count + 1 WHERE id = ?'
        )->execute([$tok['id']]);

        $pdo->commit();
    } catch (PDOException $e) {
        $pdo->rollBack();
        if (str_contains($e->getMessage(), 'Duplicate') || str_contains($e->getMessage(), '1062')) {
            json_error('Username already taken', 409);
        }
        throw $e;
    }

    json_ok(['message' => 'Account created. You can now log in.'], 201);
}

function handle_invite_info(): void {
    require_method('GET');
    $token = trim($_GET['token'] ?? '');

    if ($token === '') {
        json_error('token required', 400);
    }

    $stmt = db()->prepare(
        'SELECT it.role, it.expires_at, it.use_count,
                d.name AS dept_name
         FROM invite_tokens it
         LEFT JOIN departments d ON d.id = it.dept_id
         WHERE it.token = ?'
    );
    $stmt->execute([$token]);
    $tok = $stmt->fetch();

    if (!$tok) {
        json_ok(['valid' => false, 'reason' => 'not_found']);
        return;
    }
    if ($tok['use_count'] >= 1) {
        json_ok(['valid' => false, 'reason' => 'used']);
        return;
    }
    if (strtotime($tok['expires_at']) < time()) {
        json_ok(['valid' => false, 'reason' => 'expired']);
        return;
    }

    json_ok([
        'valid'     => true,
        'role'      => $tok['role'],
        'dept_name' => $tok['dept_name'],
    ]);
}

function handle_shift_info(): void {
    require_method('GET');
    $token = trim($_GET['token'] ?? '');

    if ($token === '') {
        json_error('token required', 400);
    }

    $stmt = db()->prepare(
        'SELECT st.*, s.name AS shift_name, s.active_from, s.active_until, s.permissions,
                d.name AS dept_name
         FROM shift_tokens st
         JOIN shifts s ON s.id = st.shift_id
         LEFT JOIN departments d ON d.id = s.dept_id
         WHERE st.token = ?'
    );
    $stmt->execute([$token]);
    $tok = $stmt->fetch();

    if (!$tok) {
        json_ok(['valid' => false, 'reason' => 'not_found']);
        return;
    }

    $now = time();
    if (strtotime($tok['active_from']) > $now) {
        json_ok(['valid' => false, 'reason' => 'not_started', 'active_from' => $tok['active_from']]);
        return;
    }
    if (strtotime($tok['active_until']) < $now) {
        json_ok(['valid' => false, 'reason' => 'ended', 'active_until' => $tok['active_until']]);
        return;
    }

    $perms = json_decode($tok['permissions'], true) ?: [];

    json_ok([
        'valid'               => true,
        'shift_name'          => $tok['shift_name'],
        'dept_name'           => $tok['dept_name'],
        'active_from'         => $tok['active_from'],
        'active_until'        => $tok['active_until'],
        'permissions_summary' => $perms,
    ]);
}

// Handles both admin-issued volunteer shifts and a group's standing
// self-service shift (is_standing=1, whose single token is the group's own
// qr_code — see _sync_group_standing_shift() in admin/groups.php). Standing
// shifts skip the volunteer_name prompt entirely: anyone who can see the
// group's QR gets in, same as the old bespoke handle_barrio_identify() did.
function handle_shift_login(): void {
    require_method('POST');
    start_session();

    $b              = body();
    $token          = trim($b['token'] ?? '');
    $volunteer_name = trim($b['volunteer_name'] ?? '');

    if ($token === '') json_error('token required', 400);

    $stmt = db()->prepare(
        'SELECT st.id, st.shift_id,
                s.name AS shift_name, s.permissions, s.dept_id, s.group_id, s.is_standing,
                s.active_from, s.active_until, g.name AS group_name
         FROM shift_tokens st
         JOIN shifts s ON s.id = st.shift_id
         LEFT JOIN groups g ON g.id = s.group_id
         WHERE st.token = ?'
    );
    $stmt->execute([$token]);
    $tok = $stmt->fetch();

    if (!$tok) json_error('Invalid shift code', 401);

    $is_standing = (bool)$tok['is_standing'];
    if (!$is_standing && $volunteer_name === '') {
        json_error('token and volunteer_name required', 400);
    }

    $now = time();
    if (strtotime($tok['active_from']) > $now) json_error('This shift has not started yet', 403);
    if (strtotime($tok['active_until']) < $now) json_error('This shift has ended', 403);

    // Record use (allow re-use within shift window — volunteer may close/reopen browser)
    db()->prepare('UPDATE shift_tokens SET used_at = NOW() WHERE id = ?')->execute([$tok['id']]);

    $perms = json_decode($tok['permissions'], true) ?: [];
    $csrf  = bin2hex(random_bytes(32));

    $group_id   = $tok['group_id'] ? (int)$tok['group_id'] : null;
    $display_name = $is_standing
        ? ($tok['group_name'] ?? $tok['shift_name'])
        : $volunteer_name . ' (' . $tok['shift_name'] . ')';

    session_regenerate_id(true);
    $_SESSION = [
        'user_id'      => null,
        'username'     => null,
        'display_name' => $display_name,
        'role'         => null,
        'dept_ids'     => $tok['dept_id'] ? [(int)$tok['dept_id']] : [],
        'dept_roles'   => [],
        'permissions'  => $perms,
        'language'     => 'en',
        'is_shift'     => true,
        'shift_id'     => (int)$tok['shift_id'],
        'shift_name'   => $tok['shift_name'],
        'group_id'     => $group_id,
        'csrf_token'   => $csrf,
    ];

    json_ok([
        'success'      => true,
        'display_name' => $display_name,
        'permissions'  => $perms,
        'is_shift'     => true,
        'shift_name'   => $tok['shift_name'],
        'group_id'     => $group_id,
        'barrio_id'    => $group_id,
        'group_name'   => $tok['group_name'],
        'barrio_name'  => $tok['group_name'],
        'csrf_token'   => $csrf,
    ]);
}

function handle_change_password(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    if ($user['is_shift']) {
        json_error('Cannot change password in shift session', 403);
    }

    $b           = body();
    $current     = $b['current_password'] ?? '';
    $new_pass    = $b['new_password'] ?? '';
    $confirm     = $b['confirm_password'] ?? '';

    if ($current === '' || $new_pass === '' || $confirm === '') {
        json_error('All fields are required', 400);
    }
    if (strlen($new_pass) < 8) {
        json_error('New password must be at least 8 characters', 400);
    }
    if ($new_pass !== $confirm) {
        json_error('Passwords do not match', 400);
    }

    $stmt = db()->prepare('SELECT password_hash FROM users WHERE id = ?');
    $stmt->execute([$user['id']]);
    $row = $stmt->fetch();

    if (!$row || !password_verify($current, $row['password_hash'])) {
        json_error('Current password is incorrect', 403);
    }

    $hash = password_hash($new_pass, PASSWORD_BCRYPT);
    db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        ->execute([$hash, $user['id']]);

    json_ok(['success' => true]);
}

// ─── Person badge session endpoints ───────────────────────────────────────────

function handle_person_token_info(): void {
    require_method('GET');
    $token = trim($_GET['token'] ?? '');
    if ($token === '') json_error('token required', 400);

    $stmt = db()->prepare(
        'SELECT id, label, display_name, claimed_at FROM person_tokens WHERE token = ?'
    );
    $stmt->execute([$token]);
    $row = $stmt->fetch();

    if (!$row) {
        json_ok(['valid' => false]);
        return;
    }

    json_ok([
        'valid'        => true,
        'claimed'      => $row['claimed_at'] !== null,
        'display_name' => $row['display_name'],
        'label'        => $row['label'],
    ]);
}

function handle_person_claim(): void {
    require_method('POST');
    start_session();

    $b            = body();
    $token        = trim($b['token'] ?? '');
    $display_name = trim($b['display_name'] ?? '');

    if ($token === '' || $display_name === '') {
        json_error('token and display_name required', 400);
    }
    if (strlen($display_name) < 2) {
        json_error('Name must be at least 2 characters', 400);
    }

    $stmt = db()->prepare(
        'SELECT id, user_id, claimed_at FROM person_tokens WHERE token = ?'
    );
    $stmt->execute([$token]);
    $tok = $stmt->fetch();

    if (!$tok) json_error('Badge not found', 404);
    if ($tok['claimed_at'] !== null) json_error('Badge already claimed — use sign-in instead', 409);

    $pdo = db();
    $pdo->beginTransaction();
    try {
        // Create minimal user record — no username, no password
        $pdo->prepare(
            'INSERT INTO users (username, display_name, password_hash, role, is_active)
             VALUES (NULL, ?, NULL, "person", 1)'
        )->execute([$display_name]);
        $user_id = (int)$pdo->lastInsertId();

        // Set qr_token on user so existing /person-info?qr= lookup works
        $pdo->prepare('UPDATE users SET qr_token = ? WHERE id = ?')->execute([$token, $user_id]);

        // Claim the token
        $pdo->prepare(
            'UPDATE person_tokens SET user_id = ?, display_name = ?, claimed_at = NOW() WHERE id = ?'
        )->execute([$user_id, $display_name, $tok['id']]);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Failed to claim badge: ' . $e->getMessage(), 500);
    }

    $perm_stmt = db()->prepare('SELECT permission, granted FROM user_permissions WHERE user_id = ?');
    $perm_stmt->execute([$user_id]);
    $permissions = compute_permissions('person', [], $perm_stmt->fetchAll());

    $csrf = bin2hex(random_bytes(32));
    session_regenerate_id(true);
    $_SESSION = [
        'user_id'           => $user_id,
        'username'          => null,
        'display_name'      => $display_name,
        'role'              => 'person',
        'dept_ids'          => [],
        'dept_roles'        => [],
        'dept_manages_groups' => (object)[],
        'permissions'       => $permissions,
        'language'          => 'en',
        'is_shift'          => false,
        'is_person'         => true,
        'qr_token'          => $token,
        'csrf_token'        => $csrf,
    ];

    json_ok([
        'display_name' => $display_name,
        'permissions'  => $permissions,
        'is_person'    => true,
        'qr_token'     => $token,
        'csrf_token'   => $csrf,
    ], 201);
}

function handle_person_login(): void {
    require_method('POST');
    start_session();

    $b            = body();
    $token        = trim($b['token'] ?? '');
    $display_name = trim($b['display_name'] ?? '');

    if ($token === '' || $display_name === '') {
        json_error('token and display_name required', 400);
    }

    $stmt = db()->prepare(
        'SELECT pt.id, pt.user_id, pt.display_name, pt.claimed_at, u.is_active
         FROM person_tokens pt
         LEFT JOIN users u ON u.id = pt.user_id
         WHERE pt.token = ?'
    );
    $stmt->execute([$token]);
    $tok = $stmt->fetch();

    if (!$tok) json_error('Badge not found', 404);
    if ($tok['claimed_at'] === null) json_error('Badge not yet claimed — claim it first', 409);
    if (!$tok['is_active']) json_error('This badge has been deactivated', 403);

    // Case-insensitive name match
    if (strtolower(trim($tok['display_name'])) !== strtolower($display_name)) {
        json_error('Name does not match', 401);
    }

    $perm_stmt = db()->prepare('SELECT permission, granted FROM user_permissions WHERE user_id = ?');
    $perm_stmt->execute([(int)$tok['user_id']]);
    $permissions = compute_permissions('person', [], $perm_stmt->fetchAll());

    $csrf = bin2hex(random_bytes(32));
    session_regenerate_id(true);
    $_SESSION = [
        'user_id'           => (int)$tok['user_id'],
        'username'          => null,
        'display_name'      => $tok['display_name'],
        'role'              => 'person',
        'dept_ids'          => [],
        'dept_roles'        => [],
        'dept_manages_groups' => (object)[],
        'permissions'       => $permissions,
        'language'          => 'en',
        'is_shift'          => false,
        'is_person'         => true,
        'qr_token'          => $token,
        'csrf_token'        => $csrf,
    ];

    json_ok([
        'display_name' => $tok['display_name'],
        'permissions'  => $permissions,
        'is_person'    => true,
        'qr_token'     => $token,
        'csrf_token'   => $csrf,
    ]);
}

function handle_language(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    if ($user['is_shift']) {
        json_error('Cannot change language in shift session', 403);
    }

    $b    = body();
    $lang = trim($b['lang'] ?? '');

    if (!preg_match('/^[a-z]{2,5}$/', $lang)) {
        json_error('Invalid language code');
    }

    db()->prepare('UPDATE users SET language = ? WHERE id = ?')->execute([$lang, $user['id']]);
    $_SESSION['language'] = $lang;
    unset($_SESSION['_auth_cache']);

    json_ok(['success' => true, 'language' => $lang]);
}

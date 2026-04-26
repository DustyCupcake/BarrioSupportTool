<?php
declare(strict_types=1);

function handle_login(): void {
    require_method('POST');
    start_session();

    $b = body();
    $username = trim($b['username'] ?? '');
    $password = $b['password'] ?? '';

    if ($username === '' || $password === '') {
        json_error('Username and password required');
    }

    $stmt = db()->prepare('SELECT id, username, display_name, password_hash, role, is_active FROM users WHERE username = ?');
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    if (!$user || !$user['is_active'] || !password_verify($password, $user['password_hash'])) {
        json_error('Invalid credentials', 401);
    }

    db()->prepare('UPDATE users SET last_login = NOW() WHERE id = ?')->execute([$user['id']]);

    $_SESSION['user_id']      = $user['id'];
    $_SESSION['username']     = $user['username'];
    $_SESSION['display_name'] = $user['display_name'];
    $_SESSION['role']         = $user['role'];
    $_SESSION['csrf_token']   = bin2hex(random_bytes(32));

    json_ok([
        'id'           => $user['id'],
        'username'     => $user['username'],
        'display_name' => $user['display_name'],
        'role'         => $user['role'],
        'csrf_token'   => $_SESSION['csrf_token'],
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

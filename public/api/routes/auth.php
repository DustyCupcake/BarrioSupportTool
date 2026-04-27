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

function handle_register(): void {
    require_method('POST');

    $b            = body();
    $username     = trim($b['username'] ?? '');
    $display_name = trim($b['display_name'] ?? '');
    $password     = $b['password'] ?? '';
    $confirm      = $b['confirm_password'] ?? '';

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

    try {
        db()->prepare(
            'INSERT INTO users (username, display_name, password_hash, role, is_active) VALUES (?, ?, ?, \'staff\', 0)'
        )->execute([$username, $display_name, $hash]);
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate') || str_contains($e->getMessage(), '1062')) {
            json_error('Username already taken', 409);
        }
        throw $e;
    }

    json_ok(['message' => 'Account created. An admin will activate your account before you can log in.'], 201);
}

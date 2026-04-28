<?php
declare(strict_types=1);

// Call require_auth() at the top of any route that needs a logged-in user.
// Call require_admin() for admin-only routes.

function start_session(): void {
    if (session_status() === PHP_SESSION_NONE) {
        session_set_cookie_params([
            'lifetime' => 3600 * 24 * 3, // 3 days
            'path'     => '/',
            'secure'   => isset($_SERVER['HTTPS']),
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        session_start();
    }
}

function require_auth(): array {
    start_session();
    if (empty($_SESSION['user_id'])) {
        json_error('Unauthorized', 401);
    }
    return [
        'id'           => $_SESSION['user_id'],
        'username'     => $_SESSION['username'],
        'display_name' => $_SESSION['display_name'],
        'role'         => $_SESSION['role'],
    ];
}

function require_admin(): array {
    $user = require_auth();
    if ($user['role'] !== 'admin') {
        json_error('Forbidden', 403);
    }
    return $user;
}

function csrf_token(): string {
    start_session();
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

function verify_csrf(): void {
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (empty($token) || !hash_equals($_SESSION['csrf_token'] ?? '', $token)) {
        json_error('CSRF token invalid', 403);
    }
}

<?php
declare(strict_types=1);

function handle_list(): void {
    require_method('GET');
    require_admin();

    $rows = db()->query(
        'SELECT id, username, display_name, role, is_active, created_at, last_login FROM users ORDER BY display_name'
    )->fetchAll();
    foreach ($rows as &$r) {
        $r['id']        = (int)$r['id'];
        $r['is_active'] = (bool)$r['is_active'];
    }
    unset($r);
    json_ok(['users' => $rows]);
}

function handle_create(): void {
    require_method('POST');
    require_admin();
    verify_csrf();

    $b            = body();
    $username     = trim($b['username'] ?? '');
    $display_name = trim($b['display_name'] ?? '');
    $password     = $b['password'] ?? '';
    $role         = $b['role'] ?? 'staff';

    if ($username === '' || $display_name === '' || strlen($password) < 8) {
        json_error('username, display_name, and password (min 8 chars) required');
    }
    if (!in_array($role, ['admin', 'staff', 'validator'], true)) json_error('invalid role');

    $hash = password_hash($password, PASSWORD_BCRYPT);

    try {
        $stmt = db()->prepare(
            'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([$username, $display_name, $hash, $role]);
        $id = (int)db()->lastInsertId();
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('Username already exists', 409);
        throw $e;
    }

    json_ok(['id' => $id, 'username' => $username, 'display_name' => $display_name, 'role' => $role], 201);
}

function handle_update(): void {
    require_method('PUT');
    require_admin();
    verify_csrf();

    $b            = body();
    $id           = (int)($b['id'] ?? $_GET['id'] ?? 0);
    $display_name = trim($b['display_name'] ?? '');
    $role         = $b['role'] ?? null;
    $is_active    = $b['is_active'] ?? null;

    if (!$id) json_error('id required');

    $sets   = [];
    $params = [];

    if ($display_name !== '') { $sets[] = 'display_name = ?'; $params[] = $display_name; }
    if ($role !== null) {
        if (!in_array($role, ['admin', 'staff', 'validator'], true)) json_error('invalid role');
        $sets[]   = 'role = ?';
        $params[] = $role;
    }
    if ($is_active !== null) {
        $sets[]   = 'is_active = ?';
        $params[] = $is_active ? 1 : 0;
    }

    if (empty($sets)) json_error('Nothing to update');

    $params[] = $id;
    $stmt = db()->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = ?');
    $stmt->execute($params);

    if ($stmt->rowCount() === 0) json_error('User not found', 404);
    json_ok(['success' => true]);
}

function handle_reset_password(): void {
    require_method('POST');
    require_admin();
    verify_csrf();

    $b        = body();
    $id       = (int)($b['id'] ?? $_GET['id'] ?? 0);
    $password = $b['new_password'] ?? '';

    if (!$id) json_error('id required');
    if (strlen($password) < 8) json_error('Password must be at least 8 characters');

    $hash = password_hash($password, PASSWORD_BCRYPT);
    $stmt = db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    $stmt->execute([$hash, $id]);

    if ($stmt->rowCount() === 0) json_error('User not found', 404);
    json_ok(['success' => true]);
}

function handle_delete(): void {
    require_method('DELETE');
    require_admin();
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? $_GET['id'] ?? 0);
    if (!$id) json_error('id required');

    // Prevent self-deletion
    start_session();
    if ($id === (int)($_SESSION['user_id'] ?? 0)) {
        json_error('Cannot delete your own account', 409);
    }

    // Soft deactivate instead of hard delete to preserve transaction history
    $stmt = db()->prepare('UPDATE users SET is_active = 0 WHERE id = ?');
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) json_error('User not found', 404);

    json_ok(['success' => true]);
}

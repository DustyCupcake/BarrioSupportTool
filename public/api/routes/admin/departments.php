<?php
declare(strict_types=1);

function handle_list_departments_admin(): void {
    require_method('GET');
    require_permission('manage_departments');

    $rows = db()->query(
        'SELECT d.id, d.name,
                IFNULL(d.qr_code, "") AS qr_code,
                d.slug, d.manages_groups, d.sort_order, d.is_active, d.created_at,
                COUNT(DISTINCT udr.user_id) AS member_count
         FROM departments d
         LEFT JOIN user_dept_roles udr ON udr.dept_id = d.id
         GROUP BY d.id
         ORDER BY d.sort_order, d.name'
    )->fetchAll();

    foreach ($rows as &$r) {
        $r['id']             = (int)$r['id'];
        $r['sort_order']     = (int)$r['sort_order'];
        $r['is_active']      = (bool)$r['is_active'];
        $r['member_count']   = (int)$r['member_count'];
        $r['manages_groups'] = (bool)$r['manages_groups'];
    }
    unset($r);

    json_ok(['departments' => $rows]);
}

function handle_create_department(): void {
    require_method('POST');
    require_permission('manage_departments');
    verify_csrf();

    $b              = body();
    $name           = trim($b['name'] ?? '');
    $slug           = trim($b['slug'] ?? '');
    $manages_groups = !empty($b['manages_groups']) ? 1 : 0;
    $sort_order     = (int)($b['sort_order'] ?? 0);

    if ($name === '' || $slug === '') {
        json_error('name and slug required');
    }
    if (!preg_match('/^[a-z0-9_]+$/', $slug)) {
        json_error('slug must be lowercase letters, digits, and underscores only');
    }

    $qr_code = bin2hex(random_bytes(12));

    try {
        db()->prepare(
            'INSERT INTO departments (name, qr_code, slug, manages_groups, sort_order) VALUES (?, ?, ?, ?, ?)'
        )->execute([$name, $qr_code, $slug, $manages_groups, $sort_order]);
        $id = (int)db()->lastInsertId();
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name or slug already exists', 409);
        throw $e;
    }

    json_ok(['id' => $id, 'name' => $name, 'qr_code' => $qr_code, 'slug' => $slug, 'manages_groups' => (bool)$manages_groups], 201);
}

function handle_update_department(): void {
    require_method('PUT');
    require_permission('manage_departments');
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? 0);
    if (!$id) json_error('id required');

    $sets   = [];
    $params = [];

    foreach (['name', 'slug'] as $f) {
        if (isset($b[$f]) && trim($b[$f]) !== '') {
            $sets[]   = "$f = ?";
            $params[] = trim($b[$f]);
        }
    }
    if (isset($b['sort_order']))     { $sets[] = 'sort_order = ?';     $params[] = (int)$b['sort_order']; }
    if (isset($b['is_active']))      { $sets[] = 'is_active = ?';      $params[] = $b['is_active'] ? 1 : 0; }
    if (array_key_exists('manages_groups', $b)) {
        $sets[] = 'manages_groups = ?'; $params[] = !empty($b['manages_groups']) ? 1 : 0;
    }

    if (empty($sets)) json_error('Nothing to update');

    $params[] = $id;
    db()->prepare('UPDATE departments SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
    json_ok(['success' => true]);
}

function handle_delete_department(): void {
    require_method('DELETE');
    require_permission('manage_departments');
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? 0);
    if (!$id) json_error('id required');

    $mbr_stmt = db()->prepare(
        'SELECT COUNT(*) FROM user_dept_roles WHERE dept_id = ?'
    );
    $mbr_stmt->execute([$id]);
    $members = (int)$mbr_stmt->fetchColumn();

    if ($members > 0) {
        json_error('Cannot delete department with active members', 409);
    }

    $itm_stmt = db()->prepare(
        'SELECT COUNT(*) FROM equipment_items WHERE owning_dept_id = ?'
    );
    $itm_stmt->execute([$id]);
    $items = (int)$itm_stmt->fetchColumn();

    if ($items > 0) {
        json_error('Cannot delete department with checked-out equipment', 409);
    }

    db()->prepare('DELETE FROM departments WHERE id = ?')->execute([$id]);
    json_ok(['success' => true]);
}

function handle_dept_members(): void {
    require_method('GET');
    $user = require_auth();

    $dept_id = (int)($_GET['dept_id'] ?? 0);
    if (!$dept_id) json_error('dept_id required');

    // Must have access to this dept
    require_dept_access($dept_id);

    $stmt = db()->prepare(
        'SELECT u.id, u.username, u.display_name, u.role AS base_role, u.is_active,
                udr.role AS dept_role
         FROM user_dept_roles udr
         JOIN users u ON u.id = udr.user_id
         WHERE udr.dept_id = ?
         ORDER BY u.display_name'
    );
    $stmt->execute([$dept_id]);
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) {
        $r['id']        = (int)$r['id'];
        $r['is_active'] = (bool)$r['is_active'];
    }
    unset($r);

    json_ok(['members' => $rows]);
}

function handle_set_dept_role(): void {
    require_method('PUT');
    $caller     = require_auth();
    verify_csrf();

    $full_admin = has_permission('manage_users');
    $dept_admin = has_permission('manage_dept_users');
    if (!$full_admin && !$dept_admin) json_error('Forbidden', 403);

    $b       = body();
    $user_id = (int)($b['user_id'] ?? 0);
    $dept_id = (int)($b['dept_id'] ?? 0);
    $role    = trim($b['role'] ?? '');

    if (!$user_id || !$dept_id) json_error('user_id and dept_id required');

    // Dept admins may only modify their own teams, and may not promote to dept_admin
    if (!$full_admin) {
        if (!in_array($dept_id, $caller['dept_ids'], true)) json_error('Forbidden', 403);
        if ($role !== '' && $role !== 'remove' && $role !== 'dept_staff') {
            json_error('Forbidden', 403);
        }
    }

    if ($role === '' || $role === 'remove') {
        db()->prepare('DELETE FROM user_dept_roles WHERE user_id = ? AND dept_id = ?')
            ->execute([$user_id, $dept_id]);
    } else {
        if (!in_array($role, ['dept_admin', 'dept_staff'], true)) {
            json_error('role must be dept_admin or dept_staff');
        }
        db()->prepare(
            'INSERT INTO user_dept_roles (user_id, dept_id, role) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE role = VALUES(role)'
        )->execute([$user_id, $dept_id, $role]);
    }

    json_ok(['success' => true]);
}

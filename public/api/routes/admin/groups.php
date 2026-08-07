<?php
declare(strict_types=1);

// Admin CRUD for groups — merges what used to be separate admin/barrios.php
// and admin/artists.php. A group is any team/camp/collective a department
// lends equipment to; enable_arrival_tracking / enable_consumable_entitlements
// are per-group capability flags rather than a hardcoded barrio/artist split.

function handle_list(): void {
    require_method('GET');
    $user = require_permission('manage_groups');

    $where  = '';
    $params = [];

    if (!has_permission('manage_departments')) {
        $placeholders = implode(',', array_fill(0, count($user['dept_ids']), '?'));
        $where        = $placeholders ? "WHERE g.dept_id IN ($placeholders)" : 'WHERE 1=0';
        $params       = $user['dept_ids'];
    } elseif (isset($_GET['dept_id'])) {
        $where  = 'WHERE g.dept_id = ?';
        $params = [(int)$_GET['dept_id']];
    }

    $stmt = db()->prepare(
        "SELECT g.id, g.dept_id, d.name AS dept_name, g.name, g.sort_order,
                g.assigned_staff_id, u.display_name AS assigned_staff_name,
                g.enable_arrival_tracking, g.enable_consumable_entitlements,
                g.enable_self_service_shift,
                g.arrival_status, g.created_at
         FROM groups g
         LEFT JOIN departments d ON d.id = g.dept_id
         LEFT JOIN users u ON u.id = g.assigned_staff_id
         $where
         ORDER BY g.sort_order, g.name"
    );
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) {
        $r['id']                             = (int)$r['id'];
        $r['dept_id']                        = $r['dept_id'] !== null ? (int)$r['dept_id'] : null;
        $r['assigned_staff_id']              = $r['assigned_staff_id'] !== null ? (int)$r['assigned_staff_id'] : null;
        $r['enable_arrival_tracking']        = (bool)$r['enable_arrival_tracking'];
        $r['enable_consumable_entitlements'] = (bool)$r['enable_consumable_entitlements'];
        $r['enable_self_service_shift']      = (bool)$r['enable_self_service_shift'];
    }
    unset($r);

    json_ok(['groups' => $rows, 'barrios' => $rows, 'artists' => $rows]);
}

// Ensures a group's standing self-service shift (is_standing=1, group_id set,
// wide-open active window, request_fills-only permission set) exists and is
// active, or deactivates it — instead of the old bespoke handle_barrio_identify()
// code path. The shift's single token is the group's own qr_code, so scanning
// the group's QR is an ordinary shift-token login (see handle_shift_login()).
function _sync_group_standing_shift(int $group_id, ?string $group_qr, string $group_name, bool $enable, ?int $actor_id): void {
    $pdo = db();

    $stmt = $pdo->prepare('SELECT id FROM shifts WHERE group_id = ? AND is_standing = 1 LIMIT 1');
    $stmt->execute([$group_id]);
    $shift_id = $stmt->fetchColumn();

    if (!$enable) {
        if ($shift_id) {
            $pdo->prepare('UPDATE shifts SET active_until = NOW() WHERE id = ?')->execute([(int)$shift_id]);
        }
        return;
    }

    // Legacy groups migrated before qr_code was mandatory may not have one yet
    // (see the backfill in admin/group_qr.php) — generate one now so the
    // standing shift always has a real token to key off.
    if (!$group_qr) {
        $group_qr = bin2hex(random_bytes(12));
        $pdo->prepare('UPDATE groups SET qr_code = ? WHERE id = ?')->execute([$group_qr, $group_id]);
    }

    if ($shift_id) {
        $pdo->prepare("UPDATE shifts SET active_until = '2099-12-31 23:59:59', name = ? WHERE id = ?")
            ->execute([$group_name . ' — Self Service', (int)$shift_id]);
        $shift_id = (int)$shift_id;
    } else {
        $pdo->prepare(
            "INSERT INTO shifts (name, dept_id, group_id, is_standing, permissions, active_from, active_until, created_by)
             VALUES (?, NULL, ?, 1, ?, '2000-01-01 00:00:00', '2099-12-31 23:59:59', ?)"
        )->execute([$group_name . ' — Self Service', $group_id, json_encode(['request_fills']), $actor_id]);
        $shift_id = (int)$pdo->lastInsertId();
    }

    $tok_stmt = $pdo->prepare('SELECT id FROM shift_tokens WHERE shift_id = ? AND token = ?');
    $tok_stmt->execute([$shift_id, $group_qr]);
    if (!$tok_stmt->fetch()) {
        $pdo->prepare('INSERT INTO shift_tokens (shift_id, token, label) VALUES (?, ?, ?)')
            ->execute([$shift_id, $group_qr, 'Group QR']);
    }
}

function handle_create(): void {
    require_method('POST');
    $user = require_permission('manage_groups');
    verify_csrf();

    $b                              = body();
    $name                           = trim($b['name'] ?? '');
    $dept_id                        = isset($b['dept_id']) ? (int)$b['dept_id'] : null;
    $sort_order                     = (int)($b['sort_order'] ?? 0);
    $assigned_staff_id              = isset($b['assigned_staff_id']) ? (int)$b['assigned_staff_id'] : null;
    $enable_arrival_tracking        = !empty($b['enable_arrival_tracking']);
    $enable_consumable_entitlements = !empty($b['enable_consumable_entitlements']);
    $enable_self_service_shift      = !empty($b['enable_self_service_shift']);

    if ($name === '') json_error('name required');

    // dept_admin access check
    if ($dept_id && !has_permission('manage_departments') && !in_array($dept_id, $user['dept_ids'], true)) {
        json_error('Forbidden', 403);
    }

    // Resolve assigned_staff by username if string provided
    if (isset($b['assigned_staff_username']) && !$assigned_staff_id && $dept_id) {
        $u_stmt = db()->prepare(
            'SELECT u.id FROM users u
             JOIN user_dept_roles udr ON udr.user_id = u.id
             WHERE u.username = ? AND udr.dept_id = ?'
        );
        $u_stmt->execute([trim($b['assigned_staff_username']), $dept_id]);
        $u = $u_stmt->fetch();
        if ($u) $assigned_staff_id = (int)$u['id'];
    }

    $qr_code = bin2hex(random_bytes(12));

    try {
        $stmt = db()->prepare(
            'INSERT INTO groups (name, qr_code, dept_id, sort_order, assigned_staff_id,
                                  enable_arrival_tracking, enable_consumable_entitlements,
                                  enable_self_service_shift)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $name, $qr_code, $dept_id, $sort_order, $assigned_staff_id,
            $enable_arrival_tracking ? 1 : 0, $enable_consumable_entitlements ? 1 : 0,
            $enable_self_service_shift ? 1 : 0,
        ]);
        $id = (int)db()->lastInsertId();
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name already exists in this department', 409);
        throw $e;
    }

    if ($enable_self_service_shift) {
        _sync_group_standing_shift($id, $qr_code, $name, true, $user['id']);
    }

    json_ok(['id' => $id, 'name' => $name, 'qr_code' => $qr_code, 'sort_order' => $sort_order], 201);
}

function handle_update(): void {
    require_method('PUT');
    $user = require_permission('manage_groups');
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? $_GET['id'] ?? 0);
    if (!$id) json_error('id required');

    $group_stmt = db()->prepare('SELECT dept_id, name, qr_code FROM groups WHERE id = ?');
    $group_stmt->execute([$id]);
    $group = $group_stmt->fetch();
    if (!$group) json_error('Group not found', 404);

    if ($group['dept_id'] && !has_permission('manage_departments') && !in_array((int)$group['dept_id'], $user['dept_ids'], true)) {
        json_error('Forbidden', 403);
    }

    $sets   = [];
    $params = [];

    if (isset($b['name']) && trim($b['name']) !== '') {
        $sets[] = 'name = ?'; $params[] = trim($b['name']);
    }
    if (isset($b['sort_order'])) {
        $sets[] = 'sort_order = ?'; $params[] = (int)$b['sort_order'];
    }
    if (array_key_exists('dept_id', $b)) {
        $sets[] = 'dept_id = ?'; $params[] = $b['dept_id'] ? (int)$b['dept_id'] : null;
    }
    if (array_key_exists('assigned_staff_id', $b)) {
        $sets[] = 'assigned_staff_id = ?';
        $params[] = $b['assigned_staff_id'] ? (int)$b['assigned_staff_id'] : null;
    }
    if (array_key_exists('enable_arrival_tracking', $b)) {
        $sets[] = 'enable_arrival_tracking = ?'; $params[] = !empty($b['enable_arrival_tracking']) ? 1 : 0;
    }
    if (array_key_exists('enable_consumable_entitlements', $b)) {
        $sets[] = 'enable_consumable_entitlements = ?'; $params[] = !empty($b['enable_consumable_entitlements']) ? 1 : 0;
    }
    if (isset($b['arrival_status'])) {
        $valid_statuses = ['expected', 'on-site', 'departed'];
        if (!in_array($b['arrival_status'], $valid_statuses, true)) json_error('Invalid arrival_status');
        $sets[] = 'arrival_status = ?'; $params[] = $b['arrival_status'];
    }
    if (array_key_exists('enable_self_service_shift', $b)) {
        $sets[] = 'enable_self_service_shift = ?'; $params[] = !empty($b['enable_self_service_shift']) ? 1 : 0;
    }

    if (empty($sets)) json_error('Nothing to update');

    $params[] = $id;
    try {
        db()->prepare('UPDATE groups SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name already exists in this department', 409);
        throw $e;
    }

    if (array_key_exists('enable_self_service_shift', $b)) {
        $new_name = isset($b['name']) && trim($b['name']) !== '' ? trim($b['name']) : $group['name'];
        _sync_group_standing_shift($id, $group['qr_code'], $new_name, !empty($b['enable_self_service_shift']), $user['id']);
    }

    json_ok(['success' => true]);
}

function handle_delete(): void {
    require_method('DELETE');
    $user = require_permission('manage_groups');
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? $_GET['id'] ?? 0);
    if (!$id) json_error('id required');

    $count_stmt = db()->prepare('SELECT COUNT(*) FROM equipment_items WHERE holder_type = \'group\' AND holder_id = ?');
    $count_stmt->execute([$id]);
    if ((int)$count_stmt->fetchColumn() > 0) {
        json_error('Cannot delete — items are currently checked out to this group', 409);
    }

    db()->prepare('DELETE FROM groups WHERE id = ?')->execute([$id]);
    json_ok(['success' => true]);
}

// ─── POST /admin/groups/import-locations-csv ──────────────────────────────────
// Import group storage locations from a CSV file.
// Required columns: group_name (or barrio_name), location_name, latitude, longitude
// Upserts storage_locations rows keyed by (group_id, name).
function handle_import_locations_csv(): void {
    require_method('POST');
    require_permission('manage_groups');
    verify_csrf();

    if (empty($_FILES['file']['tmp_name'])) json_error('No file uploaded');

    $fh = fopen($_FILES['file']['tmp_name'], 'r');
    if (!$fh) json_error('Failed to read file');

    $header = fgetcsv($fh);
    if (!$header) { fclose($fh); json_error('Empty CSV'); }

    $header = array_map('strtolower', array_map('trim', $header));
    $name_col = in_array('group_name', $header, true) ? 'group_name' : 'barrio_name';
    $required = [$name_col, 'location_name', 'latitude', 'longitude'];
    foreach ($required as $col) {
        if (!in_array($col, $header, true)) {
            fclose($fh);
            json_error("Missing required column: $col");
        }
    }
    $idx = array_flip($header);

    // Cache group name → id (case-insensitive)
    $group_map = [];
    $rows = db()->query('SELECT id, LOWER(name) AS lname FROM groups')->fetchAll();
    foreach ($rows as $r) $group_map[$r['lname']] = (int)$r['id'];

    $pdo = db();
    $created = 0; $updated = 0; $skipped = 0; $errors = [];
    $line = 1;

    while (($row = fgetcsv($fh)) !== false) {
        $line++;
        $group_name    = strtolower(trim($row[$idx[$name_col]]     ?? ''));
        $location_name = trim($row[$idx['location_name']] ?? '');
        $lat_raw       = trim($row[$idx['latitude']]      ?? '');
        $lng_raw       = trim($row[$idx['longitude']]     ?? '');

        if ($group_name === '' || $location_name === '' || $lat_raw === '' || $lng_raw === '') {
            $skipped++;
            continue;
        }

        if (!isset($group_map[$group_name])) {
            $errors[] = "Line $line: group not found — \"$group_name\"";
            continue;
        }

        if (!is_numeric($lat_raw) || !is_numeric($lng_raw)) {
            $errors[] = "Line $line: invalid lat/lng — \"$lat_raw\", \"$lng_raw\"";
            continue;
        }

        $group_id = $group_map[$group_name];
        $lat      = (float)$lat_raw;
        $lng      = (float)$lng_raw;

        // Check for existing location with same group + name
        $stmt = $pdo->prepare('SELECT id FROM storage_locations WHERE group_id = ? AND name = ?');
        $stmt->execute([$group_id, $location_name]);
        $existing = $stmt->fetch();

        if ($existing) {
            $stmt = $pdo->prepare('UPDATE storage_locations SET latitude = ?, longitude = ? WHERE id = ?');
            $stmt->execute([$lat, $lng, (int)$existing['id']]);
            $updated++;
        } else {
            $qr_code = bin2hex(random_bytes(12));
            $stmt = $pdo->prepare(
                'INSERT INTO storage_locations (group_id, name, latitude, longitude, qr_code) VALUES (?, ?, ?, ?, ?)'
            );
            $stmt->execute([$group_id, $location_name, $lat, $lng, $qr_code]);
            $created++;
        }
    }

    fclose($fh);
    json_ok(['created' => $created, 'updated' => $updated, 'skipped' => $skipped, 'errors' => $errors]);
}

// ─── POST /admin/groups/import-csv ────────────────────────────────────────────
// Dept-scoped group import (formerly the artists importer): name, sort_order,
// assigned_staff columns, all groups created under a single given dept_id.
function handle_import_groups_csv(): void {
    require_method('POST');
    $user = require_permission('manage_groups');
    verify_csrf();

    $dept_id = (int)($_GET['dept_id'] ?? 0);
    if (!$dept_id) json_error('dept_id required');

    if (!has_permission('manage_departments') && !in_array($dept_id, $user['dept_ids'], true)) {
        json_error('Forbidden', 403);
    }

    if (empty($_FILES['file'])) json_error('file required', 400);

    $path = $_FILES['file']['tmp_name'];
    $fh   = fopen($path, 'r');
    if (!$fh) json_error('Could not read file');

    $header  = array_map('strtolower', array_map('trim', fgetcsv($fh)));
    if (isset($header[0])) $header[0] = preg_replace('/^\xEF\xBB\xBF/', '', $header[0]);
    $name_i  = array_search('name', $header);
    $order_i = array_search('sort_order', $header);
    $staff_i = array_search('assigned_staff', $header);

    if ($name_i === false) {
        fclose($fh);
        json_error('CSV must have a "name" column');
    }

    $created = $updated = $skipped = 0;

    while (($row = fgetcsv($fh)) !== false) {
        $name = trim($row[$name_i] ?? '');
        if ($name === '') { $skipped++; continue; }

        $sort_order = $order_i !== false ? (int)($row[$order_i] ?? 0) : 0;

        $assigned_staff_id = null;
        if ($staff_i !== false && trim($row[$staff_i] ?? '') !== '') {
            $u_stmt = db()->prepare(
                'SELECT u.id FROM users u JOIN user_dept_roles udr ON udr.user_id = u.id
                 WHERE u.username = ? AND udr.dept_id = ?'
            );
            $u_stmt->execute([trim($row[$staff_i]), $dept_id]);
            $u = $u_stmt->fetch();
            if ($u) $assigned_staff_id = (int)$u['id'];
        }

        $exists_stmt = db()->prepare('SELECT id FROM groups WHERE dept_id = ? AND name = ?');
        $exists_stmt->execute([$dept_id, $name]);
        $exists = $exists_stmt->fetch();

        if ($exists) {
            db()->prepare(
                'UPDATE groups SET sort_order = ?, assigned_staff_id = ? WHERE id = ?'
            )->execute([$sort_order, $assigned_staff_id, $exists['id']]);
            $updated++;
        } else {
            $qr_code = bin2hex(random_bytes(12));
            db()->prepare(
                'INSERT INTO groups (dept_id, name, qr_code, sort_order, assigned_staff_id) VALUES (?, ?, ?, ?, ?)'
            )->execute([$dept_id, $name, $qr_code, $sort_order, $assigned_staff_id]);
            $created++;
        }
    }
    fclose($fh);

    json_ok(['created' => $created, 'updated' => $updated, 'skipped' => $skipped]);
}

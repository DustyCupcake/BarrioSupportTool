<?php
declare(strict_types=1);

// ─── Equipment Types ───────────────────────────────────────────────────────

function handle_list_types(): void {
    require_method('GET');
    require_admin();

    $rows = db()->query(
        'SELECT t.id, t.name, t.category, t.secure_qr, t.borrowable, t.is_crate, t.deployment_destination,
                t.home_location_id, t.require_home_location, t.require_any_location,
                sl.name AS home_location_name,
                t.created_at,
                COUNT(i.id) AS item_count
         FROM equipment_types t
         LEFT JOIN equipment_items i ON i.equipment_type_id = t.id AND i.status != "retired"
         LEFT JOIN storage_locations sl ON sl.id = t.home_location_id
         GROUP BY t.id
         ORDER BY t.name'
    )->fetchAll();

    $sf_stmt = db()->query(
        'SELECT id, equipment_type_id, field_key, label, field_type, unit, options, sort_order
         FROM equipment_type_spec_fields ORDER BY equipment_type_id, sort_order'
    );
    $fields_by_type = [];
    foreach ($sf_stmt->fetchAll() as $f) {
        $tid = (int)$f['equipment_type_id'];
        $fields_by_type[$tid][] = [
            'id'         => (int)$f['id'],
            'field_key'  => $f['field_key'],
            'label'      => $f['label'],
            'field_type' => $f['field_type'],
            'unit'       => $f['unit'],
            'options'    => $f['options'] ? json_decode($f['options'], true) : null,
            'sort_order' => (int)$f['sort_order'],
        ];
    }

    foreach ($rows as &$r) {
        $r['id']                    = (int)$r['id'];
        $r['item_count']            = (int)$r['item_count'];
        $r['secure_qr']             = (bool)$r['secure_qr'];
        $r['borrowable']            = (bool)$r['borrowable'];
        $r['is_crate']              = (bool)$r['is_crate'];
        $r['require_home_location'] = (bool)$r['require_home_location'];
        $r['require_any_location']  = (bool)$r['require_any_location'];
        $r['home_location_id']      = $r['home_location_id'] ? (int)$r['home_location_id'] : null;
        $r['spec_fields']           = $fields_by_type[$r['id']] ?? [];
    }
    unset($r);
    json_ok(['types' => $rows]);
}

function handle_create_type(): void {
    require_method('POST');
    require_admin();
    verify_csrf();

    $b                    = body();
    $name                 = trim($b['name'] ?? '');
    $category             = trim($b['category'] ?? '');
    $secure_qr            = !empty($b['secure_qr']) ? 1 : 0;
    $borrowable           = !empty($b['borrowable']) ? 1 : 0;
    $is_crate             = !empty($b['is_crate']) ? 1 : 0;
    $deployment_destination = isset($b['deployment_destination']) && trim($b['deployment_destination']) !== ''
        ? trim($b['deployment_destination']) : null;
    $home_location_id     = isset($b['home_location_id']) && $b['home_location_id'] !== '' ? (int)$b['home_location_id'] : null;
    $require_home_location = !empty($b['require_home_location']) ? 1 : 0;
    $require_any_location  = !empty($b['require_any_location']) ? 1 : 0;

    if ($name === '') json_error('name required');

    try {
        $stmt = db()->prepare(
            'INSERT INTO equipment_types (name, category, secure_qr, borrowable, is_crate, deployment_destination, home_location_id, require_home_location, require_any_location)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$name, $category ?: null, $secure_qr, $borrowable, $is_crate, $deployment_destination, $home_location_id, $require_home_location, $require_any_location]);
        $id = (int)db()->lastInsertId();
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name already exists', 409);
        throw $e;
    }

    json_ok(['id' => $id, 'name' => $name, 'category' => $category ?: null, 'secure_qr' => (bool)$secure_qr], 201);
}

function handle_update_type(): void {
    require_method('PUT');
    require_admin();
    verify_csrf();

    $b                    = body();
    $id                   = (int)($b['id'] ?? $_GET['id'] ?? 0);
    $name                 = trim($b['name'] ?? '');
    $category             = trim($b['category'] ?? '');
    $secure_qr            = isset($b['secure_qr']) ? (!empty($b['secure_qr']) ? 1 : 0) : null;
    $borrowable           = isset($b['borrowable']) ? (!empty($b['borrowable']) ? 1 : 0) : null;
    $is_crate             = isset($b['is_crate'])   ? (!empty($b['is_crate'])   ? 1 : 0) : null;
    $deployment_destination = array_key_exists('deployment_destination', $b)
        ? (trim($b['deployment_destination'] ?? '') !== '' ? trim($b['deployment_destination']) : null)
        : false; // false = not provided
    $home_location_id     = array_key_exists('home_location_id', $b)
        ? ($b['home_location_id'] !== '' && $b['home_location_id'] !== null ? (int)$b['home_location_id'] : null)
        : false; // false = not provided
    $require_home_location = isset($b['require_home_location']) ? (!empty($b['require_home_location']) ? 1 : 0) : null;
    $require_any_location  = isset($b['require_any_location'])  ? (!empty($b['require_any_location'])  ? 1 : 0) : null;

    if (!$id || $name === '') json_error('id and name required');

    $sets   = ['name = ?', 'category = ?'];
    $params = [$name, $category ?: null];

    if ($secure_qr !== null)                 { $sets[] = 'secure_qr = ?';               $params[] = $secure_qr; }
    if ($borrowable !== null)                { $sets[] = 'borrowable = ?';              $params[] = $borrowable; }
    if ($is_crate !== null)                  { $sets[] = 'is_crate = ?';               $params[] = $is_crate; }
    if ($deployment_destination !== false)   { $sets[] = 'deployment_destination = ?'; $params[] = $deployment_destination; }
    if ($home_location_id !== false)         { $sets[] = 'home_location_id = ?';        $params[] = $home_location_id; }
    if ($require_home_location !== null)     { $sets[] = 'require_home_location = ?';  $params[] = $require_home_location; }
    if ($require_any_location !== null)      { $sets[] = 'require_any_location = ?';   $params[] = $require_any_location; }

    $params[] = $id;

    try {
        $stmt = db()->prepare('UPDATE equipment_types SET ' . implode(', ', $sets) . ' WHERE id = ?');
        $stmt->execute($params);
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name already exists', 409);
        throw $e;
    }

    if ($stmt->rowCount() === 0) json_error('Type not found', 404);
    json_ok(['success' => true]);
}

function handle_delete_type(): void {
    require_method('DELETE');
    require_admin();
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? $_GET['id'] ?? 0);
    if (!$id) json_error('id required');

    $count = db()->prepare('SELECT COUNT(*) FROM equipment_items WHERE equipment_type_id = ? AND status != "retired"');
    $count->execute([$id]);
    if ((int)$count->fetchColumn() > 0) {
        json_error('Cannot delete — active items exist for this type', 409);
    }

    db()->prepare('DELETE FROM equipment_types WHERE id = ?')->execute([$id]);
    json_ok(['success' => true]);
}

// ─── Equipment Items ───────────────────────────────────────────────────────

function handle_list_items(): void {
    require_method('GET');
    require_admin();

    $type_id = (int)($_GET['type_id'] ?? 0);
    $status  = $_GET['status'] ?? null;
    $where   = [];
    $params  = [];

    if ($type_id) { $where[] = 'i.equipment_type_id = ?'; $params[] = $type_id; }
    if (in_array($status, ['available', 'checked-out', 'retired'], true)) {
        $where[] = 'i.status = ?';
        $params[] = $status;
    }

    $whereSQL = $where ? 'WHERE ' . implode(' AND ', $where) : '';

    $stmt = db()->prepare(
        "SELECT i.id, i.qr_code, i.item_number, i.status, i.notes, i.route_position,
                i.latitude, i.longitude, i.created_at,
                i.home_location_id, i.require_home_location, i.require_any_location,
                i.spec_values, i.photo,
                t.id AS type_id, t.name AS type_name, t.category,
                CONCAT(t.name, ' #', i.item_number) AS display_name,
                b.name AS current_barrio,
                hl.name AS home_location_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN barrios b    ON b.id = i.current_barrio_id
         LEFT JOIN storage_locations hl ON hl.id = i.home_location_id
         $whereSQL
         ORDER BY t.name, i.item_number"
    );
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $r['id']             = (int)$r['id'];
        $r['item_number']    = (int)$r['item_number'];
        $r['type_id']        = (int)$r['type_id'];
        $r['home_location_id'] = $r['home_location_id'] ? (int)$r['home_location_id'] : null;
        $r['require_home_location'] = $r['require_home_location'] !== null ? (bool)$r['require_home_location'] : null;
        $r['require_any_location']  = $r['require_any_location']  !== null ? (bool)$r['require_any_location']  : null;
        $r['latitude']    = $r['latitude']    !== null ? (float)$r['latitude']    : null;
        $r['longitude']   = $r['longitude']   !== null ? (float)$r['longitude']   : null;
        $r['spec_values'] = $r['spec_values'] !== null ? json_decode($r['spec_values'], true) : (object)[];
    }
    unset($r);
    json_ok(['items' => $rows]);
}

function handle_create_items(): void {
    require_method('POST');
    require_admin();
    verify_csrf();

    $b         = body();
    $type_id   = (int)($b['equipment_type_id'] ?? 0);
    $count     = max(1, (int)($b['count'] ?? 1));
    $qr_prefix = strtoupper(trim($b['qr_prefix'] ?? ''));

    if (!$type_id) json_error('equipment_type_id required');
    if ($count > 100) json_error('Max 100 items at a time');

    // Verify type exists
    $type_stmt = db()->prepare('SELECT name, secure_qr FROM equipment_types WHERE id = ?');
    $type_stmt->execute([$type_id]);
    $type = $type_stmt->fetch();
    if (!$type) json_error('Equipment type not found', 404);

    $is_secure = (bool)$type['secure_qr'];
    $auto_prefix = strtoupper(preg_replace('/[^A-Z0-9]/i', '', $type['name']));

    if (!$is_secure) {
        // Sequential numbering
        $max_stmt = db()->prepare('SELECT COALESCE(MAX(item_number), 0) FROM equipment_items WHERE equipment_type_id = ?');
        $max_stmt->execute([$type_id]);
        $start = (int)$max_stmt->fetchColumn() + 1;
    }

    $created = [];
    $pdo     = db();
    $pdo->beginTransaction();
    try {
        for ($i = 0; $i < $count; $i++) {
            if ($is_secure) {
                // Random 5-digit number, retry on collision
                $attempts = 0;
                do {
                    $num = random_int(10000, 99999);
                    $chk = $pdo->prepare('SELECT id FROM equipment_items WHERE equipment_type_id = ? AND item_number = ?');
                    $chk->execute([$type_id, $num]);
                    $attempts++;
                    if ($attempts > 50) json_error('Could not generate unique item number after 50 attempts', 500);
                } while ($chk->fetch());
                $qr = $qr_prefix ? sprintf('%s-%05d', $qr_prefix, $num) : sprintf('%s-%05d', $auto_prefix, $num);
            } else {
                $num = $start + $i;
                $qr  = $qr_prefix ? sprintf('%s-%03d', $qr_prefix, $num) : sprintf('%s-%03d', $auto_prefix, $num);
            }

            $ins = $pdo->prepare(
                'INSERT INTO equipment_items (equipment_type_id, item_number, qr_code) VALUES (?, ?, ?)'
            );
            $ins->execute([$type_id, $num, $qr]);
            $created[] = [
                'id'          => (int)$pdo->lastInsertId(),
                'item_number' => $num,
                'qr_code'     => $qr,
                'display_name'=> $type['name'] . ' #' . $num,
            ];
        }
        $pdo->commit();
    } catch (PDOException $e) {
        $pdo->rollBack();
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('QR code collision — try a different prefix', 409);
        throw $e;
    }

    json_ok(['created' => $created], 201);
}

function handle_update_item(): void {
    require_method('PUT');
    require_permission('manage_equipment');
    verify_csrf();

    $b              = body();
    $id             = (int)($b['id'] ?? $_GET['id'] ?? 0);
    $status         = $b['status'] ?? null;
    $notes          = $b['notes']  ?? null;
    $route_position = array_key_exists('route_position', $b)
        ? ($b['route_position'] === null || $b['route_position'] === '' ? null : (int)$b['route_position'])
        : 'unset';

    // home_location_id: false = not provided, null = clear, int = set
    $home_location_id = array_key_exists('home_location_id', $b)
        ? ($b['home_location_id'] !== null && $b['home_location_id'] !== '' ? (int)$b['home_location_id'] : null)
        : false;

    // require flags: 'unset' = not provided, null = inherit from type, bool = override
    $require_home = array_key_exists('require_home_location', $b)
        ? ($b['require_home_location'] === null ? null : (!empty($b['require_home_location']) ? 1 : 0))
        : 'unset';
    $require_any  = array_key_exists('require_any_location', $b)
        ? ($b['require_any_location']  === null ? null : (!empty($b['require_any_location'])  ? 1 : 0))
        : 'unset';

    // GPS coordinates
    $latitude  = array_key_exists('latitude',  $b)
        ? ($b['latitude']  !== null && $b['latitude']  !== '' ? (float)$b['latitude']  : null)
        : 'unset';
    $longitude = array_key_exists('longitude', $b)
        ? ($b['longitude'] !== null && $b['longitude'] !== '' ? (float)$b['longitude'] : null)
        : 'unset';

    // Spec values — validate keys against allowed fields for this item's type
    $spec_values = 'unset';
    if (array_key_exists('spec_values', $b) && is_array($b['spec_values'])) {
        $type_stmt = db()->prepare(
            'SELECT field_key FROM equipment_type_spec_fields
             WHERE equipment_type_id = (SELECT equipment_type_id FROM equipment_items WHERE id = ?)'
        );
        $type_stmt->execute([$id]);
        $allowed_keys = array_column($type_stmt->fetchAll(), 'field_key');
        $sv = array_intersect_key($b['spec_values'], array_flip($allowed_keys));
        $spec_values = json_encode($sv);
    }

    // current_location_id for commissioning
    $current_location_id = array_key_exists('current_location_id', $b)
        ? ($b['current_location_id'] !== null && $b['current_location_id'] !== '' ? (int)$b['current_location_id'] : null)
        : 'unset';

    if (!$id) json_error('id required');
    if ($status !== null && !in_array($status, ['available', 'checked-out', 'retired'], true)) {
        json_error('invalid status');
    }

    $sets   = [];
    $params = [];
    if ($status !== null)            { $sets[] = 'status = ?';            $params[] = $status; }
    if ($notes  !== null)            { $sets[] = 'notes = ?';             $params[] = $notes; }
    if ($route_position !== 'unset') { $sets[] = 'route_position = ?';   $params[] = $route_position; }
    if ($home_location_id !== false) { $sets[] = 'home_location_id = ?'; $params[] = $home_location_id; }
    if ($require_home     !== 'unset') { $sets[] = 'require_home_location = ?'; $params[] = $require_home; }
    if ($require_any      !== 'unset') { $sets[] = 'require_any_location = ?';  $params[] = $require_any; }
    if ($latitude            !== 'unset') { $sets[] = 'latitude = ?';            $params[] = $latitude; }
    if ($longitude           !== 'unset') { $sets[] = 'longitude = ?';           $params[] = $longitude; }
    if ($spec_values         !== 'unset') { $sets[] = 'spec_values = ?';         $params[] = $spec_values; }
    if ($current_location_id !== 'unset') { $sets[] = 'current_location_id = ?'; $params[] = $current_location_id; }

    if (empty($sets)) json_error('Nothing to update');

    $params[] = $id;
    $stmt = db()->prepare('UPDATE equipment_items SET ' . implode(', ', $sets) . ' WHERE id = ?');
    $stmt->execute($params);

    if ($stmt->rowCount() === 0) json_error('Item not found', 404);
    json_ok(['success' => true]);
}

function handle_bulk_update_items(): void {
    require_method('POST');
    require_permission('manage_equipment');
    verify_csrf();

    $b        = body();
    $item_ids = $b['item_ids'] ?? [];
    $fields   = $b['fields']   ?? [];

    if (!is_array($item_ids) || empty($item_ids)) json_error('item_ids required');
    if (!is_array($fields)   || empty($fields))   json_error('fields required');

    // Sanitize ids
    $item_ids = array_filter(array_map('intval', $item_ids));
    if (empty($item_ids)) json_error('No valid item ids');
    if (count($item_ids) > 500) json_error('Too many items — max 500');

    $allowed = ['home_location_id', 'require_home_location', 'require_any_location',
                'status', 'notes', 'latitude', 'longitude'];
    $sets    = [];
    $params  = [];

    foreach ($allowed as $key) {
        if (!array_key_exists($key, $fields)) continue;
        $val = $fields[$key];
        switch ($key) {
            case 'home_location_id':
                $sets[] = 'home_location_id = ?';
                $params[] = ($val !== null && $val !== '') ? (int)$val : null;
                break;
            case 'require_home_location':
            case 'require_any_location':
                $sets[] = "$key = ?";
                $params[] = $val === null ? null : (!empty($val) ? 1 : 0);
                break;
            case 'status':
                if (!in_array($val, ['available', 'checked-out', 'retired'], true)) continue 2;
                $sets[] = 'status = ?'; $params[] = $val;
                break;
            case 'notes':
                $sets[] = 'notes = ?'; $params[] = $val;
                break;
            case 'latitude':
            case 'longitude':
                $sets[] = "$key = ?";
                $params[] = ($val !== null && $val !== '') ? (float)$val : null;
                break;
        }
    }

    if (empty($sets)) json_error('No valid fields to update');

    $placeholders = implode(',', array_fill(0, count($item_ids), '?'));
    $params       = array_merge($params, $item_ids);

    $stmt = db()->prepare(
        'UPDATE equipment_items SET ' . implode(', ', $sets) .
        " WHERE id IN ($placeholders)"
    );
    $stmt->execute($params);

    json_ok(['updated' => $stmt->rowCount()]);
}

// ─── POST /admin/items/import-status-csv ──────────────────────────────────
// Bulk backfill tool for reconciling item state after the app was down.
// Columns beyond qr_code are all optional — only the ones present in the
// file are applied, and a blank cell leaves that field unchanged. Setting
// "barrio" to a name checks the item out to that barrio; leaving it blank
// checks the item back in (if it currently has a barrio assigned).
function handle_import_status_csv(): void {
    require_method('POST');
    $user = require_permission('manage_equipment');
    verify_csrf();

    if (empty($_FILES['file'])) json_error('No file uploaded', 400);
    $tmp = $_FILES['file']['tmp_name'];
    if (!is_readable($tmp)) json_error('Could not read file', 400);

    $fh = fopen($tmp, 'r');
    $headers = fgetcsv($fh);
    if (!$headers) { fclose($fh); json_error('Empty CSV', 400); }
    $headers = array_map('trim', array_map('strtolower', $headers));
    if (isset($headers[0])) $headers[0] = preg_replace('/^\xEF\xBB\xBF/', '', $headers[0]);

    $qr_col = array_search('qr_code', $headers, true);
    if ($qr_col === false) $qr_col = array_search('qr', $headers, true);
    if ($qr_col === false) { fclose($fh); json_error('CSV must have a "qr_code" column', 400); }

    $status_col = array_search('status', $headers, true);
    $barrio_col = array_search('barrio', $headers, true);
    if ($barrio_col === false) $barrio_col = array_search('barrio_name', $headers, true);
    $notes_col  = array_search('notes', $headers, true);

    if ($status_col === false && $barrio_col === false && $notes_col === false) {
        fclose($fh);
        json_error('CSV must include at least one of: status, barrio, notes', 400);
    }

    $allowed_statuses = ['available', 'checked-out', 'retired'];

    $barrio_by_name = [];
    foreach (db()->query('SELECT id, name FROM barrios')->fetchAll() as $b) {
        $barrio_by_name[strtolower($b['name'])] = (int)$b['id'];
    }

    $now = date('Y-m-d H:i:s');
    $pdo = db();
    $pdo->beginTransaction();

    $updated = 0; $checked_out = 0; $checked_in = 0; $errors = []; $row_num = 1;

    try {
        while (($row = fgetcsv($fh)) !== false) {
            $row_num++;
            $qr = trim($row[$qr_col] ?? '');
            if ($qr === '') continue;

            $stmt = $pdo->prepare(
                'SELECT id, current_dept_id, current_barrio_id
                 FROM equipment_items WHERE qr_code = ? FOR UPDATE'
            );
            $stmt->execute([$qr]);
            $item = $stmt->fetch();

            if (!$item) {
                $errors[] = ['row' => $row_num, 'qr_code' => $qr, 'error' => 'Item not found'];
                continue;
            }

            $row_changed = false;

            if ($barrio_col !== false) {
                $barrio_val = trim($row[$barrio_col] ?? '');
                if ($barrio_val !== '') {
                    $key = strtolower($barrio_val);
                    if (!isset($barrio_by_name[$key])) {
                        $errors[] = ['row' => $row_num, 'qr_code' => $qr, 'error' => "Barrio \"$barrio_val\" not found"];
                    } elseif (!$item['current_dept_id']) {
                        $errors[] = ['row' => $row_num, 'qr_code' => $qr, 'error' => 'Item has no department assigned — cannot check out to a barrio'];
                    } else {
                        $barrio_id = $barrio_by_name[$key];
                        $pdo->prepare(
                            'UPDATE equipment_items
                             SET status = "checked-out", current_barrio_id = ?, current_artist_id = NULL, current_person_id = NULL
                             WHERE id = ?'
                        )->execute([$barrio_id, $item['id']]);
                        $pdo->prepare(
                            'INSERT INTO transactions (type, item_id, dept_id, barrio_id, performed_by, user_name_cache, is_offline_entry, occurred_at, notes)
                             VALUES ("sub_checkout", ?, ?, ?, ?, ?, 1, ?, ?)'
                        )->execute([$item['id'], $item['current_dept_id'], $barrio_id, $user['id'], $user['display_name'], $now, 'CSV import backfill']);
                        $checked_out++;
                        $row_changed = true;
                    }
                } elseif ($item['current_barrio_id']) {
                    $prev_barrio_id = (int)$item['current_barrio_id'];
                    $pdo->prepare(
                        'UPDATE equipment_items
                         SET current_barrio_id = NULL, current_artist_id = NULL, current_person_id = NULL
                         WHERE id = ?'
                    )->execute([$item['id']]);
                    $pdo->prepare(
                        'INSERT INTO transactions (type, item_id, dept_id, barrio_id, performed_by, user_name_cache, is_offline_entry, occurred_at, notes)
                         VALUES ("sub_checkin", ?, ?, ?, ?, ?, 1, ?, ?)'
                    )->execute([$item['id'], $item['current_dept_id'], $prev_barrio_id, $user['id'], $user['display_name'], $now, 'CSV import backfill']);
                    $checked_in++;
                    $row_changed = true;
                }
            }

            if ($status_col !== false) {
                $status_val = trim($row[$status_col] ?? '');
                if ($status_val !== '') {
                    if (!in_array($status_val, $allowed_statuses, true)) {
                        $errors[] = ['row' => $row_num, 'qr_code' => $qr, 'error' => "Invalid status \"$status_val\""];
                    } else {
                        $pdo->prepare('UPDATE equipment_items SET status = ? WHERE id = ?')
                            ->execute([$status_val, $item['id']]);
                        $row_changed = true;
                    }
                }
            }

            if ($notes_col !== false) {
                $notes_val = trim($row[$notes_col] ?? '');
                if ($notes_val !== '') {
                    $pdo->prepare('UPDATE equipment_items SET notes = ? WHERE id = ?')
                        ->execute([$notes_val, $item['id']]);
                    $row_changed = true;
                }
            }

            if ($row_changed) $updated++;
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        fclose($fh);
        json_error('Database error: ' . $e->getMessage(), 500);
    }
    fclose($fh);

    json_ok([
        'processed'   => $row_num - 1,
        'updated'     => $updated,
        'checked_out' => $checked_out,
        'checked_in'  => $checked_in,
        'errors'      => $errors,
    ]);
}

function handle_delete_item(): void {
    require_method('DELETE');
    require_admin();
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? $_GET['id'] ?? 0);
    if (!$id) json_error('id required');

    // Soft delete — set to retired
    $stmt = db()->prepare('UPDATE equipment_items SET status = "retired", current_barrio_id = NULL WHERE id = ?');
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) json_error('Item not found', 404);

    json_ok(['success' => true]);
}

// ─── Spec fields ───────────────────────────────────────────────────────────────

function handle_list_spec_fields(): void {
    require_method('GET');
    require_admin();

    $type_id = (int)($_GET['id'] ?? 0);
    if (!$type_id) json_error('type id required');

    $stmt = db()->prepare(
        'SELECT id, field_key, label, field_type, unit, options, sort_order
         FROM equipment_type_spec_fields WHERE equipment_type_id = ? ORDER BY sort_order'
    );
    $stmt->execute([$type_id]);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $r['id']         = (int)$r['id'];
        $r['sort_order'] = (int)$r['sort_order'];
        $r['options']    = $r['options'] ? json_decode($r['options'], true) : null;
    }
    unset($r);
    json_ok(['spec_fields' => $rows]);
}

function handle_create_spec_field(): void {
    require_method('POST');
    require_admin();
    verify_csrf();

    $type_id    = (int)($_GET['id'] ?? 0);
    $b          = body();
    $field_key  = trim($b['field_key'] ?? '');
    $label      = trim($b['label'] ?? '');
    $field_type = $b['field_type'] ?? 'text';
    $unit       = trim($b['unit'] ?? '') ?: null;
    $options    = null;

    if (!$type_id)    json_error('type id required');
    if (!$field_key)  json_error('field_key required');
    if (!$label)      json_error('label required');
    if (!preg_match('/^[a-z0-9_]+$/', $field_key)) json_error('field_key must be lowercase letters, numbers, and underscores only');
    if (!in_array($field_type, ['number', 'text', 'boolean', 'select'], true)) json_error('invalid field_type');

    if ($field_type === 'select') {
        $opts = $b['options'] ?? [];
        if (!is_array($opts) || empty($opts)) json_error('options required for select type');
        $options = json_encode(array_values(array_filter(array_map('strval', $opts))));
    }

    // Get current max sort_order
    $max_stmt = db()->prepare(
        'SELECT COALESCE(MAX(sort_order), -1) FROM equipment_type_spec_fields WHERE equipment_type_id = ?'
    );
    $max_stmt->execute([$type_id]);
    $sort_order = (int)$max_stmt->fetchColumn() + 1;

    try {
        $stmt = db()->prepare(
            'INSERT INTO equipment_type_spec_fields (equipment_type_id, field_key, label, field_type, unit, options, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$type_id, $field_key, $label, $field_type, $unit, $options, $sort_order]);
        $id = (int)db()->lastInsertId();
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('field_key already exists for this type', 409);
        throw $e;
    }

    json_ok(['id' => $id, 'field_key' => $field_key, 'label' => $label,
             'field_type' => $field_type, 'unit' => $unit, 'sort_order' => $sort_order,
             'options' => $options ? json_decode($options, true) : null], 201);
}

function handle_update_spec_field(): void {
    require_method('PUT');
    require_admin();
    verify_csrf();

    $sf_id = (int)($_GET['id'] ?? 0);
    $b     = body();
    if (!$sf_id) json_error('spec field id required');

    $sets   = [];
    $params = [];

    if (array_key_exists('label', $b)) {
        $label = trim($b['label']);
        if (!$label) json_error('label cannot be empty');
        $sets[] = 'label = ?'; $params[] = $label;
    }
    if (array_key_exists('unit', $b)) {
        $sets[] = 'unit = ?'; $params[] = trim($b['unit']) ?: null;
    }
    if (array_key_exists('sort_order', $b)) {
        $sets[] = 'sort_order = ?'; $params[] = (int)$b['sort_order'];
    }
    if (array_key_exists('options', $b)) {
        $opts = $b['options'];
        if (!is_array($opts)) json_error('options must be an array');
        $sets[] = 'options = ?'; $params[] = json_encode(array_values(array_filter(array_map('strval', $opts))));
    }

    if (empty($sets)) json_error('Nothing to update');

    $params[] = $sf_id;
    $stmt = db()->prepare('UPDATE equipment_type_spec_fields SET ' . implode(', ', $sets) . ' WHERE id = ?');
    $stmt->execute($params);
    if ($stmt->rowCount() === 0) json_error('Spec field not found', 404);
    json_ok(['success' => true]);
}

function handle_delete_spec_field(): void {
    require_method('DELETE');
    require_admin();
    verify_csrf();

    $sf_id = (int)($_GET['id'] ?? 0);
    if (!$sf_id) json_error('spec field id required');

    // Get field info before deleting
    $sf_stmt = db()->prepare('SELECT equipment_type_id, field_key FROM equipment_type_spec_fields WHERE id = ?');
    $sf_stmt->execute([$sf_id]);
    $sf = $sf_stmt->fetch();
    if (!$sf) json_error('Spec field not found', 404);

    db()->prepare('DELETE FROM equipment_type_spec_fields WHERE id = ?')->execute([$sf_id]);

    // Remove orphaned key from all items of this type
    $clean = db()->prepare(
        'UPDATE equipment_items SET spec_values = JSON_REMOVE(spec_values, ?)
         WHERE equipment_type_id = ? AND spec_values IS NOT NULL'
    );
    $clean->execute(['$.' . $sf['field_key'], (int)$sf['equipment_type_id']]);

    json_ok(['success' => true]);
}

function handle_reorder_spec_fields(): void {
    require_method('PUT');
    require_admin();
    verify_csrf();

    $type_id = (int)($_GET['id'] ?? 0);
    $b       = body();
    $order   = $b['order'] ?? [];

    if (!$type_id) json_error('type id required');
    if (!is_array($order)) json_error('order must be an array');

    $stmt = db()->prepare('UPDATE equipment_type_spec_fields SET sort_order = ? WHERE id = ? AND equipment_type_id = ?');
    foreach ($order as $i => $sf_id) {
        $stmt->execute([(int)$i, (int)$sf_id, $type_id]);
    }
    json_ok(['success' => true]);
}

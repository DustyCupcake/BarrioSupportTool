<?php
declare(strict_types=1);

// ─── GET /consumable-types ────────────────────────────────────────────────────
function handle_list_consumable_types(): void {
    require_method('GET');
    require_auth();

    $rows = db()->query(
        'SELECT id, name, key_name, sort_order FROM consumable_types ORDER BY sort_order, name'
    )->fetchAll();

    foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['sort_order'] = (int)$r['sort_order']; }
    unset($r);

    json_ok(['types' => $rows]);
}

// ─── Admin CRUD /admin/consumable-types ───────────────────────────────────────
function handle_admin_consumable_types(): void {
    $user = require_auth('admin');
    $m    = $_SERVER['REQUEST_METHOD'];

    if ($m === 'GET') {
        $rows = db()->query(
            'SELECT ct.id, ct.name, ct.key_name, ct.sort_order,
                    (SELECT COUNT(*) FROM barrio_entitlements e WHERE e.type_id = ct.id) AS entitlement_count
             FROM consumable_types ct ORDER BY ct.sort_order, ct.name'
        )->fetchAll();
        foreach ($rows as &$r) {
            $r['id']               = (int)$r['id'];
            $r['sort_order']       = (int)$r['sort_order'];
            $r['entitlement_count'] = (int)$r['entitlement_count'];
        }
        unset($r);
        json_ok(['types' => $rows]);
        return;
    }

    verify_csrf();
    $b = body();

    if ($m === 'POST') {
        $name  = trim($b['name'] ?? '');
        $key   = trim($b['key_name'] ?? '');
        $sort  = max(0, (int)($b['sort_order'] ?? 0));
        if (!$name || !$key) json_error('name and key_name required', 400);
        if (!preg_match('/^[a-z0-9_]+$/', $key)) json_error('key_name must be lowercase letters, numbers and underscores', 400);
        try {
            $s = db()->prepare('INSERT INTO consumable_types (name, key_name, sort_order) VALUES (?,?,?)');
            $s->execute([$name, $key, $sort]);
            json_ok(['id' => (int)db()->lastInsertId()]);
        } catch (\PDOException $e) {
            if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name or key already exists', 409);
            throw $e;
        }
        return;
    }

    if ($m === 'PUT') {
        $id   = (int)($b['id'] ?? 0);
        $name = trim($b['name'] ?? '');
        $sort = max(0, (int)($b['sort_order'] ?? 0));
        if (!$id || !$name) json_error('id and name required', 400);
        try {
            $s = db()->prepare('UPDATE consumable_types SET name=?, sort_order=? WHERE id=?');
            $s->execute([$name, $sort, $id]);
        } catch (\PDOException $e) {
            if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name already exists', 409);
            throw $e;
        }
        json_ok(['success' => true]);
        return;
    }

    if ($m === 'DELETE') {
        $id = (int)($b['id'] ?? 0);
        if (!$id) json_error('id required', 400);
        $count = db()->prepare('SELECT COUNT(*) FROM barrio_entitlements WHERE type_id=?');
        $count->execute([$id]);
        if ((int)$count->fetchColumn() > 0) json_error('Type has entitlement records — remove those first', 409);
        db()->prepare('DELETE FROM consumable_types WHERE id=?')->execute([$id]);
        json_ok(['success' => true]);
        return;
    }

    json_error('Method not allowed', 405);
}

// ─── PUT /admin/barrio-entitlements ───────────────────────────────────────────
function handle_admin_barrio_entitlements(): void {
    require_method('PUT');
    require_auth('admin');
    verify_csrf();

    $b         = body();
    $barrio_id = (int)($b['barrio_id'] ?? 0);
    $type_id   = (int)($b['type_id'] ?? 0);
    $purchased = max(0, (int)($b['purchased'] ?? 0));

    if (!$barrio_id || !$type_id) json_error('barrio_id and type_id required', 400);

    $s = db()->prepare(
        'INSERT INTO barrio_entitlements (barrio_id, type_id, purchased, distributed)
         VALUES (?,?,?,0)
         ON DUPLICATE KEY UPDATE purchased=VALUES(purchased)'
    );
    $s->execute([$barrio_id, $type_id, $purchased]);

    json_ok(['success' => true]);
}

// ─── PUT /admin/barrio-equipment-orders ──────────────────────────────────────
function handle_admin_equipment_orders(): void {
    require_method('PUT');
    require_auth('admin');
    verify_csrf();

    $b                 = body();
    $barrio_id         = (int)($b['barrio_id'] ?? 0);
    $equipment_type_id = (int)($b['equipment_type_id'] ?? 0);
    $quantity_ordered  = max(0, (int)($b['quantity_ordered'] ?? 0));

    if (!$barrio_id || !$equipment_type_id) json_error('barrio_id and equipment_type_id required', 400);

    $s = db()->prepare(
        'INSERT INTO barrio_equipment_orders (barrio_id, equipment_type_id, quantity_ordered)
         VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE quantity_ordered=VALUES(quantity_ordered)'
    );
    $s->execute([$barrio_id, $equipment_type_id, $quantity_ordered]);

    json_ok(['success' => true]);
}

// ─── POST /barrio-distribute ──────────────────────────────────────────────────
function handle_barrio_distribute(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b         = body();
    $barrio_id = (int)($b['barrio_id'] ?? 0);
    $items     = $b['items'] ?? [];

    if (!$barrio_id) json_error('barrio_id required', 400);
    if (!is_array($items) || !count($items)) json_error('items array required', 400);

    $check = db()->prepare('SELECT arrival_status FROM barrios WHERE id=?');
    $check->execute([$barrio_id]);
    $barrio = $check->fetch();
    if (!$barrio) json_error('Barrio not found', 404);
    if ($barrio['arrival_status'] !== 'on-site') json_error('Barrio is not on site', 409);

    $db = db();
    $db->beginTransaction();
    try {
        foreach ($items as $item) {
            $type_id  = (int)($item['type_id'] ?? 0);
            $quantity = (int)($item['quantity'] ?? 0);
            if (!$type_id || $quantity === 0) continue;

            $db->prepare(
                'INSERT INTO distribution_events
                    (barrio_id, type_id, quantity, performed_by, user_name_cache, occurred_at)
                 VALUES (?,?,?,?,?,NOW())'
            )->execute([$barrio_id, $type_id, $quantity, $user['id'], $user['display_name']]);

            // Upsert entitlement row and increment distributed
            $db->prepare(
                'INSERT INTO barrio_entitlements (barrio_id, type_id, purchased, distributed)
                 VALUES (?,?,0,?)
                 ON DUPLICATE KEY UPDATE distributed = distributed + VALUES(distributed)'
            )->execute([$barrio_id, $type_id, $quantity]);
        }
        $db->commit();
    } catch (\Throwable $e) {
        $db->rollBack();
        throw $e;
    }

    // Return updated entitlements
    json_ok(['success' => true, 'entitlements' => _get_entitlements($barrio_id)]);
}

// ─── POST /admin/barrios/import-csv ──────────────────────────────────────────
function handle_import_csv(): void {
    require_method('POST');
    require_auth('admin');
    verify_csrf();

    if (empty($_FILES['file'])) json_error('No file uploaded', 400);
    $tmp = $_FILES['file']['tmp_name'];
    if (!is_readable($tmp)) json_error('Could not read file', 400);

    // Load reference tables
    $consumable_types = db()->query(
        'SELECT id, key_name FROM consumable_types'
    )->fetchAll(\PDO::FETCH_KEY_PAIR); // key_name => id

    $equipment_types_raw = db()->query(
        'SELECT id, name FROM equipment_types'
    )->fetchAll();
    $equipment_types = []; // normalised_key => id
    foreach ($equipment_types_raw as $et) {
        $k = strtolower(preg_replace('/\s+/', '_', $et['name']));
        $equipment_types[$k] = (int)$et['id'];
    }

    $fh = fopen($tmp, 'r');
    $headers = fgetcsv($fh);
    if (!$headers) { fclose($fh); json_error('Empty CSV', 400); }
    $headers = array_map('trim', $headers);

    $name_col = array_search('name', $headers, true);
    if ($name_col === false) { fclose($fh); json_error('CSV must have a "name" column', 400); }
    $sort_col = array_search('sort_order', $headers, true);

    $created = 0; $updated = 0; $skipped = 0;

    while (($row = fgetcsv($fh)) !== false) {
        if (!isset($row[$name_col])) continue;
        $name = trim($row[$name_col]);
        if ($name === '') continue;

        $sort = $sort_col !== false ? max(0, (int)($row[$sort_col] ?? 0)) : 0;

        // Upsert barrio
        $existing = db()->prepare('SELECT id FROM barrios WHERE name=?');
        $existing->execute([$name]);
        $barrio_row = $existing->fetch();
        if ($barrio_row) {
            $barrio_id = (int)$barrio_row['id'];
            $updated++;
        } else {
            try {
                $ins = db()->prepare('INSERT INTO barrios (name, sort_order) VALUES (?,?)');
                $ins->execute([$name, $sort]);
                $barrio_id = (int)db()->lastInsertId();
                $created++;
            } catch (\PDOException $e) {
                $skipped++;
                continue;
            }
        }

        // Upsert consumable entitlements
        foreach ($headers as $col_idx => $col) {
            if (!isset($consumable_types[$col])) continue;
            $qty = max(0, (int)($row[$col_idx] ?? 0));
            $type_id = (int)$consumable_types[$col];
            db()->prepare(
                'INSERT INTO barrio_entitlements (barrio_id, type_id, purchased, distributed)
                 VALUES (?,?,?,0)
                 ON DUPLICATE KEY UPDATE purchased=VALUES(purchased)'
            )->execute([$barrio_id, $type_id, $qty]);
        }

        // Upsert equipment orders
        foreach ($headers as $col_idx => $col) {
            $col_key = strtolower(preg_replace('/\s+/', '_', $col));
            if (!isset($equipment_types[$col_key])) continue;
            $qty = max(0, (int)($row[$col_idx] ?? 0));
            $eq_type_id = $equipment_types[$col_key];
            db()->prepare(
                'INSERT INTO barrio_equipment_orders (barrio_id, equipment_type_id, quantity_ordered)
                 VALUES (?,?,?)
                 ON DUPLICATE KEY UPDATE quantity_ordered=VALUES(quantity_ordered)'
            )->execute([$barrio_id, $eq_type_id, $qty]);
        }
    }
    fclose($fh);

    json_ok(['created' => $created, 'updated' => $updated, 'skipped' => $skipped]);
}

// ─── Internal helper ──────────────────────────────────────────────────────────
function _get_entitlements(int $barrio_id): array {
    $stmt = db()->prepare(
        'SELECT be.type_id, ct.key_name, ct.name, ct.sort_order,
                be.purchased, be.distributed,
                (be.purchased - be.distributed) AS remaining
         FROM barrio_entitlements be
         JOIN consumable_types ct ON ct.id = be.type_id
         WHERE be.barrio_id = ?
         ORDER BY ct.sort_order, ct.name'
    );
    $stmt->execute([$barrio_id]);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $r['type_id']     = (int)$r['type_id'];
        $r['sort_order']  = (int)$r['sort_order'];
        $r['purchased']   = (int)$r['purchased'];
        $r['distributed'] = (int)$r['distributed'];
        $r['remaining']   = (int)$r['remaining'];
    }
    unset($r);
    return $rows;
}

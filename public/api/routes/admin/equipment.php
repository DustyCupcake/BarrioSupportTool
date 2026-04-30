<?php
declare(strict_types=1);

// ─── Equipment Types ───────────────────────────────────────────────────────

function handle_list_types(): void {
    require_method('GET');
    require_admin();

    $rows = db()->query(
        'SELECT t.id, t.name, t.category, t.secure_qr, t.created_at,
                COUNT(i.id) AS item_count
         FROM equipment_types t
         LEFT JOIN equipment_items i ON i.equipment_type_id = t.id AND i.status != "retired"
         GROUP BY t.id
         ORDER BY t.name'
    )->fetchAll();
    foreach ($rows as &$r) {
        $r['id']         = (int)$r['id'];
        $r['item_count'] = (int)$r['item_count'];
        $r['secure_qr']  = (bool)$r['secure_qr'];
    }
    unset($r);
    json_ok(['types' => $rows]);
}

function handle_create_type(): void {
    require_method('POST');
    require_admin();
    verify_csrf();

    $b         = body();
    $name      = trim($b['name'] ?? '');
    $category  = trim($b['category'] ?? '');
    $secure_qr = !empty($b['secure_qr']) ? 1 : 0;

    if ($name === '') json_error('name required');

    try {
        $stmt = db()->prepare('INSERT INTO equipment_types (name, category, secure_qr) VALUES (?, ?, ?)');
        $stmt->execute([$name, $category ?: null, $secure_qr]);
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

    $b         = body();
    $id        = (int)($b['id'] ?? $_GET['id'] ?? 0);
    $name      = trim($b['name'] ?? '');
    $category  = trim($b['category'] ?? '');
    $secure_qr = isset($b['secure_qr']) ? (!empty($b['secure_qr']) ? 1 : 0) : null;

    if (!$id || $name === '') json_error('id and name required');

    try {
        if ($secure_qr !== null) {
            $stmt = db()->prepare('UPDATE equipment_types SET name = ?, category = ?, secure_qr = ? WHERE id = ?');
            $stmt->execute([$name, $category ?: null, $secure_qr, $id]);
        } else {
            $stmt = db()->prepare('UPDATE equipment_types SET name = ?, category = ? WHERE id = ?');
            $stmt->execute([$name, $category ?: null, $id]);
        }
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
        "SELECT i.id, i.qr_code, i.item_number, i.status, i.notes, i.created_at,
                t.id AS type_id, t.name AS type_name, t.category,
                CONCAT(t.name, ' #', i.item_number) AS display_name,
                b.name AS current_barrio
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN barrios b    ON b.id = i.current_barrio_id
         $whereSQL
         ORDER BY t.name, i.item_number"
    );
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $r['id']          = (int)$r['id'];
        $r['item_number'] = (int)$r['item_number'];
        $r['type_id']     = (int)$r['type_id'];
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
    require_admin();
    verify_csrf();

    $b      = body();
    $id     = (int)($b['id'] ?? $_GET['id'] ?? 0);
    $status = $b['status'] ?? null;
    $notes  = $b['notes'] ?? null;

    if (!$id) json_error('id required');
    if ($status !== null && !in_array($status, ['available', 'checked-out', 'retired'], true)) {
        json_error('invalid status');
    }

    $sets   = [];
    $params = [];
    if ($status !== null) { $sets[] = 'status = ?'; $params[] = $status; }
    if ($notes  !== null) { $sets[] = 'notes = ?';  $params[] = $notes; }

    if (empty($sets)) json_error('Nothing to update');

    $params[] = $id;
    $stmt = db()->prepare('UPDATE equipment_items SET ' . implode(', ', $sets) . ' WHERE id = ?');
    $stmt->execute($params);

    if ($stmt->rowCount() === 0) json_error('Item not found', 404);
    json_ok(['success' => true]);
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

<?php
declare(strict_types=1);

function handle_list(): void {
    require_method('GET');
    require_admin();

    $rows = db()->query('SELECT id, name, sort_order, created_at FROM barrios ORDER BY sort_order, name')->fetchAll();
    foreach ($rows as &$r) $r['id'] = (int)$r['id'];
    unset($r);
    json_ok(['barrios' => $rows]);
}

function handle_create(): void {
    require_method('POST');
    require_admin();
    verify_csrf();

    $b    = body();
    $name = trim($b['name'] ?? '');
    $sort = (int)($b['sort_order'] ?? 0);

    if ($name === '') json_error('name required');

    try {
        $stmt = db()->prepare('INSERT INTO barrios (name, sort_order) VALUES (?, ?)');
        $stmt->execute([$name, $sort]);
        $id = (int)db()->lastInsertId();
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name already exists', 409);
        throw $e;
    }

    json_ok(['id' => $id, 'name' => $name, 'sort_order' => $sort], 201);
}

function handle_update(): void {
    require_method('PUT');
    require_admin();
    verify_csrf();

    $b    = body();
    $id   = (int)($b['id'] ?? $_GET['id'] ?? 0);
    $name = trim($b['name'] ?? '');
    $sort = (int)($b['sort_order'] ?? 0);

    if (!$id || $name === '') json_error('id and name required');

    try {
        $stmt = db()->prepare('UPDATE barrios SET name = ?, sort_order = ? WHERE id = ?');
        $stmt->execute([$name, $sort, $id]);
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name already exists', 409);
        throw $e;
    }

    if ($stmt->rowCount() === 0) json_error('Barrio not found', 404);
    json_ok(['success' => true]);
}

function handle_delete(): void {
    require_method('DELETE');
    require_admin();
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? $_GET['id'] ?? 0);
    if (!$id) json_error('id required');

    // Check for active checkouts
    $count = db()->prepare('SELECT COUNT(*) FROM equipment_items WHERE current_barrio_id = ?');
    $count->execute([$id]);
    if ((int)$count->fetchColumn() > 0) {
        json_error('Cannot delete — items are currently checked out to this barrio', 409);
    }

    db()->prepare('DELETE FROM barrios WHERE id = ?')->execute([$id]);
    json_ok(['success' => true]);
}

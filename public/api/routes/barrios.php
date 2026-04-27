<?php
declare(strict_types=1);

function handle_list_barrios(): void {
    require_method('GET');
    require_auth();

    $rows = db()->query(
        'SELECT b.*,
            (SELECT COUNT(*) FROM equipment_items e
             WHERE e.current_barrio_id = b.id AND e.status = \'checked-out\') AS items_out_count
         FROM barrios b
         ORDER BY b.sort_order, b.name'
    )->fetchAll();

    foreach ($rows as &$r) {
        $r['id']             = (int)$r['id'];
        $r['items_out_count'] = (int)$r['items_out_count'];
        $r['water_vouchers'] = (int)$r['water_vouchers'];
        $r['ice_tokens']     = (int)$r['ice_tokens'];
        $r['orientation_done'] = (bool)$r['orientation_done'];
    }
    unset($r);

    json_ok(['barrios' => $rows]);
}

function handle_get_barrio(): void {
    require_method('GET');
    require_auth();

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('id required', 400);

    $stmt = db()->prepare(
        'SELECT b.*,
            (SELECT COUNT(*) FROM equipment_items e
             WHERE e.current_barrio_id = b.id AND e.status = \'checked-out\') AS items_out_count
         FROM barrios b WHERE b.id = ?'
    );
    $stmt->execute([$id]);
    $barrio = $stmt->fetch();
    if (!$barrio) json_error('Barrio not found', 404);

    $barrio['id']             = (int)$barrio['id'];
    $barrio['items_out_count'] = (int)$barrio['items_out_count'];
    $barrio['water_vouchers'] = (int)$barrio['water_vouchers'];
    $barrio['ice_tokens']     = (int)$barrio['ice_tokens'];
    $barrio['orientation_done'] = (bool)$barrio['orientation_done'];

    $items = db()->prepare(
        'SELECT e.id, e.qr_code,
            CONCAT(t.name, \' #\', e.item_number) AS name,
            t.category
         FROM equipment_items e
         JOIN equipment_types t ON t.id = e.equipment_type_id
         WHERE e.current_barrio_id = ? AND e.status = \'checked-out\'
         ORDER BY t.name, e.item_number'
    );
    $items->execute([$id]);

    json_ok(['barrio' => $barrio, 'items_out' => $items->fetchAll()]);
}

function handle_barrio_arrival(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b        = body();
    $barrio_id = (int)($b['barrio_id'] ?? 0);
    if (!$barrio_id) json_error('barrio_id required');

    $water       = max(0, (int)($b['water_vouchers'] ?? 0));
    $ice         = max(0, (int)($b['ice_tokens'] ?? 0));
    $orientation = !empty($b['orientation_done']) ? 1 : 0;

    $stmt = db()->prepare(
        'UPDATE barrios
         SET arrival_status = \'on-site\',
             arrived_at      = NOW(),
             arrived_by      = ?,
             arrived_by_name = ?,
             water_vouchers  = ?,
             ice_tokens      = ?,
             orientation_done = ?
         WHERE id = ? AND arrival_status = \'expected\''
    );
    $stmt->execute([
        $user['id'],
        $user['display_name'],
        $water,
        $ice,
        $orientation,
        $barrio_id,
    ]);

    if ($stmt->rowCount() === 0) {
        $check = db()->prepare('SELECT arrival_status FROM barrios WHERE id = ?');
        $check->execute([$barrio_id]);
        $row = $check->fetch();
        if (!$row) json_error('Barrio not found', 404);
        json_error('Barrio already ' . $row['arrival_status'], 409);
    }

    $row = db()->prepare('SELECT * FROM barrios WHERE id = ?');
    $row->execute([$barrio_id]);
    $barrio = $row->fetch();
    $barrio['water_vouchers']  = (int)$barrio['water_vouchers'];
    $barrio['ice_tokens']      = (int)$barrio['ice_tokens'];
    $barrio['orientation_done'] = (bool)$barrio['orientation_done'];

    json_ok(['success' => true, 'barrio' => $barrio]);
}

function handle_barrio_departure(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b         = body();
    $barrio_id = (int)($b['barrio_id'] ?? 0);
    $force     = !empty($b['force']);
    if (!$barrio_id) json_error('barrio_id required');

    $check = db()->prepare('SELECT arrival_status FROM barrios WHERE id = ?');
    $check->execute([$barrio_id]);
    $row = $check->fetch();
    if (!$row) json_error('Barrio not found', 404);
    if ($row['arrival_status'] !== 'on-site') {
        json_error('Barrio is not on site (status: ' . $row['arrival_status'] . ')', 409);
    }

    if (!$force) {
        $count = db()->prepare(
            'SELECT COUNT(*) FROM equipment_items WHERE current_barrio_id = ? AND status = \'checked-out\''
        );
        $count->execute([$barrio_id]);
        $n = (int)$count->fetchColumn();
        if ($n > 0) {
            http_response_code(409);
            echo json_encode(['error' => 'items_outstanding', 'count' => $n]);
            exit;
        }
    }

    $stmt = db()->prepare(
        'UPDATE barrios
         SET arrival_status = \'departed\',
             departed_at    = NOW(),
             departed_by    = ?,
             departed_by_name = ?
         WHERE id = ? AND arrival_status = \'on-site\''
    );
    $stmt->execute([$user['id'], $user['display_name'], $barrio_id]);

    if ($stmt->rowCount() === 0) json_error('Departure could not be recorded', 409);

    json_ok(['success' => true]);
}

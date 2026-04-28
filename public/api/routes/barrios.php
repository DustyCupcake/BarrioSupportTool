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
        $r['id']               = (int)$r['id'];
        $r['items_out_count']  = (int)$r['items_out_count'];
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

    $barrio['id']              = (int)$barrio['id'];
    $barrio['items_out_count'] = (int)$barrio['items_out_count'];
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

    // Consumable entitlements
    $ent_stmt = db()->prepare(
        'SELECT be.type_id, ct.key_name, ct.name, ct.sort_order,
                be.purchased, be.distributed,
                (CAST(be.purchased AS SIGNED) - CAST(be.distributed AS SIGNED)) AS remaining
         FROM barrio_entitlements be
         JOIN consumable_types ct ON ct.id = be.type_id
         WHERE be.barrio_id = ?
         ORDER BY ct.sort_order, ct.name'
    );
    $ent_stmt->execute([$id]);
    $entitlements = $ent_stmt->fetchAll();
    foreach ($entitlements as &$e) {
        $e['type_id']     = (int)$e['type_id'];
        $e['sort_order']  = (int)$e['sort_order'];
        $e['purchased']   = (int)$e['purchased'];
        $e['distributed'] = (int)$e['distributed'];
        $e['remaining']   = (int)$e['remaining'];
    }
    unset($e);

    // Equipment orders with live checked-out counts
    $ord_stmt = db()->prepare(
        'SELECT beo.equipment_type_id, et.name AS type_name,
                beo.quantity_ordered,
                (SELECT COUNT(*) FROM equipment_items ei
                 WHERE ei.current_barrio_id = ? AND ei.equipment_type_id = beo.equipment_type_id
                   AND ei.status = \'checked-out\') AS quantity_checked_out
         FROM barrio_equipment_orders beo
         JOIN equipment_types et ON et.id = beo.equipment_type_id
         WHERE beo.barrio_id = ?
         ORDER BY et.name'
    );
    $ord_stmt->execute([$id, $id]);
    $equipment_orders = $ord_stmt->fetchAll();
    foreach ($equipment_orders as &$o) {
        $o['equipment_type_id']    = (int)$o['equipment_type_id'];
        $o['quantity_ordered']     = (int)$o['quantity_ordered'];
        $o['quantity_checked_out'] = (int)$o['quantity_checked_out'];
    }
    unset($o);

    json_ok([
        'barrio'           => $barrio,
        'items_out'        => $items->fetchAll(),
        'entitlements'     => $entitlements,
        'equipment_orders' => $equipment_orders,
    ]);
}

function handle_barrio_arrival(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b         = body();
    $barrio_id = (int)($b['barrio_id'] ?? 0);
    if (!$barrio_id) json_error('barrio_id required');

    $orientation = !empty($b['orientation_done']) ? 1 : 0;

    // Accept new-style items array OR legacy water_vouchers/ice_tokens keys
    $dist_items = [];
    if (!empty($b['items']) && is_array($b['items'])) {
        $dist_items = $b['items'];
    } else {
        // Backward compat: map legacy keys to type_ids
        $legacy_keys = [];
        if (isset($b['water_vouchers']) && (int)$b['water_vouchers'] > 0) {
            $legacy_keys['water_vouchers'] = (int)$b['water_vouchers'];
        }
        if (isset($b['ice_tokens']) && (int)$b['ice_tokens'] > 0) {
            $legacy_keys['ice_tokens'] = (int)$b['ice_tokens'];
        }
        if ($legacy_keys) {
            $placeholders = implode(',', array_fill(0, count($legacy_keys), '?'));
            $type_rows = db()->prepare(
                "SELECT id, key_name FROM consumable_types WHERE key_name IN ($placeholders)"
            );
            $type_rows->execute(array_keys($legacy_keys));
            foreach ($type_rows->fetchAll() as $tr) {
                $dist_items[] = ['type_id' => (int)$tr['id'], 'quantity' => $legacy_keys[$tr['key_name']]];
            }
        }
    }

    $db = db();
    $db->beginTransaction();
    try {
        $stmt = $db->prepare(
            'UPDATE barrios
             SET arrival_status   = \'on-site\',
                 arrived_at       = NOW(),
                 arrived_by       = ?,
                 arrived_by_name  = ?,
                 orientation_done = ?
             WHERE id = ? AND arrival_status = \'expected\''
        );
        $stmt->execute([$user['id'], $user['display_name'], $orientation, $barrio_id]);

        if ($stmt->rowCount() === 0) {
            $db->rollBack();
            $check = $db->prepare('SELECT arrival_status FROM barrios WHERE id = ?');
            $check->execute([$barrio_id]);
            $row = $check->fetch();
            if (!$row) json_error('Barrio not found', 404);
            json_error('Barrio already ' . $row['arrival_status'], 409);
        }

        // Record initial distribution events
        foreach ($dist_items as $item) {
            $type_id  = (int)($item['type_id'] ?? 0);
            $quantity = (int)($item['quantity'] ?? 0);
            if (!$type_id || $quantity <= 0) continue;

            $db->prepare(
                'INSERT INTO distribution_events
                    (barrio_id, type_id, quantity, performed_by, user_name_cache, occurred_at)
                 VALUES (?,?,?,?,?,NOW())'
            )->execute([$barrio_id, $type_id, $quantity, $user['id'], $user['display_name']]);

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

    $row = $db->prepare('SELECT * FROM barrios WHERE id = ?');
    $row->execute([$barrio_id]);
    $barrio = $row->fetch();
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

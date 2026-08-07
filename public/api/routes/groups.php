<?php
declare(strict_types=1);

// Groups merge what used to be two parallel entity types (barrios and artists):
// a group is any team/camp/collective that a department lends equipment to.
// enable_arrival_tracking / enable_consumable_entitlements are per-group
// capability flags — a barrio-like group sets both, an artist-like group
// typically sets neither.

function handle_list_groups(): void {
    require_method('GET');
    $user = require_auth();

    // Production level (view_inventory): see all groups (optionally filter by dept)
    // Dept level with view_groups/manage_groups: see their dept's groups, plus any
    // group they're a direct group_roles member of (e.g. a group lead who isn't
    // department staff)
    if (has_permission('view_inventory')) {
        $where  = isset($_GET['dept_id']) ? 'WHERE g.dept_id = ?' : '';
        $params = isset($_GET['dept_id']) ? [(int)$_GET['dept_id']] : [];
    } elseif (has_permission('view_groups') || has_permission('manage_groups')) {
        $dept_ids  = $user['dept_ids'] ?? [];
        $group_ids = $user['group_ids'] ?? [];
        $clauses   = [];
        $params    = [];
        if ($dept_ids) {
            $clauses[] = 'g.dept_id IN (' . implode(',', array_fill(0, count($dept_ids), '?')) . ')';
            $params    = array_merge($params, $dept_ids);
        }
        if ($group_ids) {
            $clauses[] = 'g.id IN (' . implode(',', array_fill(0, count($group_ids), '?')) . ')';
            $params    = array_merge($params, $group_ids);
        }
        $where = $clauses ? 'WHERE ' . implode(' OR ', $clauses) : 'WHERE 1=0';
    } else {
        json_error('Forbidden', 403);
        return;
    }

    $stmt = db()->prepare(
        "SELECT g.*, u.display_name AS assigned_staff_name,
            (SELECT COUNT(*) FROM equipment_items e
             WHERE e.holder_type = 'group' AND e.holder_id = g.id) AS items_out_count
         FROM groups g
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
        $r['items_out_count']                = (int)$r['items_out_count'];
        $r['items_out']                      = (int)$r['items_out_count'];
        $r['orientation_done']               = (bool)$r['orientation_done'];
        $r['enable_arrival_tracking']        = (bool)$r['enable_arrival_tracking'];
        $r['enable_consumable_entitlements'] = (bool)$r['enable_consumable_entitlements'];
    }
    unset($r);

    json_ok(['groups' => $rows]);
}

function handle_get_group(): void {
    require_method('GET');
    $user = require_auth();

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('id required', 400);

    $stmt = db()->prepare(
        'SELECT g.*, d.name AS dept_name, u.display_name AS assigned_staff_name,
            (SELECT COUNT(*) FROM equipment_items e
             WHERE e.holder_type = \'group\' AND e.holder_id = g.id AND e.status = \'checked-out\') AS items_out_count
         FROM groups g
         LEFT JOIN departments d ON d.id = g.dept_id
         LEFT JOIN users u ON u.id = g.assigned_staff_id
         WHERE g.id = ?'
    );
    $stmt->execute([$id]);
    $group = $stmt->fetch();
    if (!$group) json_error('Group not found', 404);

    // Access check for dept-scoped (non-production) users
    if (!has_permission('view_inventory') && $group['dept_id']) {
        require_dept_access((int)$group['dept_id']);
    }

    $group['id']                             = (int)$group['id'];
    $group['dept_id']                        = $group['dept_id'] !== null ? (int)$group['dept_id'] : null;
    $group['assigned_staff_id']              = $group['assigned_staff_id'] !== null ? (int)$group['assigned_staff_id'] : null;
    $group['items_out_count']                = (int)$group['items_out_count'];
    $group['orientation_done']               = (bool)$group['orientation_done'];
    $group['enable_arrival_tracking']        = (bool)$group['enable_arrival_tracking'];
    $group['enable_consumable_entitlements'] = (bool)$group['enable_consumable_entitlements'];

    $items = db()->prepare(
        'SELECT e.id, e.qr_code, e.dept_label,
            CONCAT(t.name, \' #\', e.item_number) AS name,
            t.category
         FROM equipment_items e
         JOIN equipment_types t ON t.id = e.equipment_type_id
         WHERE e.holder_type = \'group\' AND e.holder_id = ? AND e.status = \'checked-out\'
         ORDER BY t.name, e.item_number'
    );
    $items->execute([$id]);
    $current_items = $items->fetchAll();
    foreach ($current_items as &$i) $i['id'] = (int)$i['id'];
    unset($i);

    // Consumable entitlements (only meaningful when enable_consumable_entitlements)
    $entitlements = [];
    if ($group['enable_consumable_entitlements']) {
        $ent_stmt = db()->prepare(
            'SELECT ge.type_id, ct.key_name, ct.name, ct.sort_order,
                    ge.purchased, ge.distributed,
                    (CAST(ge.purchased AS SIGNED) - CAST(ge.distributed AS SIGNED)) AS remaining
             FROM group_entitlements ge
             JOIN consumable_types ct ON ct.id = ge.type_id
             WHERE ge.group_id = ?
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
    }

    // Equipment orders with live checked-out counts
    $ord_stmt = db()->prepare(
        'SELECT geo.equipment_type_id, et.name AS type_name,
                geo.quantity_ordered,
                (SELECT COUNT(*) FROM equipment_items ei
                 WHERE ei.holder_type = \'group\' AND ei.holder_id = ? AND ei.equipment_type_id = geo.equipment_type_id
                   AND ei.status = \'checked-out\') AS quantity_checked_out
         FROM group_equipment_orders geo
         JOIN equipment_types et ON et.id = geo.equipment_type_id
         WHERE geo.group_id = ?
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
        'group'            => $group,
        'barrio'           => $group,
        'items_out'        => $current_items,
        'current_items'    => $current_items,
        'entitlements'     => $entitlements,
        'equipment_orders' => $equipment_orders,
    ]);
}

function handle_group_arrival(): void {
    require_method('POST');
    $user = require_permission('manage_groups');
    verify_csrf();

    $b        = body();
    $group_id = (int)($b['group_id'] ?? $b['barrio_id'] ?? 0);
    if (!$group_id) json_error('group_id required');

    $chk = db()->prepare('SELECT enable_arrival_tracking FROM groups WHERE id = ?');
    $chk->execute([$group_id]);
    $g = $chk->fetch();
    if (!$g) json_error('Group not found', 404);
    if (!$g['enable_arrival_tracking']) {
        json_error('This group does not track arrival status', 400);
    }

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
            'UPDATE groups
             SET arrival_status   = \'on-site\',
                 arrived_at       = NOW(),
                 arrived_by       = ?,
                 arrived_by_name  = ?,
                 orientation_done = ?
             WHERE id = ? AND arrival_status = \'expected\''
        );
        $stmt->execute([$user['id'], $user['display_name'], $orientation, $group_id]);

        if ($stmt->rowCount() === 0) {
            $db->rollBack();
            $check = $db->prepare('SELECT arrival_status FROM groups WHERE id = ?');
            $check->execute([$group_id]);
            $row = $check->fetch();
            if (!$row) json_error('Group not found', 404);
            json_error('Group already ' . $row['arrival_status'], 409);
        }

        // Record initial distribution events
        foreach ($dist_items as $item) {
            $type_id  = (int)($item['type_id'] ?? 0);
            $quantity = (int)($item['quantity'] ?? 0);
            if (!$type_id || $quantity <= 0) continue;

            $db->prepare(
                'INSERT INTO distribution_events
                    (group_id, type_id, quantity, performed_by, user_name_cache, occurred_at)
                 VALUES (?,?,?,?,?,NOW())'
            )->execute([$group_id, $type_id, $quantity, $user['id'], $user['display_name']]);

            $db->prepare(
                'INSERT INTO group_entitlements (group_id, type_id, purchased, distributed)
                 VALUES (?,?,0,?)
                 ON DUPLICATE KEY UPDATE distributed = distributed + VALUES(distributed)'
            )->execute([$group_id, $type_id, $quantity]);
        }

        $db->commit();
    } catch (\Throwable $e) {
        $db->rollBack();
        throw $e;
    }

    $row = $db->prepare('SELECT * FROM groups WHERE id = ?');
    $row->execute([$group_id]);
    $group = $row->fetch();
    $group['orientation_done'] = (bool)$group['orientation_done'];

    json_ok(['success' => true, 'group' => $group, 'barrio' => $group]);
}

function handle_group_departure(): void {
    require_method('POST');
    $user = require_permission('manage_groups');
    verify_csrf();

    $b        = body();
    $group_id = (int)($b['group_id'] ?? $b['barrio_id'] ?? 0);
    $force    = !empty($b['force']);
    if (!$group_id) json_error('group_id required');

    $check = db()->prepare('SELECT arrival_status, enable_arrival_tracking FROM groups WHERE id = ?');
    $check->execute([$group_id]);
    $row = $check->fetch();
    if (!$row) json_error('Group not found', 404);
    if (!$row['enable_arrival_tracking']) {
        json_error('This group does not track arrival status', 400);
    }
    if ($row['arrival_status'] !== 'on-site') {
        json_error('Group is not on site (status: ' . $row['arrival_status'] . ')', 409);
    }

    if (!$force) {
        $count = db()->prepare(
            'SELECT COUNT(*) FROM equipment_items WHERE holder_type = \'group\' AND holder_id = ? AND status = \'checked-out\''
        );
        $count->execute([$group_id]);
        $n = (int)$count->fetchColumn();
        if ($n > 0) {
            http_response_code(409);
            echo json_encode(['error' => 'items_outstanding', 'count' => $n]);
            exit;
        }
    }

    $stmt = db()->prepare(
        'UPDATE groups
         SET arrival_status = \'departed\',
             departed_at    = NOW(),
             departed_by    = ?,
             departed_by_name = ?
         WHERE id = ? AND arrival_status = \'on-site\''
    );
    $stmt->execute([$user['id'], $user['display_name'], $group_id]);

    if ($stmt->rowCount() === 0) json_error('Departure could not be recorded', 409);

    json_ok(['success' => true]);
}

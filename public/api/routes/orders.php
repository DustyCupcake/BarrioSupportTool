<?php
declare(strict_types=1);

function handle_get_dept_orders(): void {
    require_method('GET');
    $user = require_auth();

    $dept_id = (int)($_GET['dept_id'] ?? 0);

    // production level can query any dept
    if (has_permission('view_inventory')) {
        if (!$dept_id) json_error('dept_id required');
    } else {
        if (!has_permission('submit_orders')) json_error('Forbidden', 403);
        // Dept users: use their first dept or the requested one if they have access
        if ($dept_id) {
            if (!in_array($dept_id, $user['dept_ids'], true)) json_error('Forbidden', 403);
        } else {
            $dept_id = $user['dept_ids'][0] ?? 0;
            if (!$dept_id) json_error('No department associated with your account', 400);
        }
    }

    $stmt = db()->prepare(
        'SELECT et.id AS equipment_type_id, et.name AS type_name, et.category,
                et.order_deadline,
                COALESCE(deo.quantity_ordered, 0) AS quantity_ordered,
                deo.submitted_at,
                (SELECT COUNT(*) FROM equipment_items ei
                 WHERE ei.equipment_type_id = et.id AND ei.owning_dept_id = ?) AS qty_in_pool
         FROM equipment_types et
         LEFT JOIN dept_equipment_orders deo
           ON deo.equipment_type_id = et.id AND deo.dept_id = ?
         ORDER BY et.category, et.name'
    );
    $stmt->execute([$dept_id, $dept_id]);
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) {
        $r['quantity_ordered']  = (int)$r['quantity_ordered'];
        $r['qty_in_pool']       = (int)$r['qty_in_pool'];
        $r['deadline_passed']   = $r['order_deadline'] ? strtotime($r['order_deadline']) < time() : false;
    }
    unset($r);

    json_ok(['dept_id' => $dept_id, 'orders' => $rows]);
}

function handle_save_dept_orders(): void {
    require_method('PUT');
    $user = require_permission('submit_orders');
    verify_csrf();

    $b       = body();
    $dept_id = (int)($b['dept_id'] ?? 0);
    $orders  = $b['orders'] ?? [];

    if (!$dept_id) json_error('dept_id required');
    if (!is_array($orders) || empty($orders)) json_error('orders required');

    // Access check
    if (!has_permission('manage_orders') && !in_array($dept_id, $user['dept_ids'], true)) {
        json_error('Forbidden', 403);
    }

    $pdo  = db();
    $pdo->beginTransaction();
    $now  = date('Y-m-d H:i:s');

    try {
        foreach ($orders as $o) {
            $type_id = (int)($o['equipment_type_id'] ?? 0);
            $qty     = max(0, (int)($o['quantity_ordered'] ?? 0));
            if (!$type_id) continue;

            // Enforce deadline
            $dl_stmt = db()->prepare(
                'SELECT order_deadline FROM equipment_types WHERE id = ?'
            );
            $dl_stmt->execute([$type_id]);
            $deadline = $dl_stmt->fetchColumn();

            if ($deadline && strtotime($deadline) < time()) {
                continue; // silently skip deadline-passed types
            }

            $pdo->prepare(
                'INSERT INTO dept_equipment_orders (dept_id, equipment_type_id, quantity_ordered, submitted_by, submitted_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   quantity_ordered = quantity_ordered + VALUES(quantity_ordered),
                   submitted_by     = VALUES(submitted_by),
                   submitted_at     = VALUES(submitted_at)'
            )->execute([$dept_id, $type_id, $qty, $user['id'], $now]);
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['success' => true]);
}

function handle_all_dept_orders(): void {
    require_method('GET');
    require_permission('manage_orders');

    $depts = db()->query(
        'SELECT id, name FROM departments WHERE is_active = 1 ORDER BY sort_order, name'
    )->fetchAll();

    $types = db()->query(
        'SELECT id, name, category, order_deadline FROM equipment_types ORDER BY category, name'
    )->fetchAll();

    $order_rows = db()->query(
        'SELECT dept_id, equipment_type_id, quantity_ordered FROM dept_equipment_orders'
    )->fetchAll();

    $pivot = [];
    foreach ($order_rows as $o) {
        $pivot[$o['equipment_type_id']][$o['dept_id']] = (int)$o['quantity_ordered'];
    }

    foreach ($types as &$t) {
        $t['deadline_passed'] = $t['order_deadline'] ? strtotime($t['order_deadline']) < time() : false;
    }
    unset($t);

    json_ok([
        'departments' => $depts,
        'types'       => $types,
        'pivot'       => $pivot,
    ]);
}

function handle_barrio_orders_aggregate(): void {
    require_method('GET');
    require_permission('manage_orders');

    $rows = db()->query(
        'SELECT equipment_type_id, SUM(quantity_ordered) AS total
         FROM group_equipment_orders GROUP BY equipment_type_id'
    )->fetchAll();

    foreach ($rows as &$r) $r['total'] = (int)$r['total'];
    unset($r);

    json_ok(['aggregate' => $rows]);
}

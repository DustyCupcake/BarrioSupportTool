<?php
declare(strict_types=1);

function handle_list_departments(): void {
    require_method('GET');
    require_auth();

    $rows = db()->query(
        'SELECT id, name, slug, manages_groups, sort_order
         FROM departments
         WHERE is_active = 1
         ORDER BY sort_order, name'
    )->fetchAll();

    foreach ($rows as &$r) {
        $r['id']             = (int)$r['id'];
        $r['sort_order']     = (int)$r['sort_order'];
        $r['manages_groups'] = (bool)$r['manages_groups'];
    }
    unset($r);

    json_ok(['departments' => $rows]);
}

function handle_get_department(): void {
    require_method('GET');
    $user    = require_auth();
    $dept_id = (int)($_GET['id'] ?? 0);
    if (!$dept_id) json_error('id required');

    require_dept_access($dept_id);

    $stmt = db()->prepare(
        'SELECT d.id, d.name, d.slug, d.manages_groups, d.sort_order
         FROM departments d WHERE d.id = ? AND d.is_active = 1'
    );
    $stmt->execute([$dept_id]);
    $dept = $stmt->fetch();

    if (!$dept) json_error('Department not found', 404);

    $dept['id']             = (int)$dept['id'];
    $dept['sort_order']     = (int)$dept['sort_order'];
    $dept['manages_groups'] = (bool)$dept['manages_groups'];

    // Groups belonging to this department
    $groups = [];
    if ($dept['manages_groups']) {
        $stmt = db()->prepare(
            'SELECT g.id, g.name, g.arrival_status, u.display_name AS assigned_staff_name
             FROM groups g
             LEFT JOIN users u ON u.id = g.assigned_staff_id
             WHERE g.dept_id = ? ORDER BY g.sort_order, g.name'
        );
        $stmt->execute([$dept_id]);
        $groups = $stmt->fetchAll();
    }

    foreach ($groups as &$s) $s['id'] = (int)$s['id'];
    unset($s);

    // Pool size: items in dept but not sub-lent
    $stmt = db()->prepare(
        'SELECT COUNT(*) FROM equipment_items
         WHERE owning_dept_id = ? AND (holder_type IS NULL OR holder_type != \'group\')'
    );
    $stmt->execute([$dept_id]);
    $pool_size = (int)$stmt->fetchColumn();

    // Order totals
    $stmt = db()->prepare(
        'SELECT deo.equipment_type_id, et.name AS type_name, deo.quantity_ordered, deo.submitted_at
         FROM dept_equipment_orders deo
         JOIN equipment_types et ON et.id = deo.equipment_type_id
         WHERE deo.dept_id = ?
         ORDER BY et.name'
    );
    $stmt->execute([$dept_id]);
    $orders = $stmt->fetchAll();

    json_ok(array_merge($dept, [
        'sub_entities' => $groups,
        'groups'       => $groups,
        'pool_size'    => $pool_size,
        'orders'       => $orders,
    ]));
}

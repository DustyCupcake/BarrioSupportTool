<?php
declare(strict_types=1);

function handle_list_borrow_rules(): void {
    require_method('GET');
    require_auth();

    $type_id = isset($_GET['type_id']) ? (int)$_GET['type_id'] : null;
    $item_id = isset($_GET['item_id']) ? (int)$_GET['item_id'] : null;

    if (!$type_id && !$item_id) json_error('type_id or item_id required', 400);

    // Restrict dept admins to items in their dept
    if (!has_permission('manage_equipment')) {
        if (!has_permission('sub_checkout')) json_error('Forbidden', 403);
        // Dept admin: validate the item/type is in one of their depts
        if ($item_id) {
            _assert_dept_item_access($item_id);
        }
    }

    if ($item_id) {
        $stmt = db()->prepare(
            'SELECT r.id, r.equipment_type_id, r.item_id,
                    r.allowed_dept_id, d.name AS dept_name,
                    r.allowed_user_id, u.display_name AS user_name
             FROM equipment_borrow_rules r
             LEFT JOIN departments d ON d.id = r.allowed_dept_id
             LEFT JOIN users u ON u.id = r.allowed_user_id
             WHERE r.item_id = ?
             ORDER BY r.id'
        );
        $stmt->execute([$item_id]);
    } else {
        $stmt = db()->prepare(
            'SELECT r.id, r.equipment_type_id, r.item_id,
                    r.allowed_dept_id, d.name AS dept_name,
                    r.allowed_user_id, u.display_name AS user_name
             FROM equipment_borrow_rules r
             LEFT JOIN departments d ON d.id = r.allowed_dept_id
             LEFT JOIN users u ON u.id = r.allowed_user_id
             WHERE r.equipment_type_id = ? AND r.item_id IS NULL
             ORDER BY r.id'
        );
        $stmt->execute([$type_id]);
    }

    $rules = $stmt->fetchAll();
    foreach ($rules as &$r) {
        $r['id']              = (int)$r['id'];
        $r['equipment_type_id'] = $r['equipment_type_id'] ? (int)$r['equipment_type_id'] : null;
        $r['item_id']         = $r['item_id'] ? (int)$r['item_id'] : null;
        $r['allowed_dept_id'] = $r['allowed_dept_id'] ? (int)$r['allowed_dept_id'] : null;
        $r['allowed_user_id'] = $r['allowed_user_id'] ? (int)$r['allowed_user_id'] : null;
    }
    unset($r);

    json_ok(['rules' => $rules]);
}

function handle_add_borrow_rule(): void {
    require_method('POST');
    require_auth();
    verify_csrf();

    if (!has_permission('manage_equipment') && !has_permission('sub_checkout')) {
        json_error('Forbidden', 403);
    }

    $b       = body();
    $type_id = isset($b['type_id']) ? (int)$b['type_id'] : null;
    $item_id = isset($b['item_id']) ? (int)$b['item_id'] : null;
    $user_id = isset($b['allowed_user_id']) ? (int)$b['allowed_user_id'] : null;
    $dept_id = isset($b['allowed_dept_id']) ? (int)$b['allowed_dept_id'] : null;

    if (!$type_id && !$item_id) json_error('type_id or item_id required', 400);
    if ($type_id && $item_id) json_error('Provide type_id or item_id, not both', 400);
    if (!$user_id && !$dept_id) json_error('allowed_user_id or allowed_dept_id required', 400);

    // Dept admins can only add rules for items currently in their dept
    if (!has_permission('manage_equipment')) {
        if ($item_id) {
            _assert_dept_item_access($item_id);
        } else {
            json_error('Only production admins can add type-level borrow rules', 403);
        }
    }

    db()->prepare(
        'INSERT INTO equipment_borrow_rules (equipment_type_id, item_id, allowed_dept_id, allowed_user_id)
         VALUES (?, ?, ?, ?)'
    )->execute([$type_id ?: null, $item_id ?: null, $dept_id ?: null, $user_id ?: null]);

    $rule_id = (int)db()->lastInsertId();
    json_ok(['id' => $rule_id], 201);
}

function handle_delete_borrow_rule(): void {
    require_method('DELETE');
    require_auth();
    verify_csrf();

    if (!has_permission('manage_equipment') && !has_permission('sub_checkout')) {
        json_error('Forbidden', 403);
    }

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('id required', 400);

    if (!has_permission('manage_equipment')) {
        // Dept admins: verify this rule applies to an item in their dept
        $rule_stmt = db()->prepare('SELECT item_id FROM equipment_borrow_rules WHERE id = ?');
        $rule_stmt->execute([$id]);
        $rule = $rule_stmt->fetch();
        if (!$rule) json_error('Rule not found', 404);
        if (!$rule['item_id']) json_error('Forbidden', 403);
        _assert_dept_item_access((int)$rule['item_id']);
    }

    $del = db()->prepare('DELETE FROM equipment_borrow_rules WHERE id = ?');
    $del->execute([$id]);

    if ($del->rowCount() === 0) json_error('Rule not found', 404);
    json_ok(['success' => true]);
}

function _assert_dept_item_access(int $item_id): void {
    start_session();
    $dept_ids = $_SESSION['dept_ids'] ?? [];

    $stmt = db()->prepare(
        'SELECT owning_dept_id FROM equipment_items WHERE id = ?'
    );
    $stmt->execute([$item_id]);
    $item = $stmt->fetch();

    if (!$item || !$item['owning_dept_id'] || !in_array((int)$item['owning_dept_id'], $dept_ids, true)) {
        json_error('Forbidden: item not in your department', 403);
    }
}

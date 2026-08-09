<?php
declare(strict_types=1);

/**
 * Unified QR code lookup. No auth required — returns public info for anyone,
 * richer detail when a session is present.
 *
 * Lookup order: equipment item → user (person QR) → group → department
 */
function handle_scan_lookup(): void {
    require_method('GET');

    $qr = trim($_GET['qr'] ?? '');
    if ($qr === '') json_error('qr required');

    // Determine auth state without hard-requiring login
    start_session();
    $authed = !empty($_SESSION['user_id']) || !empty($_SESSION['is_shift']);
    $perms  = [];
    $user   = null;
    if ($authed) {
        $user  = $_SESSION['_auth_cache'] ?? _build_auth_return();
        $perms = $user['permissions'] ?? [];
    }

    // ── 1. Equipment item ────────────────────────────────────────────────────
    $stmt = db()->prepare(
        'SELECT i.id, i.qr_code, i.status, i.notes, i.equipment_type_id, i.dept_label,
                i.owning_dept_id, i.holder_type, i.holder_id,
                i.home_location_id AS item_home_loc_id,
                i.require_home_location AS item_require_home,
                i.require_any_location AS item_require_any,
                t.name AS type_name, t.category, t.borrowable,
                t.home_location_id AS type_home_loc_id,
                t.require_home_location AS type_require_home,
                t.require_any_location AS type_require_any,
                hg.name AS group_name,
                d.name AS dept_name,
                hd.name AS holder_dept_name,
                p.display_name AS person_name,
                hl.id AS eff_home_loc_id, hl.name AS home_location_name,
                hl.latitude AS home_lat, hl.longitude AS home_lng,
                CONCAT(t.name, " #", i.item_number) AS display_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN departments d  ON d.id = i.owning_dept_id
         LEFT JOIN groups      hg ON hg.id = i.holder_id AND i.holder_type = "group"
         LEFT JOIN departments hd ON hd.id = i.holder_id AND i.holder_type = "department"
         LEFT JOIN users       p  ON p.id = i.holder_id AND i.holder_type = "person"
         LEFT JOIN storage_locations hl ON hl.id = COALESCE(i.home_location_id, t.home_location_id)
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$qr]);
    if ($item = $stmt->fetch()) {
        $result = [
            'type'      => 'item',
            'name'      => $item['display_name'],
            'category'  => $item['category'],
            'status'    => $item['status'],
        ];

        if ($authed) {
            $result['id']              = (int)$item['id'];
            $result['qr_code']         = $item['qr_code'];
            $result['dept_label']      = $item['dept_label'];
            $result['borrowable']      = (bool)$item['borrowable'];
            $result['current_dept']    = $item['owning_dept_id']
                ? ['id' => (int)$item['owning_dept_id'],   'name' => $item['dept_name']]   : null;
            $result['holder_type']     = $item['holder_type'];
            $result['current_group']   = ($item['holder_type'] === 'group' && $item['holder_id'])
                ? ['id' => (int)$item['holder_id'], 'name' => $item['group_name']] : null;
            $result['holder_dept']     = ($item['holder_type'] === 'department' && $item['holder_id'])
                ? ['id' => (int)$item['holder_id'], 'name' => $item['holder_dept_name']] : null;
            $result['current_person']  = ($item['holder_type'] === 'person' && $item['holder_id'])
                ? ['id' => (int)$item['holder_id'], 'name' => $item['person_name']] : null;

            $result['require_home_location'] = $item['item_require_home'] !== null
                ? (bool)$item['item_require_home'] : (bool)$item['type_require_home'];
            $result['require_any_location']  = $item['item_require_any'] !== null
                ? (bool)$item['item_require_any'] : (bool)$item['type_require_any'];
            $result['home_location'] = $item['eff_home_loc_id']
                ? ['id'        => (int)$item['eff_home_loc_id'],
                   'name'      => $item['home_location_name'],
                   'latitude'  => $item['home_lat'] !== null ? (float)$item['home_lat'] : null,
                   'longitude' => $item['home_lng'] !== null ? (float)$item['home_lng'] : null]
                : null;

            if ($item['borrowable']) {
                $eligibility = check_borrow_eligible(
                    (int)$item['id'],
                    (int)$item['equipment_type_id']
                );
                $result['borrow_eligible'] = $eligibility['eligible'];
                $result['borrow_reason']   = $eligibility['reason'] ?? null;
            }
        }
        json_ok($result);
    }

    // ── 2. Person (user qr_token) ────────────────────────────────────────────
    $stmt = db()->prepare(
        'SELECT id, display_name, qr_token FROM users WHERE qr_token = ? AND is_active = 1'
    );
    $stmt->execute([$qr]);
    if ($person = $stmt->fetch()) {
        $result = [
            'type' => 'person',
            'name' => $person['display_name'],
        ];
        if ($authed) {
            $result['id']       = (int)$person['id'];
            $result['qr_token'] = $person['qr_token'];

            if (in_array('manage_users', $perms, true) || in_array('manage_dept_users', $perms, true)) {
                $mem_stmt = db()->prepare(
                    'SELECT d.id, d.name, udr.role
                     FROM user_dept_roles udr
                     JOIN departments d ON d.id = udr.dept_id
                     WHERE udr.user_id = ?
                     ORDER BY d.name'
                );
                $mem_stmt->execute([$person['id']]);
                $memberships = $mem_stmt->fetchAll();
                $result['dept_memberships'] = array_map(
                    fn($m) => ['id' => (int)$m['id'], 'name' => $m['name'], 'role' => $m['role']],
                    $memberships
                );
            }
        }
        json_ok($result);
    }

    // ── 3. Group ─────────────────────────────────────────────────────────────
    // Also matches fill_voucher_code — a separate code that resolves to the
    // same group for fill-request purposes only. It is never written into
    // shift_tokens.token, so unlike qr_code it can't be used to start a
    // self-service session, even though it resolves here the same way.
    $stmt = db()->prepare(
        'SELECT id, name, arrival_status, enable_arrival_tracking, enable_consumable_entitlements
         FROM groups WHERE qr_code = ? OR fill_voucher_code = ?'
    );
    $stmt->execute([$qr, $qr]);
    if ($group = $stmt->fetch()) {
        $result = [
            'type'                          => 'group',
            'name'                          => $group['name'],
            'arrival_status'                => $group['arrival_status'],
            'enable_arrival_tracking'       => (bool)$group['enable_arrival_tracking'],
            'enable_consumable_entitlements' => (bool)$group['enable_consumable_entitlements'],
        ];
        if ($authed) {
            $result['id'] = (int)$group['id'];

            if (in_array('view_groups', $perms, true) || in_array('manage_groups', $perms, true)) {
                $ic_stmt = db()->prepare(
                    'SELECT COUNT(*) FROM equipment_items WHERE holder_type = "group" AND holder_id = ?'
                );
                $ic_stmt->execute([$group['id']]);
                $item_count = (int)$ic_stmt->fetchColumn();
                $result['item_count'] = $item_count;
            }
        }
        json_ok($result);
    }

    // ── 4. Department ────────────────────────────────────────────────────────
    $stmt = db()->prepare(
        'SELECT id, name, manages_groups FROM departments WHERE qr_code = ? AND is_active = 1'
    );
    $stmt->execute([$qr]);
    if ($dept = $stmt->fetch()) {
        $result = [
            'type'           => 'department',
            'name'           => $dept['name'],
            'manages_groups' => (bool)$dept['manages_groups'],
        ];
        if ($authed) {
            $result['id'] = (int)$dept['id'];

            if (in_array('manage_departments', $perms, true) || in_array('manage_dept_users', $perms, true)) {
                $mc_stmt = db()->prepare(
                    'SELECT COUNT(*) FROM user_dept_roles WHERE dept_id = ?'
                );
                $mc_stmt->execute([$dept['id']]);
                $member_count = (int)$mc_stmt->fetchColumn();
                $result['member_count'] = $member_count;
            }
        }
        json_ok($result);
    }

    // ── 5. Storage location ──────────────────────────────────────────────────
    $stmt = db()->prepare(
        'SELECT id, name, description FROM storage_locations WHERE qr_code = ?'
    );
    $stmt->execute([$qr]);
    if ($loc = $stmt->fetch()) {
        $result = [
            'type'        => 'storage_location',
            'name'        => $loc['name'],
            'description' => $loc['description'],
            'id'          => (int)$loc['id'],
            'qr_code'     => $qr,
        ];
        if ($authed) {
            $items_stmt = db()->prepare(
                'SELECT COUNT(*) FROM equipment_items WHERE current_location_id = ?'
            );
            $items_stmt->execute([$loc['id']]);
            $result['item_count'] = (int)$items_stmt->fetchColumn();
        }
        json_ok($result);
    }

    // ── Nothing found ────────────────────────────────────────────────────────
    json_ok(['type' => 'unknown']);
}

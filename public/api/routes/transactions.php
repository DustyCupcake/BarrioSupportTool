<?php
declare(strict_types=1);

// Production checking out equipment to a department
function handle_checkout(): void {
    require_method('POST');
    $user = require_permission('checkout_equipment');
    verify_csrf();

    $b         = body();
    $dept_id   = (int)($b['dept_id'] ?? 0);
    $item_qrs  = $b['item_qrs'] ?? [];
    $force     = !empty($b['force']);
    $dept_label = isset($b['dept_label']) ? trim($b['dept_label']) : null;

    if (!$dept_id || empty($item_qrs) || !is_array($item_qrs)) {
        json_error('dept_id and item_qrs required');
    }

    $dept = db()->prepare('SELECT id FROM departments WHERE id = ? AND is_active = 1');
    $dept->execute([$dept_id]);
    if (!$dept->fetch()) json_error('Department not found', 404);

    $results = [];
    $now     = date('Y-m-d H:i:s');
    $pdo     = db();
    $pdo->beginTransaction();

    try {
        foreach ($item_qrs as $qr) {
            $qr   = (string)$qr;
            $stmt = $pdo->prepare(
                'SELECT id, status, owning_dept_id, holder_type, holder_id
                 FROM equipment_items WHERE qr_code = ? FOR UPDATE'
            );
            $stmt->execute([$qr]);
            $item = $stmt->fetch();

            if (!$item) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_found'];
                continue;
            }

            if ($item['status'] === 'checked-out' && !$force) {
                $loc = item_holder_label($pdo, $item);
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'already_checked_out', 'location' => $loc];
                continue;
            }

            if (!in_array($item['status'], ['available', 'checked-out'], true)) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_available'];
                continue;
            }

            assign_item_holder($pdo, (int)$item['id'], 'department', $dept_id,
                $dept_id, false, $dept_label ?: null, false);

            insert_holder_transaction($pdo, 'checkout', (int)$item['id'], $dept_id,
                'department', $dept_id, (int)$user['id'], $user['display_name'], $now);

            $results[] = ['qr' => $qr, 'success' => true];
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['results' => $results]);
}

// Department lending equipment to a group
function handle_sub_checkout(): void {
    require_method('POST');
    $user = require_permission('sub_checkout');
    verify_csrf();

    $b                   = body();
    $dept_id             = (int)($b['dept_id'] ?? 0);
    $group_id            = isset($b['group_id']) ? (int)$b['group_id'] : null;
    $item_qrs            = $b['item_qrs'] ?? [];
    $force               = !empty($b['force']);
    $dept_label          = isset($b['dept_label']) ? trim($b['dept_label']) : null;
    $latitude            = isset($b['latitude'])   ? (float)$b['latitude']  : null;
    $longitude           = isset($b['longitude'])  ? (float)$b['longitude'] : null;
    $apply_group_location = array_key_exists('apply_barrio_location', $b)
        ? !empty($b['apply_barrio_location'])
        : (array_key_exists('apply_group_location', $b) ? !empty($b['apply_group_location']) : true);

    $production = has_permission('checkout_equipment');

    if (!$dept_id && !$production) {
        json_error('dept_id required');
    }
    if (!$group_id || empty($item_qrs) || !is_array($item_qrs)) {
        json_error('group_id and item_qrs required');
    }

    if (!$production) {
        require_dept_access($dept_id);
    }

    // If no explicit GPS was captured, fall back to the group's storage location —
    // but only when it's unambiguous (exactly one location on file for that group).
    $group_location_applied = false;
    if ($group_id && $apply_group_location && $latitude === null && $longitude === null) {
        $loc = get_group_location(db(), $group_id);
        if ($loc) {
            $latitude  = $loc['latitude'];
            $longitude = $loc['longitude'];
            $group_location_applied = true;
        }
    }

    $results = [];
    $now     = date('Y-m-d H:i:s');
    $pdo     = db();
    $pdo->beginTransaction();

    try {
        foreach ($item_qrs as $qr) {
            $qr   = (string)$qr;
            $stmt = $pdo->prepare(
                'SELECT id, status, owning_dept_id, holder_type, holder_id
                 FROM equipment_items WHERE qr_code = ? FOR UPDATE'
            );
            $stmt->execute([$qr]);
            $item = $stmt->fetch();

            if (!$item) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_found'];
                continue;
            }

            // Use item's owning dept if already assigned, otherwise use the user's dept
            $effective_dept_id = (int)$item['owning_dept_id'] ?: $dept_id;

            if ($item['holder_type'] === 'group' && !$force) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'already_sub_lent'];
                continue;
            }

            assign_item_holder($pdo, (int)$item['id'], 'group', $group_id,
                $effective_dept_id ?: null, true, $dept_label ?: null, true,
                $latitude, $longitude);

            insert_holder_transaction($pdo, 'sub_checkout', (int)$item['id'], $effective_dept_id ?: null,
                'group', $group_id, (int)$user['id'], $user['display_name'], $now);

            $results[] = ['qr' => $qr, 'success' => true];
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok([
        'results'                => $results,
        'barrio_location_applied' => $group_location_applied,
        'group_location_applied'  => $group_location_applied,
    ]);
}

// Unified check-in: auto-detects whether to do sub_checkin or full checkin
function handle_checkin(): void {
    require_method('POST');
    $user    = require_auth();
    verify_csrf();

    $b           = body();
    $item_qr     = trim($b['item_qr'] ?? '');
    $location_qr = trim($b['location_qr'] ?? '');

    if ($item_qr === '') json_error('item_qr required');

    $stmt = db()->prepare(
        'SELECT i.id, i.status, i.owning_dept_id, i.holder_type, i.holder_id,
                i.home_location_id AS item_home_location_id,
                i.require_home_location AS item_require_home,
                i.require_any_location AS item_require_any,
                t.home_location_id AS type_home_location_id,
                t.require_home_location AS type_require_home,
                t.require_any_location AS type_require_any,
                hl.name AS home_location_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN storage_locations hl ON hl.id = COALESCE(i.home_location_id, t.home_location_id)
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$item_qr]);
    $item = $stmt->fetch();

    if (!$item) json_error('Item not found', 404);

    if (!in_array($item['status'], ['checked-out', 'activated'], true)) {
        json_ok(['success' => false, 'error' => 'not_checked_out']);
        return;
    }

    // Resolve effective location requirements (item overrides type, NULL = inherit)
    $eff_home_loc_id      = (int)(($item['item_home_location_id'] ?? null) ?? ($item['type_home_location_id'] ?? null));
    $eff_require_home     = $item['item_require_home'] !== null
        ? (bool)$item['item_require_home']
        : (bool)$item['type_require_home'];
    $eff_require_any      = $item['item_require_any'] !== null
        ? (bool)$item['item_require_any']
        : (bool)$item['type_require_any'];

    // Resolve provided location QR to a location ID
    $location_id = null;
    if ($location_qr !== '') {
        $loc_stmt = db()->prepare('SELECT id FROM storage_locations WHERE qr_code = ?');
        $loc_stmt->execute([$location_qr]);
        $loc = $loc_stmt->fetch();
        if (!$loc) json_error('Storage location QR not recognised', 404);
        $location_id = (int)$loc['id'];

        // Validate against home location requirement
        if ($eff_require_home && $eff_home_loc_id && $location_id !== $eff_home_loc_id) {
            json_error(
                'This item must be returned to its home location: ' . ($item['home_location_name'] ?? 'home location'),
                422
            );
        }
    }

    // Enforce location scan requirements
    if ($eff_require_home && !$location_id) {
        json_error(
            'Scan the home location QR to return this item: ' . ($item['home_location_name'] ?? 'home location'),
            422
        );
    }
    if ($eff_require_any && !$location_id) {
        json_error('Scan a storage location QR to return this item', 422);
    }

    $dept_id     = $item['owning_dept_id'] ? (int)$item['owning_dept_id'] : null;
    $holder_type = $item['holder_type'];
    $holder_id   = $item['holder_id'] ? (int)$item['holder_id'] : null;

    // Sub-lent = in dept pool then further lent to a group, or to a person from a dept pool
    $is_sub_lent    = $holder_type === 'group' || ($holder_type === 'person' && $dept_id);
    // Person-from-production = no dept, just person
    $is_person_prod = $holder_type === 'person' && !$dept_id;

    // Permission check
    if ($is_sub_lent || $is_person_prod) {
        if (!has_permission('sub_checkin') && !has_permission('checkin_equipment')) {
            json_error('Forbidden', 403);
        }
    } else {
        if (!has_permission('checkin_equipment')) {
            json_error('Forbidden', 403);
        }
    }

    // Dept access check for non-production users
    if (!has_permission('checkin_equipment') && $dept_id) {
        require_dept_access($dept_id);
    }

    $pdo = db();
    $pdo->beginTransaction();
    try {
        if ($is_person_prod) {
            set_item_holder($pdo, (int)$item['id'], null, null, 'available', $location_id);
            $pdo->prepare(
                'UPDATE equipment_items SET dept_label = NULL WHERE id = ?'
            )->execute([$item['id']]);

            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, holder_type, holder_id, location_id, performed_by, user_name_cache, occurred_at)
                 VALUES ("person_checkin", ?, "person", ?, ?, ?, ?, NOW())'
            )->execute([$item['id'], $holder_id, $location_id, $user['id'], $user['display_name']]);

        } elseif ($is_sub_lent) {
            if ($dept_id) {
                // Returns to dept-held state (status/owning_dept_id untouched) — matching the
                // pre-holder-model behavior where sub_checkin cleared only barrio/artist/person,
                // leaving the item checked out to its owning department rather than fully available.
                $pdo->prepare(
                    'UPDATE equipment_items
                     SET holder_type = "department", holder_id = owning_dept_id,
                         current_location_id = ?
                     WHERE id = ?'
                )->execute([$location_id, $item['id']]);
            } else {
                // No owning department (production lent this directly to a group/person) —
                // there's no dept pool to return it to, so it goes straight back to available.
                // Without this branch, holder_type would be set to 'department' with a NULL
                // holder_id (owning_dept_id is null here), violating the holder/status trigger.
                set_item_holder($pdo, (int)$item['id'], null, null, 'available', $location_id);
                $pdo->prepare(
                    'UPDATE equipment_items SET dept_label = NULL WHERE id = ?'
                )->execute([$item['id']]);
            }

            $tx_type = $holder_type === 'person' ? 'person_checkin' : 'sub_checkin';
            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, dept_id, holder_type, holder_id,
                                           location_id, performed_by, user_name_cache, occurred_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())'
            )->execute([
                $tx_type, $item['id'], $dept_id, $holder_type, $holder_id,
                $location_id, $user['id'], $user['display_name'],
            ]);

        } else {
            $pdo->prepare(
                'UPDATE equipment_items
                 SET status = "available", owning_dept_id = NULL, dept_label = NULL,
                     holder_type = NULL, holder_id = NULL,
                     current_location_id = ?
                 WHERE id = ?'
            )->execute([$location_id, $item['id']]);

            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, dept_id, location_id, performed_by, user_name_cache, occurred_at)
                 VALUES ("checkin", ?, ?, ?, ?, ?, NOW())'
            )->execute([$item['id'], $dept_id, $location_id, $user['id'], $user['display_name']]);
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    $tier = $is_person_prod ? 'person_prod' : ($is_sub_lent ? 'sub' : 'dept');
    json_ok(['success' => true, 'tier' => $tier, 'location_id' => $location_id]);
}

// Production lending equipment directly to a named person (or person borrowing for themselves)
function handle_person_checkout(): void {
    require_method('POST');
    verify_csrf();

    // Allow: staff with checkout_equipment OR person with person_borrow (self-checkout)
    $is_self_checkout = false;
    if (has_permission('person_borrow') && !has_permission('checkout_equipment')) {
        $user = require_permission('person_borrow');
        $is_self_checkout = true;
    } else {
        $user = require_permission('checkout_equipment');
    }

    $b          = body();
    $item_qrs   = $b['item_qrs'] ?? [];
    $force      = !empty($b['force']);
    $dept_label = isset($b['dept_label']) ? trim($b['dept_label']) : null;

    // For self-checkout, use the session's own QR token as the person
    $person_qr = $is_self_checkout
        ? ($_SESSION['qr_token'] ?? '')
        : trim($b['person_qr'] ?? '');

    if ($person_qr === '' || empty($item_qrs) || !is_array($item_qrs)) {
        json_error('person_qr and item_qrs required');
    }

    $person_stmt = db()->prepare(
        'SELECT id, display_name FROM users WHERE qr_token = ? AND is_active = 1'
    );
    $person_stmt->execute([$person_qr]);
    $person = $person_stmt->fetch();
    if (!$person) json_error('Person QR not found', 404);

    $results = [];
    $now     = date('Y-m-d H:i:s');
    $pdo     = db();
    $pdo->beginTransaction();

    try {
        foreach ($item_qrs as $qr) {
            $qr   = (string)$qr;
            $stmt = $pdo->prepare(
                'SELECT id, status, owning_dept_id, holder_type, holder_id
                 FROM equipment_items WHERE qr_code = ? FOR UPDATE'
            );
            $stmt->execute([$qr]);
            $item = $stmt->fetch();

            if (!$item) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_found'];
                continue;
            }
            if ($item['status'] === 'checked-out' && !$force) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'already_checked_out',
                              'location' => item_holder_label($pdo, $item)];
                continue;
            }
            if (!in_array($item['status'], ['available', 'checked-out'], true)) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_available'];
                continue;
            }

            // Verify the item type is borrowable
            $tr_stmt = $pdo->prepare(
                'SELECT et.borrowable, et.id AS type_id
                 FROM equipment_types et
                 JOIN equipment_items ei ON ei.equipment_type_id = et.id
                 WHERE ei.id = ?'
            );
            $tr_stmt->execute([$item['id']]);
            $type_row = $tr_stmt->fetch();
            if (empty($type_row['borrowable'])) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_borrowable'];
                continue;
            }

            // Enforce borrow eligibility rules
            $elig = check_borrow_eligible((int)$item['id'], (int)$type_row['type_id']);
            if (!$elig['eligible']) {
                $results[] = [
                    'qr'      => $qr,
                    'success' => false,
                    'error'   => 'borrow_restricted',
                    'reason'  => $elig['reason'],
                    'type_id' => (int)$type_row['type_id'],
                    'item_id' => (int)$item['id'],
                ];
                continue;
            }

            assign_item_holder($pdo, (int)$item['id'], 'person', (int)$person['id'],
                null, false, $dept_label ?: null, false);

            insert_holder_transaction($pdo, 'person_checkout', (int)$item['id'], null,
                'person', (int)$person['id'], (int)$user['id'], $user['display_name'], $now);

            $results[] = ['qr' => $qr, 'success' => true];
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['results' => $results, 'person' => ['id' => (int)$person['id'], 'display_name' => $person['display_name']]]);
}

// Department lending equipment from its pool to a named person
function handle_sub_person_checkout(): void {
    require_method('POST');
    $user = require_permission('sub_checkout');
    verify_csrf();

    $b          = body();
    $dept_id    = (int)($b['dept_id'] ?? 0);
    $person_qr  = trim($b['person_qr'] ?? '');
    $item_qrs   = $b['item_qrs'] ?? [];
    $force      = !empty($b['force']);
    $dept_label = isset($b['dept_label']) ? trim($b['dept_label']) : null;

    if (!$dept_id || $person_qr === '' || empty($item_qrs) || !is_array($item_qrs)) {
        json_error('dept_id, person_qr, and item_qrs required');
    }

    if (!has_permission('checkout_equipment')) {
        require_dept_access($dept_id);
    }

    $person_stmt = db()->prepare(
        'SELECT id, display_name FROM users WHERE qr_token = ? AND is_active = 1'
    );
    $person_stmt->execute([$person_qr]);
    $person = $person_stmt->fetch();
    if (!$person) json_error('Person QR not found', 404);

    $results = [];
    $now     = date('Y-m-d H:i:s');
    $pdo     = db();
    $pdo->beginTransaction();

    try {
        foreach ($item_qrs as $qr) {
            $qr   = (string)$qr;
            $stmt = $pdo->prepare(
                'SELECT id, status, owning_dept_id, holder_type, holder_id
                 FROM equipment_items WHERE qr_code = ? FOR UPDATE'
            );
            $stmt->execute([$qr]);
            $item = $stmt->fetch();

            if (!$item) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_found'];
                continue;
            }
            if ($item['holder_type'] && !$force) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'already_sub_lent'];
                continue;
            }

            // Enforce borrow eligibility rules for sub-person checkout too
            $type_stmt2 = $pdo->prepare(
                'SELECT et.borrowable, et.id AS type_id
                 FROM equipment_types et
                 JOIN equipment_items ei ON ei.equipment_type_id = et.id
                 WHERE ei.id = ?'
            );
            $type_stmt2->execute([$item['id']]);
            $type_row2 = $type_stmt2->fetch();
            if (empty($type_row2['borrowable'])) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_borrowable'];
                continue;
            }
            $elig2 = check_borrow_eligible((int)$item['id'], (int)$type_row2['type_id']);
            if (!$elig2['eligible']) {
                $results[] = [
                    'qr'      => $qr,
                    'success' => false,
                    'error'   => 'borrow_restricted',
                    'reason'  => $elig2['reason'],
                    'type_id' => (int)$type_row2['type_id'],
                    'item_id' => (int)$item['id'],
                ];
                continue;
            }

            assign_item_holder($pdo, (int)$item['id'], 'person', (int)$person['id'],
                $dept_id ?: null, true, $dept_label ?: null, true);

            insert_holder_transaction($pdo, 'person_checkout', (int)$item['id'], $dept_id,
                'person', (int)$person['id'], (int)$user['id'], $user['display_name'], $now);

            $results[] = ['qr' => $qr, 'success' => true];
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['results' => $results, 'person' => ['id' => (int)$person['id'], 'display_name' => $person['display_name']]]);
}

// Set or update the dept label on a checked-out item
function handle_set_label(): void {
    require_method('PUT');
    $user = require_permission('label_equipment');
    verify_csrf();

    $b       = body();
    $item_qr = trim($b['item_qr'] ?? '');
    $label   = trim($b['label'] ?? '');

    if ($item_qr === '') json_error('item_qr required');

    $stmt = db()->prepare(
        'SELECT id, owning_dept_id FROM equipment_items WHERE qr_code = ? AND status = "checked-out"'
    );
    $stmt->execute([$item_qr]);
    $item = $stmt->fetch();

    if (!$item) json_error('Item not found or not checked out', 404);

    // Verify dept access for non-production users
    if (!has_permission('checkout_equipment') && $item['owning_dept_id']) {
        require_dept_access((int)$item['owning_dept_id']);
    }

    db()->prepare(
        'UPDATE equipment_items SET dept_label = ? WHERE id = ?'
    )->execute([$label ?: null, $item['id']]);

    json_ok(['success' => true, 'label' => $label ?: null]);
}


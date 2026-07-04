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
                'SELECT id, status, current_dept_id, current_barrio_id, current_artist_id
                 FROM equipment_items WHERE qr_code = ? FOR UPDATE'
            );
            $stmt->execute([$qr]);
            $item = $stmt->fetch();

            if (!$item) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_found'];
                continue;
            }

            if ($item['status'] === 'checked-out' && !$force) {
                $loc = _item_location_label($pdo, $item);
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'already_checked_out', 'location' => $loc];
                continue;
            }

            if (!in_array($item['status'], ['available', 'checked-out'], true)) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_available'];
                continue;
            }

            $pdo->prepare(
                'UPDATE equipment_items
                 SET status = "checked-out", current_dept_id = ?, dept_label = ?,
                     current_barrio_id = NULL, current_artist_id = NULL
                 WHERE id = ?'
            )->execute([$dept_id, $dept_label ?: null, $item['id']]);

            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, dept_id, performed_by, user_name_cache, occurred_at)
                 VALUES ("checkout", ?, ?, ?, ?, ?)'
            )->execute([$item['id'], $dept_id, $user['id'], $user['display_name'], $now]);

            $results[] = ['qr' => $qr, 'success' => true];
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['results' => $results]);
}

// Department lending equipment to a barrio or artist
function handle_sub_checkout(): void {
    require_method('POST');
    $user = require_permission('sub_checkout');
    verify_csrf();

    $b                   = body();
    $dept_id             = (int)($b['dept_id'] ?? 0);
    $barrio_id           = isset($b['barrio_id'])  ? (int)$b['barrio_id']  : null;
    $artist_id           = isset($b['artist_id'])  ? (int)$b['artist_id']  : null;
    $item_qrs            = $b['item_qrs'] ?? [];
    $force               = !empty($b['force']);
    $dept_label          = isset($b['dept_label']) ? trim($b['dept_label']) : null;
    $latitude            = isset($b['latitude'])   ? (float)$b['latitude']  : null;
    $longitude           = isset($b['longitude'])  ? (float)$b['longitude'] : null;
    $apply_barrio_location = array_key_exists('apply_barrio_location', $b)
        ? !empty($b['apply_barrio_location']) : true;

    $production = has_permission('checkout_equipment');

    if (!$dept_id && !$production) {
        json_error('dept_id required');
    }
    if ((!$barrio_id && !$artist_id) || empty($item_qrs) || !is_array($item_qrs)) {
        json_error('one of barrio_id/artist_id, and item_qrs required');
    }

    if (!$production) {
        require_dept_access($dept_id);
    }

    // If no explicit GPS was captured, fall back to the barrio's storage location —
    // but only when it's unambiguous (exactly one location on file for that barrio).
    $barrio_location_applied = false;
    if ($barrio_id && $apply_barrio_location && $latitude === null && $longitude === null) {
        $loc = get_barrio_location(db(), $barrio_id);
        if ($loc) {
            $latitude  = $loc['latitude'];
            $longitude = $loc['longitude'];
            $barrio_location_applied = true;
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
                'SELECT id, status, current_dept_id, current_barrio_id, current_artist_id
                 FROM equipment_items WHERE qr_code = ? FOR UPDATE'
            );
            $stmt->execute([$qr]);
            $item = $stmt->fetch();

            if (!$item) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_found'];
                continue;
            }

            // Use item's current dept if already assigned, otherwise use the user's dept
            $effective_dept_id = (int)$item['current_dept_id'] ?: $dept_id;

            if (($item['current_barrio_id'] || $item['current_artist_id']) && !$force) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'already_sub_lent'];
                continue;
            }

            $pdo->prepare(
                'UPDATE equipment_items
                 SET status = "checked-out",
                     current_dept_id = COALESCE(current_dept_id, ?),
                     current_barrio_id = ?, current_artist_id = ?, dept_label = COALESCE(?, dept_label),
                     latitude  = COALESCE(?, latitude),
                     longitude = COALESCE(?, longitude)
                 WHERE id = ?'
            )->execute([$effective_dept_id ?: null, $barrio_id, $artist_id, $dept_label ?: null, $latitude, $longitude, $item['id']]);

            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, dept_id, barrio_id, artist_id,
                                           performed_by, user_name_cache, occurred_at)
                 VALUES ("sub_checkout", ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $item['id'], $effective_dept_id ?: null, $barrio_id, $artist_id,
                $user['id'], $user['display_name'], $now,
            ]);

            $results[] = ['qr' => $qr, 'success' => true];
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok([
        'results'                 => $results,
        'barrio_location_applied' => $barrio_location_applied,
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
        'SELECT i.id, i.status, i.current_dept_id, i.current_barrio_id, i.current_artist_id, i.current_person_id,
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

    $dept_id      = $item['current_dept_id']    ? (int)$item['current_dept_id']    : null;
    $barrio_id    = $item['current_barrio_id']  ? (int)$item['current_barrio_id']  : null;
    $artist_id    = $item['current_artist_id']  ? (int)$item['current_artist_id']  : null;
    $person_id    = $item['current_person_id']  ? (int)$item['current_person_id']  : null;

    // Sub-lent = in dept pool then further lent to barrio/artist/person
    $is_sub_lent  = (bool)($barrio_id || $artist_id || ($person_id && $dept_id));
    // Person-from-production = no dept, just person
    $is_person_prod = $person_id && !$dept_id;

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
            $pdo->prepare(
                'UPDATE equipment_items
                 SET status = "available", current_person_id = NULL, dept_label = NULL,
                     current_location_id = ?
                 WHERE id = ?'
            )->execute([$location_id, $item['id']]);

            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, person_id, location_id, performed_by, user_name_cache, occurred_at)
                 VALUES ("person_checkin", ?, ?, ?, ?, ?, NOW())'
            )->execute([$item['id'], $person_id, $location_id, $user['id'], $user['display_name']]);

        } elseif ($is_sub_lent) {
            $pdo->prepare(
                'UPDATE equipment_items
                 SET current_barrio_id = NULL, current_artist_id = NULL, current_person_id = NULL,
                     current_location_id = ?
                 WHERE id = ?'
            )->execute([$location_id, $item['id']]);

            $tx_type = $person_id ? 'person_checkin' : 'sub_checkin';
            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, dept_id, barrio_id, artist_id, person_id,
                                           location_id, performed_by, user_name_cache, occurred_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())'
            )->execute([
                $tx_type, $item['id'], $dept_id, $barrio_id, $artist_id, $person_id,
                $location_id, $user['id'], $user['display_name'],
            ]);

        } else {
            $pdo->prepare(
                'UPDATE equipment_items
                 SET status = "available", current_dept_id = NULL, dept_label = NULL,
                     current_barrio_id = NULL, current_artist_id = NULL, current_person_id = NULL,
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
        require_permission('person_borrow');
        $is_self_checkout = true;
    } else {
        require_permission('checkout_equipment');
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
                'SELECT id, status, current_dept_id, current_barrio_id, current_artist_id, current_person_id
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
                              'location' => _item_location_label($pdo, $item)];
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

            $pdo->prepare(
                'UPDATE equipment_items
                 SET status = "checked-out", current_person_id = ?, dept_label = ?,
                     current_dept_id = NULL, current_barrio_id = NULL, current_artist_id = NULL
                 WHERE id = ?'
            )->execute([(int)$person['id'], $dept_label ?: null, $item['id']]);

            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, person_id, performed_by, user_name_cache, occurred_at)
                 VALUES ("person_checkout", ?, ?, ?, ?, ?)'
            )->execute([$item['id'], (int)$person['id'], $user['id'], $user['display_name'], $now]);

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
                'SELECT id, status, current_dept_id, current_barrio_id, current_artist_id, current_person_id
                 FROM equipment_items WHERE qr_code = ? FOR UPDATE'
            );
            $stmt->execute([$qr]);
            $item = $stmt->fetch();

            if (!$item) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_found'];
                continue;
            }
            if (($item['current_barrio_id'] || $item['current_artist_id'] || $item['current_person_id']) && !$force) {
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

            $pdo->prepare(
                'UPDATE equipment_items
                 SET status = "checked-out",
                     current_dept_id = COALESCE(current_dept_id, ?),
                     current_person_id = ?, dept_label = COALESCE(?, dept_label),
                     current_barrio_id = NULL, current_artist_id = NULL
                 WHERE id = ?'
            )->execute([$dept_id ?: null, (int)$person['id'], $dept_label ?: null, $item['id']]);

            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, dept_id, person_id, performed_by, user_name_cache, occurred_at)
                 VALUES ("person_checkout", ?, ?, ?, ?, ?, ?)'
            )->execute([$item['id'], $dept_id, (int)$person['id'], $user['id'], $user['display_name'], $now]);

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
        'SELECT id, current_dept_id FROM equipment_items WHERE qr_code = ? AND status = "checked-out"'
    );
    $stmt->execute([$item_qr]);
    $item = $stmt->fetch();

    if (!$item) json_error('Item not found or not checked out', 404);

    // Verify dept access for non-production users
    if (!has_permission('checkout_equipment') && $item['current_dept_id']) {
        require_dept_access((int)$item['current_dept_id']);
    }

    db()->prepare(
        'UPDATE equipment_items SET dept_label = ? WHERE id = ?'
    )->execute([$label ?: null, $item['id']]);

    json_ok(['success' => true, 'label' => $label ?: null]);
}

function handle_used(): void {
    require_method('POST');
    $user = require_permission('validate_vouchers');
    verify_csrf();

    $b       = body();
    $item_qr = trim($b['item_qr'] ?? '');

    if ($item_qr === '') json_error('item_qr required');

    $stmt = db()->prepare(
        'SELECT i.id, i.status, i.current_barrio_id, i.current_dept_id, t.secure_qr
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$item_qr]);
    $item = $stmt->fetch();

    if (!$item) json_error('Item not found', 404);
    if (!$item['secure_qr']) json_error('Not a secure QR item', 409);
    if ($item['status'] !== 'activated') {
        json_ok(['success' => false, 'error' => 'not_activated']);
        return;
    }

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $pdo->prepare(
            'UPDATE equipment_items SET status = "used", current_barrio_id = NULL WHERE id = ?'
        )->execute([$item['id']]);

        $pdo->prepare(
            'INSERT INTO transactions (type, item_id, dept_id, barrio_id, performed_by, user_name_cache, occurred_at)
             VALUES ("used", ?, ?, ?, ?, ?, NOW())'
        )->execute([
            $item['id'], $item['current_dept_id'], $item['current_barrio_id'],
            $user['id'], $user['display_name'],
        ]);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['success' => true]);
}

function handle_fill_confirm(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b        = body();
    $item_qrs = $b['item_qrs'] ?? [];
    $flagged  = !empty($b['flagged']);
    $notes    = isset($b['notes']) ? trim((string)$b['notes']) : null;

    if (empty($item_qrs) || !is_array($item_qrs)) {
        json_error('item_qrs required');
    }

    $type = $flagged ? 'fill_flagged' : 'fill_confirmed';
    $now  = date('Y-m-d H:i:s');
    $pdo  = db();
    $pdo->beginTransaction();

    try {
        foreach ($item_qrs as $qr) {
            $qr   = (string)$qr;
            $stmt = $pdo->prepare(
                'SELECT i.id, i.status, i.current_barrio_id, i.current_dept_id, t.secure_qr
                 FROM equipment_items i
                 JOIN equipment_types t ON t.id = i.equipment_type_id
                 WHERE i.qr_code = ?'
            );
            $stmt->execute([$qr]);
            $item = $stmt->fetch();

            if (!$item || !$item['secure_qr'] || $item['status'] !== 'used') continue;

            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, dept_id, barrio_id, performed_by, user_name_cache, occurred_at, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                $type, $item['id'], $item['current_dept_id'], $item['current_barrio_id'],
                $user['id'], $user['display_name'], $now, $notes ?: null,
            ]);
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['success' => true, 'confirmed' => count($item_qrs), 'flagged' => $flagged]);
}

function handle_activate(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b       = body();
    $item_qr = trim($b['item_qr'] ?? '');

    if ($item_qr === '') json_error('item_qr required');

    $stmt = db()->prepare(
        'SELECT i.id, i.status, i.current_barrio_id, i.current_dept_id, t.secure_qr,
                CONCAT(t.name, " #", i.item_number) AS display_name,
                b.name AS barrio_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN barrios b ON b.id = i.current_barrio_id
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$item_qr]);
    $item = $stmt->fetch();

    if (!$item) json_error('Item not found', 404);
    if (!$item['secure_qr']) json_error('Not a voucher', 409);

    if ($item['status'] === 'activated') {
        json_ok(['success' => false, 'error' => 'already_activated',
                 'name' => $item['display_name'], 'barrio' => $item['barrio_name']]);
        return;
    }
    if ($item['status'] !== 'checked-out') {
        json_ok(['success' => false, 'error' => 'not_checked_out', 'name' => $item['display_name']]);
        return;
    }

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $pdo->prepare(
            'UPDATE equipment_items SET status = "activated" WHERE id = ?'
        )->execute([$item['id']]);

        $pdo->prepare(
            'INSERT INTO transactions (type, item_id, dept_id, barrio_id, performed_by, user_name_cache, occurred_at)
             VALUES ("activated", ?, ?, ?, ?, ?, NOW())'
        )->execute([
            $item['id'], $item['current_dept_id'], $item['current_barrio_id'],
            $user['id'], $user['display_name'],
        ]);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['success' => true, 'name' => $item['display_name'], 'barrio' => $item['barrio_name']]);
}

// Helper: build human-readable current location label for an item
function _item_location_label(object $pdo, array $item): string {
    if (!empty($item['current_person_id'])) {
        $r_stmt = $pdo->prepare('SELECT display_name FROM users WHERE id = ?');
        $r_stmt->execute([$item['current_person_id']]);
        $r = $r_stmt->fetch();
        return $r ? $r['display_name'] : 'unknown person';
    }
    if (!empty($item['current_barrio_id'])) {
        $r_stmt = $pdo->prepare('SELECT name FROM barrios WHERE id = ?');
        $r_stmt->execute([$item['current_barrio_id']]);
        $r = $r_stmt->fetch();
        return $r ? $r['name'] : 'unknown barrio';
    }
    if (!empty($item['current_artist_id'])) {
        $r_stmt = $pdo->prepare('SELECT name FROM artists WHERE id = ?');
        $r_stmt->execute([$item['current_artist_id']]);
        $r = $r_stmt->fetch();
        return $r ? $r['name'] : 'unknown artist';
    }
    if (!empty($item['current_dept_id'])) {
        $r_stmt = $pdo->prepare('SELECT name FROM departments WHERE id = ?');
        $r_stmt->execute([$item['current_dept_id']]);
        $r = $r_stmt->fetch();
        return $r ? $r['name'] : 'unknown dept';
    }
    return 'unknown';
}

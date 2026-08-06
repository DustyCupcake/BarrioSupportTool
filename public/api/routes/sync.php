<?php
declare(strict_types=1);

/**
 * Replay offline-queued requests. Each event is the original {method, path,
 * body} the client tried to send while offline (see offline.js's enqueue()),
 * not a bespoke summary — this endpoint dispatches to the same per-tier
 * logic the live /checkout, /sub-checkout, /person-checkout,
 * /sub-person-checkout, and /checkin endpoints use (via the shared
 * assign_item_holder()/set_item_holder()/insert_holder_transaction()
 * helpers in lib/holder.php), so an offline batch gets the same tier support
 * and multi-item handling as an online one.
 */
function handle_sync(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b      = body();
    $events = $b['events'] ?? [];

    if (!is_array($events) || empty($events)) {
        json_error('events array required');
    }

    $processed = 0;
    $rejected  = [];
    $pdo       = db();

    foreach ($events as $ev) {
        $client_id   = (string)($ev['client_id'] ?? '');
        $path        = (string)($ev['path'] ?? '');
        $evBody      = is_array($ev['body'] ?? null) ? $ev['body'] : [];
        $occurred_at = $ev['occurred_at'] ?? null;

        $dt = $occurred_at ? DateTime::createFromFormat('Y-m-d\TH:i:s', substr((string)$occurred_at, 0, 19)) : false;
        if (!$dt) {
            $rejected[] = ['client_id' => $client_id, 'reason' => 'invalid_date'];
            continue;
        }
        $occurred_str = $dt->format('Y-m-d H:i:s');

        if (!in_array($path, ['/checkout', '/sub-checkout', '/person-checkout', '/sub-person-checkout', '/checkin'], true)) {
            $rejected[] = ['client_id' => $client_id, 'reason' => 'unsupported_path'];
            continue;
        }

        $pdo->beginTransaction();
        try {
            switch ($path) {
                case '/checkout':
                    $n = _sync_checkout($pdo, $user, $evBody, $occurred_str);
                    break;
                case '/sub-checkout':
                    $n = _sync_sub_checkout($pdo, $user, $evBody, $occurred_str);
                    break;
                case '/person-checkout':
                    $n = _sync_person_checkout($pdo, $user, $evBody, $occurred_str);
                    break;
                case '/sub-person-checkout':
                    $n = _sync_sub_person_checkout($pdo, $user, $evBody, $occurred_str);
                    break;
                case '/checkin':
                    $n = _sync_checkin($pdo, $user, $evBody, $occurred_str);
                    break;
            }
            if ($n > 0) {
                $pdo->commit();
                $processed++;
            } else {
                $pdo->rollBack();
                $rejected[] = ['client_id' => $client_id, 'reason' => 'no_items_applied'];
            }
        } catch (Throwable $e) {
            $pdo->rollBack();
            $rejected[] = ['client_id' => $client_id, 'reason' => 'db_error'];
        }
    }

    json_ok(['processed' => $processed, 'rejected' => $rejected]);
}

// Each _sync_* helper applies one queued request and returns how many items
// were actually updated (0 means reject the whole event — e.g. no permission
// or nothing resolvable). Offline entries are best-effort catch-up for scans
// that already physically happened, so — matching the pre-existing sync
// behavior — these don't re-check "is it already checked out" the way the
// live endpoints do with $force; they just apply the recorded state.

function _sync_checkout(PDO $pdo, array $user, array $b, string $occurred): int {
    if (!in_array('checkout_equipment', $user['permissions'], true)) return 0;
    $dept_id = (int)($b['dept_id'] ?? 0);
    $qrs     = is_array($b['item_qrs'] ?? null) ? $b['item_qrs'] : [];
    if (!$dept_id || !$qrs) return 0;
    $label = isset($b['dept_label']) ? trim((string)$b['dept_label']) : null;

    $n = 0;
    foreach ($qrs as $qr) {
        $item = _sync_find_item($pdo, (string)$qr);
        if (!$item) continue;
        assign_item_holder($pdo, (int)$item['id'], 'department', $dept_id, $dept_id, false, $label ?: null, false);
        insert_holder_transaction($pdo, 'checkout', (int)$item['id'], $dept_id, 'department', $dept_id,
            (int)$user['id'], $user['display_name'], $occurred, true);
        $n++;
    }
    return $n;
}

function _sync_sub_checkout(PDO $pdo, array $user, array $b, string $occurred): int {
    if (!in_array('sub_checkout', $user['permissions'], true)) return 0;
    $dept_id  = (int)($b['dept_id'] ?? 0);
    $group_id = isset($b['group_id']) ? (int)$b['group_id'] : (isset($b['barrio_id']) ? (int)$b['barrio_id'] : 0);
    $qrs      = is_array($b['item_qrs'] ?? null) ? $b['item_qrs'] : [];
    if (!$group_id || !$qrs) return 0;
    $label     = isset($b['dept_label']) ? trim((string)$b['dept_label']) : null;
    $latitude  = isset($b['latitude'])  ? (float)$b['latitude']  : null;
    $longitude = isset($b['longitude']) ? (float)$b['longitude'] : null;

    $n = 0;
    foreach ($qrs as $qr) {
        $item = _sync_find_item($pdo, (string)$qr);
        if (!$item) continue;
        $effective_dept_id = (int)$item['owning_dept_id'] ?: $dept_id;
        assign_item_holder($pdo, (int)$item['id'], 'group', $group_id,
            $effective_dept_id ?: null, true, $label ?: null, true, $latitude, $longitude);
        insert_holder_transaction($pdo, 'sub_checkout', (int)$item['id'], $effective_dept_id ?: null,
            'group', $group_id, (int)$user['id'], $user['display_name'], $occurred, true);
        $n++;
    }
    return $n;
}

function _sync_person_checkout(PDO $pdo, array $user, array $b, string $occurred): int {
    $canStaff = in_array('checkout_equipment', $user['permissions'], true);
    $canSelf  = in_array('person_borrow', $user['permissions'], true);
    if (!$canStaff && !$canSelf) return 0;

    $person_qr = trim((string)($b['person_qr'] ?? ''));
    $qrs       = is_array($b['item_qrs'] ?? null) ? $b['item_qrs'] : [];
    if ($person_qr === '' || !$qrs) return 0;
    $label = isset($b['dept_label']) ? trim((string)$b['dept_label']) : null;

    $pstmt = $pdo->prepare('SELECT id FROM users WHERE qr_token = ? AND is_active = 1');
    $pstmt->execute([$person_qr]);
    $person_id = $pstmt->fetchColumn();
    if (!$person_id) return 0;
    $person_id = (int)$person_id;

    $n = 0;
    foreach ($qrs as $qr) {
        $item = _sync_find_item($pdo, (string)$qr);
        if (!$item) continue;
        assign_item_holder($pdo, (int)$item['id'], 'person', $person_id, null, false, $label ?: null, false);
        insert_holder_transaction($pdo, 'person_checkout', (int)$item['id'], null, 'person', $person_id,
            (int)$user['id'], $user['display_name'], $occurred, true);
        $n++;
    }
    return $n;
}

function _sync_sub_person_checkout(PDO $pdo, array $user, array $b, string $occurred): int {
    if (!in_array('sub_checkout', $user['permissions'], true)) return 0;
    $dept_id   = (int)($b['dept_id'] ?? 0);
    $person_qr = trim((string)($b['person_qr'] ?? ''));
    $qrs       = is_array($b['item_qrs'] ?? null) ? $b['item_qrs'] : [];
    if (!$dept_id || $person_qr === '' || !$qrs) return 0;
    $label = isset($b['dept_label']) ? trim((string)$b['dept_label']) : null;

    $pstmt = $pdo->prepare('SELECT id FROM users WHERE qr_token = ? AND is_active = 1');
    $pstmt->execute([$person_qr]);
    $person_id = $pstmt->fetchColumn();
    if (!$person_id) return 0;
    $person_id = (int)$person_id;

    $n = 0;
    foreach ($qrs as $qr) {
        $item = _sync_find_item($pdo, (string)$qr);
        if (!$item) continue;
        assign_item_holder($pdo, (int)$item['id'], 'person', $person_id, $dept_id ?: null, true, $label ?: null, true);
        insert_holder_transaction($pdo, 'person_checkout', (int)$item['id'], $dept_id, 'person', $person_id,
            (int)$user['id'], $user['display_name'], $occurred, true);
        $n++;
    }
    return $n;
}

function _sync_checkin(PDO $pdo, array $user, array $b, string $occurred): int {
    $item_qr     = trim((string)($b['item_qr'] ?? ''));
    $location_qr = trim((string)($b['location_qr'] ?? ''));
    if ($item_qr === '') return 0;

    $item = _sync_find_item($pdo, $item_qr);
    if (!$item || !in_array($item['status'], ['checked-out', 'activated'], true)) return 0;

    $dept_id     = $item['owning_dept_id'] ? (int)$item['owning_dept_id'] : null;
    $holder_type = $item['holder_type'];
    $holder_id   = $item['holder_id'] ? (int)$item['holder_id'] : null;

    $is_sub_lent    = $holder_type === 'group' || ($holder_type === 'person' && $dept_id);
    $is_person_prod = $holder_type === 'person' && !$dept_id;

    if ($is_sub_lent || $is_person_prod) {
        if (!in_array('sub_checkin', $user['permissions'], true) && !in_array('checkin_equipment', $user['permissions'], true)) return 0;
    } else {
        if (!in_array('checkin_equipment', $user['permissions'], true)) return 0;
    }

    $location_id = null;
    if ($location_qr !== '') {
        $lstmt = $pdo->prepare('SELECT id FROM storage_locations WHERE qr_code = ?');
        $lstmt->execute([$location_qr]);
        $lid = $lstmt->fetchColumn();
        if ($lid) $location_id = (int)$lid;
    }

    if ($is_person_prod) {
        set_item_holder($pdo, (int)$item['id'], null, null, 'available', $location_id);
        $pdo->prepare('UPDATE equipment_items SET dept_label = NULL WHERE id = ?')->execute([$item['id']]);
        insert_holder_transaction($pdo, 'person_checkin', (int)$item['id'], null, 'person', $holder_id,
            (int)$user['id'], $user['display_name'], $occurred, true, $location_id);
    } elseif ($is_sub_lent) {
        if ($dept_id) {
            $pdo->prepare(
                'UPDATE equipment_items SET holder_type = "department", holder_id = owning_dept_id, current_location_id = COALESCE(?, current_location_id) WHERE id = ?'
            )->execute([$location_id, $item['id']]);
        } else {
            set_item_holder($pdo, (int)$item['id'], null, null, 'available', $location_id);
            $pdo->prepare('UPDATE equipment_items SET dept_label = NULL WHERE id = ?')->execute([$item['id']]);
        }
        $tx_type = $holder_type === 'person' ? 'person_checkin' : 'sub_checkin';
        insert_holder_transaction($pdo, $tx_type, (int)$item['id'], $dept_id, $holder_type, $holder_id,
            (int)$user['id'], $user['display_name'], $occurred, true, $location_id);
    } else {
        set_item_holder($pdo, (int)$item['id'], null, null, 'available', $location_id);
        $pdo->prepare('UPDATE equipment_items SET owning_dept_id = NULL, dept_label = NULL WHERE id = ?')->execute([$item['id']]);
        $pdo->prepare(
            'INSERT INTO transactions (type, item_id, dept_id, location_id, performed_by, user_name_cache, is_offline_entry, occurred_at)
             VALUES ("checkin", ?, ?, ?, ?, ?, 1, ?)'
        )->execute([$item['id'], $dept_id, $location_id, $user['id'], $user['display_name'], $occurred]);
    }

    return 1;
}

function _sync_find_item(PDO $pdo, string $qr): ?array {
    $stmt = $pdo->prepare(
        'SELECT id, status, owning_dept_id, holder_type, holder_id FROM equipment_items WHERE qr_code = ? FOR UPDATE'
    );
    $stmt->execute([$qr]);
    $row = $stmt->fetch();
    return $row ?: null;
}

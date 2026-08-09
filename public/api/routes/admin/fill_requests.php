<?php
declare(strict_types=1);

// Admin-facing fill-request endpoints — credit sales and the read-only
// status board (request history, flagged fills, pending sanitation). Split
// out of fill_requests.php. See also:
//   ../fill_requests.php      — core create/confirm/sanitize lifecycle
//   ../fill_run_claims.php    — direction-claims locking
//   admin/fill_route.php      — admin route ordering/GPS backfill

// ─── POST /admin/sell-fill-credits ────────────────────────────────────────────
// On-site credit purchase: staff logs payment and adds credits to entity.
function handle_sell_fill_credits(): void {
    require_method('POST');
    $user = require_auth();
    require_permission('manage_consumables');
    verify_csrf();

    $b              = body();
    $entity_id      = (int)($b['entity_id'] ?? 0);
    $quantity       = (int)($b['quantity']   ?? 0);
    $payment_method = trim($b['payment_method'] ?? '');
    $notes          = trim($b['notes'] ?? '');

    if (!$entity_id) json_error('entity_id required');
    if ($quantity < 1) json_error('quantity must be at least 1');

    $pdo = db();
    $stmt = $pdo->prepare('SELECT id, name FROM groups WHERE id = ?');
    $stmt->execute([$entity_id]);
    $group = $stmt->fetch();
    if (!$group) json_error('Group not found', 404);

    // Upsert entitlement — add to purchased count
    $pdo->prepare(
        "INSERT INTO group_entitlements (group_id, type_id, purchased, distributed)
         SELECT ?, ct.id, ?, 0 FROM consumable_types ct WHERE ct.key_name = 'water_fill'
         ON DUPLICATE KEY UPDATE purchased = purchased + VALUES(purchased)"
    )->execute([$entity_id, $quantity]);

    $full_notes = $payment_method
        ? "$quantity fill credit(s) sold — $payment_method" . ($notes ? ". $notes" : '')
        : "$quantity fill credit(s) added" . ($notes ? ". $notes" : '');

    // Log a distribution event for the audit trail
    $now = date('Y-m-d H:i:s');
    $pdo->prepare(
        "INSERT INTO distribution_events (group_id, type_id, quantity, performed_by, user_name_cache, occurred_at, notes)
         SELECT ?, ct.id, ?, ?, ?, ?, ?
         FROM consumable_types ct WHERE ct.key_name = 'water_fill'"
    )->execute([$entity_id, $quantity, $user['id'], $user['display_name'], $now, $full_notes]);

    $credits = get_fill_credits($pdo, $entity_id);
    json_ok([
        'success'           => true,
        'barrio_name'       => $group['name'],
        'group_name'        => $group['name'],
        'added'             => $quantity,
        'credits_purchased' => (int)$credits['purchased'],
        'credits_used'      => (int)$credits['distributed'],
    ]);
}

// ─── GET /admin/fill-requests ─────────────────────────────────────────────────
// Admin: list fill requests. status=active (default) → pending/partial only;
// status=all or a specific status → history browsing.
function handle_admin_list_fill_requests(): void {
    require_method('GET');
    require_auth();
    if (!has_permission('manage_groups') && !has_permission('view_fill_status')) {
        json_error('Forbidden', 403);
    }

    // status=active (default) → pending/partial only, oldest first, matching
    // this screen's original queue behavior. status=all or a specific status
    // (filled/cancelled/pending/partial) → history browsing, newest first.
    $status_filter  = trim($_GET['status'] ?? 'active');
    $valid_statuses = ['pending', 'partial', 'filled', 'cancelled'];
    $params         = [];

    if ($status_filter === 'active') {
        $where = "WHERE fr.status IN ('pending', 'partial')";
        $order = 'ASC';
    } elseif ($status_filter === 'all') {
        $where = '';
        $order = 'DESC';
    } elseif (in_array($status_filter, $valid_statuses, true)) {
        $where    = 'WHERE fr.status = ?';
        $params[] = $status_filter;
        $order    = 'DESC';
    } else {
        json_error('Invalid status filter', 400);
    }

    $stmt = db()->prepare(
        "SELECT fr.id, fr.group_id AS entity_id, g.name AS barrio_name,
                fr.cube_item_id,
                CASE WHEN fr.cube_item_id IS NOT NULL
                     THEN CONCAT(t.name, ' #', i.item_number) ELSE NULL END AS cube_label,
                fr.fills_requested, fr.fills_completed, fr.status,
                fr.requested_at, u.display_name AS requested_by_name,
                fr.via_physical_voucher
         FROM fill_requests fr
         JOIN groups g          ON g.id = fr.group_id
         LEFT JOIN equipment_items i ON i.id = fr.cube_item_id
         LEFT JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN users u           ON u.id = fr.requested_by
         $where
         ORDER BY fr.requested_at $order
         LIMIT 200"
    );
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) {
        $r['id']                    = (int)$r['id'];
        $r['entity_id']             = (int)$r['entity_id'];
        $r['cube_item_id']          = $r['cube_item_id'] !== null ? (int)$r['cube_item_id'] : null;
        $r['fills_requested']       = (int)$r['fills_requested'];
        $r['fills_completed']       = (int)$r['fills_completed'];
        $r['via_physical_voucher']  = (bool)$r['via_physical_voucher'];
    }
    unset($r);

    json_ok(['requests' => $rows]);
}

// ─── GET /admin/fill-flags ────────────────────────────────────────────────────
// Read-only: recent flagged sanitation events. fill_flagged transactions are
// written by handle_sanitize() but were previously never surfaced in any UI —
// part of the fill-status board for production/barrio-support/water-team.
function handle_admin_list_flagged_fills(): void {
    require_method('GET');
    require_auth();
    if (!has_permission('manage_groups') && !has_permission('view_fill_status')) {
        json_error('Forbidden', 403);
    }

    $stmt = db()->prepare(
        "SELECT tx.id, tx.item_id, tx.occurred_at, tx.notes,
                tx.user_name_cache AS flagged_by_name,
                CONCAT(t.name, ' #', i.item_number) AS cube_label,
                g.id AS group_id, g.name AS group_name
         FROM transactions tx
         JOIN equipment_items i ON i.id = tx.item_id
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN groups g     ON g.id = tx.holder_id AND tx.holder_type = 'group'
         WHERE tx.type = 'fill_flagged'
         ORDER BY tx.occurred_at DESC
         LIMIT 100"
    );
    $stmt->execute();
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) {
        $r['id']       = (int)$r['id'];
        $r['item_id']  = (int)$r['item_id'];
        $r['group_id'] = $r['group_id'] !== null ? (int)$r['group_id'] : null;
    }
    unset($r);

    json_ok(['flags' => $rows]);
}

// ─── GET /admin/fill-pending-sanitation ───────────────────────────────────────
// Read-only: water cubes whose most recent fill-related transaction is
// fill_delivered — i.e. water was poured but sanitation hasn't been confirmed
// (or flagged) yet. Same derivation handle_cube_status() does per-cube,
// aggregated across every cube instead of one at a time. No new tracking —
// entirely reads over transactions that already exist.
function handle_admin_pending_sanitation(): void {
    require_method('GET');
    require_auth();
    if (!has_permission('manage_groups') && !has_permission('view_fill_status')) {
        json_error('Forbidden', 403);
    }

    $stmt = db()->prepare(
        "SELECT i.id AS cube_id, i.qr_code AS cube_qr,
                CONCAT(t.name, ' #', i.item_number) AS cube_label,
                g.id AS group_id, g.name AS group_name,
                tx.occurred_at AS delivered_at
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id AND t.category = 'water_cube'
         LEFT JOIN groups g     ON g.id = i.holder_id AND i.holder_type = 'group'
         JOIN transactions tx   ON tx.id = (
             SELECT tx2.id FROM transactions tx2
             WHERE tx2.item_id = i.id
               AND tx2.type IN ('fill_confirmed','fill_adhoc','fill_delivered','fill_flagged')
             ORDER BY tx2.occurred_at DESC, tx2.id DESC
             LIMIT 1
         )
         WHERE tx.type = 'fill_delivered'
         ORDER BY tx.occurred_at ASC"
    );
    $stmt->execute();
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) {
        $r['cube_id']  = (int)$r['cube_id'];
        $r['group_id'] = $r['group_id'] !== null ? (int)$r['group_id'] : null;
    }
    unset($r);

    json_ok(['pending_sanitation' => $rows]);
}

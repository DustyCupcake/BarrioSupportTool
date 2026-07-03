<?php
declare(strict_types=1);

// ─── POST /fill-requests ──────────────────────────────────────────────────────
// Create a fill request. Two modes:
//   Barrio entity-level: body { entity_id, fills_requested } or { entity_qr, fills_requested }
//   NWP cube-specific:   body { cube_qr }
function handle_create_fill_request(): void {
    require_method('POST');
    $user = require_auth();
    require_permission('request_fills');
    verify_csrf();

    $b              = body();
    $fills_requested = max(1, (int)($b['fills_requested'] ?? 1));
    $cube_qr        = isset($b['cube_qr'])    ? trim((string)$b['cube_qr'])    : null;
    $entity_qr      = isset($b['entity_qr'])  ? trim((string)$b['entity_qr'])  : null;
    $entity_id      = isset($b['entity_id'])  ? (int)$b['entity_id']           : null;
    $pdo            = db();

    // ── Resolve entity and cube ──────────────────────────────────────────────
    $cube_item_id = null;

    if ($cube_qr !== null) {
        // NWP cube-specific mode: look up cube → derive entity
        $stmt = $pdo->prepare(
            'SELECT i.id, i.current_barrio_id, i.route_position, t.category
             FROM equipment_items i
             JOIN equipment_types t ON t.id = i.equipment_type_id
             WHERE i.qr_code = ? AND i.status = \'checked-out\''
        );
        $stmt->execute([$cube_qr]);
        $cube = $stmt->fetch();

        if (!$cube) json_error('Cube not found or not checked out', 404);
        if ($cube['category'] !== 'water_cube') json_error('Not a water cube', 409);
        if (!$cube['current_barrio_id']) json_error('Cube not assigned to an entity', 409);

        $cube_item_id   = (int)$cube['id'];
        $entity_id      = (int)$cube['current_barrio_id'];
        $fills_requested = 1;

    } elseif ($entity_qr !== null) {
        // Barrio entity-level via QR
        $stmt = $pdo->prepare('SELECT id FROM barrios WHERE qr_code = ?');
        $stmt->execute([$entity_qr]);
        $barrio = $stmt->fetch();
        if (!$barrio) json_error('Barrio QR not found', 404);
        $entity_id = (int)$barrio['id'];

    } elseif ($entity_id !== null) {
        // Barrio entity-level via direct ID (noinfo name lookup)
        $stmt = $pdo->prepare('SELECT id FROM barrios WHERE id = ?');
        $stmt->execute([$entity_id]);
        if (!$stmt->fetch()) json_error('Barrio not found', 404);

    } elseif (!empty($_SESSION['barrio_id'])) {
        // Barrio-scoped shift session — use the session's barrio automatically
        $entity_id = (int)$_SESSION['barrio_id'];
        $stmt = $pdo->prepare('SELECT id FROM barrios WHERE id = ?');
        $stmt->execute([$entity_id]);
        if (!$stmt->fetch()) json_error('Session barrio not found', 404);

    } else {
        json_error('entity_id, entity_qr, or cube_qr required');
    }

    // ── Check for existing active request ────────────────────────────────────
    if ($cube_item_id !== null) {
        // Cube-specific: no active request for this cube
        $stmt = $pdo->prepare(
            "SELECT id FROM fill_requests
             WHERE cube_item_id = ? AND status IN ('pending','partial')"
        );
        $stmt->execute([$cube_item_id]);
        if ($stmt->fetch()) json_error('A fill request already exists for this cube', 409);
    } else {
        // Entity-level: no active request for this entity
        $stmt = $pdo->prepare(
            "SELECT id FROM fill_requests
             WHERE entity_type = 'barrio' AND entity_id = ? AND cube_item_id IS NULL
             AND status IN ('pending','partial')"
        );
        $stmt->execute([$entity_id]);
        if ($stmt->fetch()) json_error('A fill request already exists for this barrio', 409);
    }

    // ── Check fill credits ───────────────────────────────────────────────────
    $credits = _get_fill_credits($pdo, $entity_id);
    $pending = _get_pending_fills($pdo, $entity_id);
    $available = $credits['purchased'] - $credits['distributed'] - $pending;

    if ($available < $fills_requested) {
        json_error('Insufficient fill credits (' . max(0, $available) . ' available)', 422);
    }

    // ── Create the request ───────────────────────────────────────────────────
    $now  = date('Y-m-d H:i:s');
    $stmt = $pdo->prepare(
        'INSERT INTO fill_requests
            (entity_type, entity_id, cube_item_id, fills_requested, requested_at, requested_by)
         VALUES (\'barrio\', ?, ?, ?, ?, ?)'
    );
    $stmt->execute([$entity_id, $cube_item_id, $fills_requested, $now, $user['id']]);
    $request_id = (int)$pdo->lastInsertId();

    // Audit transaction — use the cube item if specific, else pick the first cube from the barrio
    $audit_item_id = $cube_item_id ?? _first_cube_item_id($pdo, $entity_id);
    if ($audit_item_id) {
        $pdo->prepare(
            'INSERT INTO transactions (type, item_id, barrio_id, performed_by, user_name_cache, occurred_at)
             VALUES (\'fill_requested\', ?, ?, ?, ?, ?)'
        )->execute([$audit_item_id, $entity_id, $user['id'], $user['display_name'], $now]);
    }

    json_ok(['success' => true, 'fill_request_id' => $request_id]);
}

// ─── DELETE /fill-requests/:id ────────────────────────────────────────────────
function handle_cancel_fill_request(): void {
    require_method('DELETE');
    $user = require_auth();
    require_permission('request_fills');
    verify_csrf();

    $id  = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('id required', 400);

    $pdo  = db();
    $stmt = $pdo->prepare("SELECT * FROM fill_requests WHERE id = ?");
    $stmt->execute([$id]);
    $fr = $stmt->fetch();

    if (!$fr) json_error('Fill request not found', 404);
    if (!in_array($fr['status'], ['pending', 'partial'], true)) {
        json_error('Cannot cancel a request with status: ' . $fr['status'], 409);
    }

    $now = date('Y-m-d H:i:s');
    $pdo->prepare("UPDATE fill_requests SET status = 'cancelled' WHERE id = ?")
        ->execute([$id]);
    $audit_item_id = $fr['cube_item_id'] ?? _first_cube_item_id($pdo, (int)$fr['entity_id']);
    if ($audit_item_id) {
        $pdo->prepare(
            'INSERT INTO transactions (type, item_id, barrio_id, performed_by, user_name_cache, occurred_at)
             VALUES (\'fill_cancelled\', ?, ?, ?, ?, ?)'
        )->execute([$audit_item_id, $fr['entity_id'], $user['id'], $user['display_name'], $now]);
    }

    json_ok(['success' => true]);
}

// ─── GET /fill-route ──────────────────────────────────────────────────────────
// Returns the ordered route list for the truck crew.
// direction=asc (default) or desc for reverse route.
function handle_fill_route(): void {
    require_method('GET');
    require_auth();
    require_permission('fill_truck');

    $dir = strtolower($_GET['direction'] ?? 'asc') === 'desc' ? 'DESC' : 'ASC';
    $pdo = db();

    // Cube-specific requests (NWP): one row per cube
    $sql_specific = "
        SELECT
            fr.id AS fill_request_id,
            i.id  AS cube_id,
            i.qr_code AS cube_qr,
            i.route_position,
            i.latitude, i.longitude,
            CONCAT(t.name, ' #', i.item_number) AS cube_label,
            fr.entity_type, fr.entity_id,
            b.name AS entity_name,
            (fr.fills_requested - fr.fills_completed) AS fills_remaining,
            fr.fills_requested,
            fr.fills_completed,
            1 AS is_cube_specific,
            (SELECT MAX(tx.occurred_at) FROM transactions tx
             WHERE tx.item_id = i.id AND tx.type IN ('fill_confirmed','fill_adhoc')) AS last_filled_at
        FROM fill_requests fr
        JOIN equipment_items i  ON i.id = fr.cube_item_id
        JOIN equipment_types t  ON t.id = i.equipment_type_id
        JOIN barrios b          ON b.id = fr.entity_id
        WHERE fr.status IN ('pending','partial')
          AND fr.cube_item_id IS NOT NULL
          AND (fr.fills_requested - fr.fills_completed) > 0
          AND i.route_position IS NOT NULL
    ";

    // Entity-level requests (barrios): expand to individual cube rows
    $sql_entity = "
        SELECT
            fr.id AS fill_request_id,
            i.id  AS cube_id,
            i.qr_code AS cube_qr,
            i.route_position,
            i.latitude, i.longitude,
            CONCAT(t.name, ' #', i.item_number) AS cube_label,
            fr.entity_type, fr.entity_id,
            b.name AS entity_name,
            (fr.fills_requested - fr.fills_completed) AS fills_remaining,
            fr.fills_requested,
            fr.fills_completed,
            0 AS is_cube_specific,
            (SELECT MAX(tx.occurred_at) FROM transactions tx
             WHERE tx.item_id = i.id AND tx.type IN ('fill_confirmed','fill_adhoc')) AS last_filled_at
        FROM fill_requests fr
        JOIN equipment_items i  ON i.current_barrio_id = fr.entity_id
        JOIN equipment_types t  ON t.id = i.equipment_type_id AND t.category = 'water_cube'
        JOIN barrios b          ON b.id = fr.entity_id
        WHERE fr.status IN ('pending','partial')
          AND fr.cube_item_id IS NULL
          AND i.status = 'checked-out'
          AND i.route_position IS NOT NULL
    ";

    $stmt = $pdo->query(
        "($sql_specific) UNION ALL ($sql_entity) ORDER BY route_position $dir"
    );
    $rows = $stmt->fetchAll();

    // Cubes without their own coordinates fall back to their barrio's single
    // storage location (if unambiguous) — cached per barrio to avoid N+1 queries.
    $barrio_loc_cache = [];

    foreach ($rows as &$r) {
        $r['fill_request_id']  = (int)$r['fill_request_id'];
        $r['cube_id']          = (int)$r['cube_id'];
        $r['entity_id']        = (int)$r['entity_id'];
        $r['route_position']   = (int)$r['route_position'];
        $r['fills_remaining']  = (int)$r['fills_remaining'];
        $r['fills_requested']  = (int)$r['fills_requested'];
        $r['fills_completed']  = (int)$r['fills_completed'];
        $r['is_cube_specific'] = (bool)$r['is_cube_specific'];
        $r['latitude']         = $r['latitude']  !== null ? (float)$r['latitude']  : null;
        $r['longitude']        = $r['longitude'] !== null ? (float)$r['longitude'] : null;

        if ($r['latitude'] !== null && $r['longitude'] !== null) {
            $r['location_source'] = 'cube';
        } else {
            $bid = $r['entity_id'];
            if (!array_key_exists($bid, $barrio_loc_cache)) {
                $barrio_loc_cache[$bid] = _get_barrio_location($pdo, $bid);
            }
            $loc = $barrio_loc_cache[$bid];
            if ($loc) {
                $r['latitude']  = $loc['latitude'];
                $r['longitude'] = $loc['longitude'];
                $r['location_source'] = 'barrio';
            } else {
                $r['location_source'] = null;
            }
        }
    }
    unset($r);

    json_ok(['stops' => $rows]);
}

// ─── POST /fill/confirm ───────────────────────────────────────────────────────
// Truck scans a cube QR and confirms the fill.
function handle_confirm_fill(): void {
    require_method('POST');
    $user = require_auth();
    require_permission('fill_truck');
    verify_csrf();

    $b       = body();
    $cube_qr = trim($b['cube_qr'] ?? '');
    if ($cube_qr === '') json_error('cube_qr required');

    $pdo  = db();
    $stmt = $pdo->prepare(
        'SELECT i.id, i.current_barrio_id, i.route_position, t.category,
                CONCAT(t.name, \' #\', i.item_number) AS cube_label,
                b.name AS barrio_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN barrios b    ON b.id = i.current_barrio_id
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$cube_qr]);
    $cube = $stmt->fetch();

    if (!$cube) json_error('Cube not found', 404);
    if ($cube['category'] !== 'water_cube') json_error('Not a water cube', 409);
    if (!$cube['current_barrio_id']) json_error('Cube not assigned to any entity', 409);

    $cube_id   = (int)$cube['id'];
    $entity_id = (int)$cube['current_barrio_id'];

    // Find matching active fill request
    // Prefer cube-specific request; fall back to entity-level
    $fr = null;

    $stmt = $pdo->prepare(
        "SELECT * FROM fill_requests
         WHERE cube_item_id = ? AND status IN ('pending','partial')
         LIMIT 1"
    );
    $stmt->execute([$cube_id]);
    $fr = $stmt->fetch();

    if (!$fr) {
        $stmt = $pdo->prepare(
            "SELECT * FROM fill_requests
             WHERE entity_type = 'barrio' AND entity_id = ?
               AND cube_item_id IS NULL AND status IN ('pending','partial')
             LIMIT 1"
        );
        $stmt->execute([$entity_id]);
        $fr = $stmt->fetch();
    }

    if (!$fr) {
        json_error('No active fill request for this cube', 409);
    }

    $now          = date('Y-m-d H:i:s');
    $new_completed = (int)$fr['fills_completed'] + 1;
    $new_status    = $new_completed >= (int)$fr['fills_requested'] ? 'filled' : 'partial';

    $pdo->beginTransaction();
    try {
        $pdo->prepare(
            "UPDATE fill_requests
             SET fills_completed = ?, status = ?, filled_at = ?, filled_by = ?
             WHERE id = ?"
        )->execute([$new_completed, $new_status, $now, $user['id'], $fr['id']]);

        // Decrement fill credit (increment distributed)
        $pdo->prepare(
            "UPDATE barrio_entitlements be
             JOIN consumable_types ct ON ct.id = be.type_id AND ct.key_name = 'water_fill'
             SET be.distributed = be.distributed + 1
             WHERE be.barrio_id = ?"
        )->execute([$entity_id]);

        // Record delivery (sanitation confirmed separately via POST /fill/sanitize)
        $pdo->prepare(
            'INSERT INTO transactions (type, item_id, barrio_id, performed_by, user_name_cache, occurred_at)
             VALUES (\'fill_delivered\', ?, ?, ?, ?, ?)'
        )->execute([$cube_id, $entity_id, $user['id'], $user['display_name'], $now]);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok([
        'success'         => true,
        'cube_id'         => $cube_id,
        'cube_qr'         => $cube_qr,
        'cube_label'      => $cube['cube_label'],
        'entity_id'       => $entity_id,
        'entity_name'     => $cube['barrio_name'],
        'fills_remaining' => max(0, (int)$fr['fills_requested'] - $new_completed),
        'request_status'  => $new_status,
    ]);
}

// ─── POST /fill/sanitize ─────────────────────────────────────────────────────
// Batch-confirm (or flag) sanitation for a set of previously delivered cubes.
// Accepts cube_item_ids[] from the pending-sanitization list on the truck device.
function handle_sanitize(): void {
    require_method('POST');
    $user = require_auth();
    require_permission('fill_truck');
    verify_csrf();

    $b             = body();
    $cube_item_ids = $b['cube_item_ids'] ?? [];
    $flagged       = !empty($b['flagged']);
    $notes         = trim($b['notes'] ?? '');

    if (empty($cube_item_ids) || !is_array($cube_item_ids)) {
        json_error('cube_item_ids required');
    }

    $type = $flagged ? 'fill_flagged' : 'fill_confirmed';
    $now  = date('Y-m-d H:i:s');
    $pdo  = db();
    $pdo->beginTransaction();
    try {
        foreach ($cube_item_ids as $raw_id) {
            $item_id = (int)$raw_id;
            $stmt    = $pdo->prepare('SELECT current_barrio_id FROM equipment_items WHERE id = ?');
            $stmt->execute([$item_id]);
            $row       = $stmt->fetch();
            $barrio_id = $row ? (int)$row['current_barrio_id'] : null;

            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, barrio_id, performed_by, user_name_cache, occurred_at, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?)'
            )->execute([$type, $item_id, $barrio_id, $user['id'], $user['display_name'], $now, $notes ?: null]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['success' => true, 'type' => $type, 'confirmed' => count($cube_item_ids)]);
}

// ─── POST /fill/confirm-adhoc ─────────────────────────────────────────────────
// Truck confirms a fill without a digital request (sticker fallback).
function handle_confirm_adhoc_fill(): void {
    require_method('POST');
    $user = require_auth();
    require_permission('fill_truck');
    verify_csrf();

    $b       = body();
    $cube_qr = trim($b['cube_qr'] ?? '');
    $notes   = trim($b['notes']   ?? '');
    if ($cube_qr === '') json_error('cube_qr required');

    $pdo  = db();
    $stmt = $pdo->prepare(
        'SELECT i.id, i.current_barrio_id, t.category,
                CONCAT(t.name, \' #\', i.item_number) AS cube_label,
                b.name AS barrio_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN barrios b    ON b.id = i.current_barrio_id
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$cube_qr]);
    $cube = $stmt->fetch();

    if (!$cube) json_error('Cube not found', 404);
    if ($cube['category'] !== 'water_cube') json_error('Not a water cube', 409);

    $cube_id   = (int)$cube['id'];
    $entity_id = $cube['current_barrio_id'] ? (int)$cube['current_barrio_id'] : null;

    $now = date('Y-m-d H:i:s');
    $pdo->beginTransaction();
    try {
        if ($entity_id) {
            // Decrement credit if available (don't block if 0)
            $pdo->prepare(
                "UPDATE barrio_entitlements be
                 JOIN consumable_types ct ON ct.id = be.type_id AND ct.key_name = 'water_fill'
                 SET be.distributed = be.distributed + 1
                 WHERE be.barrio_id = ? AND (be.purchased - be.distributed) > 0"
            )->execute([$entity_id]);
        }

        $pdo->prepare(
            'INSERT INTO transactions (type, item_id, barrio_id, performed_by, user_name_cache, occurred_at, notes)
             VALUES (\'fill_adhoc\', ?, ?, ?, ?, ?, ?)'
        )->execute([$cube_id, $entity_id, $user['id'], $user['display_name'], $now, $notes ?: null]);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok([
        'success'     => true,
        'cube_label'  => $cube['cube_label'],
        'entity_name' => $cube['barrio_name'],
    ]);
}

// ─── GET /water/cube-status ───────────────────────────────────────────────────
// Public: returns status of a water cube by QR code.
function handle_cube_status(): void {
    require_method('GET');
    // No auth required

    $qr = trim($_GET['qr'] ?? '');
    if ($qr === '') json_error('qr required', 400);

    $pdo  = db();
    $stmt = $pdo->prepare(
        'SELECT i.id, i.route_position, i.latitude, i.longitude, t.category,
                CONCAT(t.name, \' #\', i.item_number) AS cube_label,
                b.name AS entity_name, b.id AS entity_id
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN barrios b    ON b.id = i.current_barrio_id
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$qr]);
    $cube = $stmt->fetch();

    if (!$cube || $cube['category'] !== 'water_cube') {
        json_ok(['status' => 'not_found']);
        return;
    }

    $cube_id   = (int)$cube['id'];
    $entity_id = $cube['entity_id'] ? (int)$cube['entity_id'] : null;

    // Effective location: the cube's own override if set, else the barrio's
    // single storage location (if unambiguous), else none.
    $latitude = $cube['latitude']  !== null ? (float)$cube['latitude']  : null;
    $longitude = $cube['longitude'] !== null ? (float)$cube['longitude'] : null;
    $location_source = null;
    if ($latitude !== null && $longitude !== null) {
        $location_source = 'cube';
    } elseif ($entity_id) {
        $barrio_loc = _get_barrio_location($pdo, $entity_id);
        if ($barrio_loc) {
            $latitude  = $barrio_loc['latitude'];
            $longitude = $barrio_loc['longitude'];
            $location_source = 'barrio';
        }
    }

    // Most recent fill-related transaction (determines current state)
    $stmt = $pdo->prepare(
        "SELECT type, occurred_at
         FROM transactions
         WHERE item_id = ? AND type IN ('fill_confirmed','fill_adhoc','fill_delivered')
         ORDER BY occurred_at DESC
         LIMIT 1"
    );
    $stmt->execute([$cube_id]);
    $last_fill_row = $stmt->fetch();

    $fill_state      = null;  // null | 'delivered' | 'sanitized'
    $last_filled_at  = null;
    $last_sanitized_at = null;

    if ($last_fill_row) {
        if (in_array($last_fill_row['type'], ['fill_confirmed', 'fill_adhoc'])) {
            $fill_state        = 'sanitized';
            $last_sanitized_at = $last_fill_row['occurred_at'];
            $last_filled_at    = $last_fill_row['occurred_at'];
        } else {
            $fill_state     = 'delivered';
            $last_filled_at = $last_fill_row['occurred_at'];
        }
    }

    // Active fill request?
    $fill_requested = false;
    $fills_remaining = null;
    if ($entity_id) {
        $stmt = $pdo->prepare(
            "SELECT (fills_requested - fills_completed) AS remaining
             FROM fill_requests
             WHERE (cube_item_id = ? OR (cube_item_id IS NULL AND entity_type = 'barrio' AND entity_id = ?))
               AND status IN ('pending','partial')
             ORDER BY cube_item_id IS NULL ASC
             LIMIT 1"
        );
        $stmt->execute([$cube_id, $entity_id]);
        $fr_row = $stmt->fetch();
        if ($fr_row) {
            $fill_requested  = true;
            $fills_remaining = (int)$fr_row['remaining'];
        }
    }

    // Credits
    $credits = $entity_id ? _get_fill_credits($pdo, $entity_id) : null;
    $credits_remaining = $credits
        ? max(0, $credits['purchased'] - $credits['distributed'] - _get_pending_fills($pdo, $entity_id))
        : 0;

    json_ok([
        'status'            => 'found',
        'cube_label'        => $cube['cube_label'],
        'entity_name'       => $cube['entity_name'],
        'route_position'    => $cube['route_position'] ? (int)$cube['route_position'] : null,
        'fill_state'        => $fill_state,           // null | 'delivered' | 'sanitized'
        'last_filled_at'    => $last_filled_at,        // most recent delivery or sanitation
        'last_sanitized_at' => $last_sanitized_at,     // only set when sanitized
        'fill_requested'    => $fill_requested,
        'fills_remaining'   => $fills_remaining,
        'credits_remaining' => $credits_remaining,
        'latitude'          => $latitude,
        'longitude'         => $longitude,
        'location_source'   => $location_source,   // null | 'cube' | 'barrio'
    ]);
}

// ─── GET /barrios/:id/cubes ───────────────────────────────────────────────────
// Returns cubes checked out to a barrio with fill credit summary.
// Used by the noinfo fill request UI.
function handle_barrio_cubes(): void {
    require_method('GET');
    require_auth();
    require_permission('request_fills');

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('id required', 400);

    $pdo = db();

    $stmt = $pdo->prepare('SELECT id, name FROM barrios WHERE id = ?');
    $stmt->execute([$id]);
    $barrio = $stmt->fetch();
    if (!$barrio) json_error('Barrio not found', 404);

    // Cubes checked out to this barrio
    $stmt = $pdo->prepare(
        'SELECT i.id, i.qr_code, i.route_position,
                CONCAT(t.name, \' #\', i.item_number) AS cube_label,
                (SELECT MAX(tx.occurred_at) FROM transactions tx
                 WHERE tx.item_id = i.id AND tx.type IN (\'fill_confirmed\',\'fill_adhoc\')) AS last_filled_at,
                (SELECT COUNT(*) FROM fill_requests fr
                 WHERE fr.cube_item_id = i.id AND fr.status IN (\'pending\',\'partial\')) AS has_request
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id AND t.category = \'water_cube\'
         WHERE i.current_barrio_id = ? AND i.status = \'checked-out\'
         ORDER BY i.route_position IS NULL, i.route_position, i.item_number'
    );
    $stmt->execute([$id]);
    $cubes = $stmt->fetchAll();

    foreach ($cubes as &$c) {
        $c['id']            = (int)$c['id'];
        $c['route_position'] = $c['route_position'] !== null ? (int)$c['route_position'] : null;
        $c['has_request']   = (bool)$c['has_request'];
    }
    unset($c);

    // Fill credits
    $credits  = _get_fill_credits($pdo, $id);
    $pending  = _get_pending_fills($pdo, $id);

    // Active entity-level fill request
    $stmt = $pdo->prepare(
        "SELECT id, fills_requested, fills_completed, status
         FROM fill_requests
         WHERE entity_type = 'barrio' AND entity_id = ? AND cube_item_id IS NULL
           AND status IN ('pending','partial')
         LIMIT 1"
    );
    $stmt->execute([$id]);
    $active_fr = $stmt->fetch() ?: null;
    if ($active_fr) {
        $active_fr['id']              = (int)$active_fr['id'];
        $active_fr['fills_requested'] = (int)$active_fr['fills_requested'];
        $active_fr['fills_completed'] = (int)$active_fr['fills_completed'];
    }

    json_ok([
        'barrio'            => ['id' => (int)$barrio['id'], 'name' => $barrio['name']],
        'cubes'             => $cubes,
        'credits_purchased' => (int)$credits['purchased'],
        'credits_used'      => (int)$credits['distributed'],
        'credits_pending'   => $pending,
        'credits_available' => max(0, $credits['purchased'] - $credits['distributed'] - $pending),
        'active_request'    => $active_fr,
    ]);
}

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
    $stmt = $pdo->prepare('SELECT id, name FROM barrios WHERE id = ?');
    $stmt->execute([$entity_id]);
    $barrio = $stmt->fetch();
    if (!$barrio) json_error('Barrio not found', 404);

    // Upsert entitlement — add to purchased count
    $pdo->prepare(
        "INSERT INTO barrio_entitlements (barrio_id, type_id, purchased, distributed)
         SELECT ?, ct.id, ?, 0 FROM consumable_types ct WHERE ct.key_name = 'water_fill'
         ON DUPLICATE KEY UPDATE purchased = purchased + VALUES(purchased)"
    )->execute([$entity_id, $quantity]);

    $full_notes = $payment_method
        ? "$quantity fill credit(s) sold — $payment_method" . ($notes ? ". $notes" : '')
        : "$quantity fill credit(s) added" . ($notes ? ". $notes" : '');

    // Log a distribution event for the audit trail
    $now = date('Y-m-d H:i:s');
    $pdo->prepare(
        "INSERT INTO distribution_events (barrio_id, type_id, quantity, performed_by, user_name_cache, occurred_at, notes)
         SELECT ?, ct.id, ?, ?, ?, ?, ?
         FROM consumable_types ct WHERE ct.key_name = 'water_fill'"
    )->execute([$entity_id, $quantity, $user['id'], $user['display_name'], $now, $full_notes]);

    $credits = _get_fill_credits($pdo, $entity_id);
    json_ok([
        'success'           => true,
        'barrio_name'       => $barrio['name'],
        'added'             => $quantity,
        'credits_purchased' => (int)$credits['purchased'],
        'credits_used'      => (int)$credits['distributed'],
    ]);
}

// ─── GET /fill/direction-status ──────────────────────────────────────────────
// Returns which directions are currently claimed by active fill truck sessions.
// Claims older than 12 h are considered stale and ignored.
function handle_direction_status(): void {
    require_method('GET');
    require_auth();
    require_permission('fill_truck');

    $stmt = db()->prepare(
        "SELECT direction, user_name, claimed_at
         FROM fill_run_claims
         WHERE released = 0
           AND claimed_at > DATE_SUB(NOW(), INTERVAL 12 HOUR)
         ORDER BY claimed_at ASC"
    );
    $stmt->execute();
    $claims = $stmt->fetchAll();

    json_ok(['claims' => $claims]);
}

// ─── POST /fill/claim-direction ───────────────────────────────────────────────
// Claim a route direction for this shift session.
function handle_claim_direction(): void {
    require_method('POST');
    $user = require_auth();
    require_permission('fill_truck');
    verify_csrf();

    $b         = body();
    $direction = in_array($b['direction'] ?? '', ['asc', 'desc'], true)
        ? $b['direction'] : null;
    if (!$direction) json_error('direction must be asc or desc');

    $pdo = db();

    // Check if this direction is already claimed by another active session
    $stmt = $pdo->prepare(
        "SELECT id, user_name FROM fill_run_claims
         WHERE direction = ? AND released = 0
           AND claimed_at > DATE_SUB(NOW(), INTERVAL 12 HOUR)
         LIMIT 1"
    );
    $stmt->execute([$direction]);
    $existing = $stmt->fetch();

    if ($existing) {
        json_error(
            'Direction already claimed by ' . ($existing['user_name'] ?? 'another shift'),
            409
        );
    }

    $display  = $user['display_name'] ?? 'Fill crew';
    $user_id  = isset($user['id']) ? (int)$user['id'] : null;
    $now      = date('Y-m-d H:i:s');

    $pdo->prepare(
        'INSERT INTO fill_run_claims (direction, user_name, user_id, claimed_at)
         VALUES (?, ?, ?, ?)'
    )->execute([$direction, $display, $user_id, $now]);

    $claim_id = (int)$pdo->lastInsertId();

    json_ok(['success' => true, 'direction' => $direction, 'claim_id' => $claim_id]);
}

// ─── POST /fill/release-direction ────────────────────────────────────────────
// Release a claimed direction (end of run or logout).
function handle_release_direction(): void {
    require_method('POST');
    require_auth();
    require_permission('fill_truck');
    verify_csrf();

    $b        = body();
    $claim_id = (int)($b['claim_id'] ?? 0);
    if (!$claim_id) json_error('claim_id required');

    $now = date('Y-m-d H:i:s');
    db()->prepare(
        "UPDATE fill_run_claims SET released = 1, released_at = ? WHERE id = ? AND released = 0"
    )->execute([$now, $claim_id]);

    json_ok(['success' => true]);
}

// ─── GET /admin/fill-route/cubes ─────────────────────────────────────────────
// Admin: list all water cube items for route ordering.
function handle_admin_fill_route_cubes(): void {
    require_method('GET');
    require_auth();
    if (!has_permission('manage_barrios') && !has_permission('manage_equipment')) {
        json_error('Forbidden', 403);
    }

    $stmt = db()->prepare(
        "SELECT i.id, i.qr_code, i.route_position, i.status, i.latitude, i.longitude,
                CONCAT(t.name, ' #', i.item_number) AS cube_label,
                b.id AS barrio_id, b.name AS barrio_name,
                (SELECT MAX(tx.occurred_at) FROM transactions tx
                 WHERE tx.item_id = i.id AND tx.type IN ('fill_confirmed','fill_adhoc')) AS last_filled_at
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id AND t.category = 'water_cube'
         LEFT JOIN barrios b    ON b.id = i.current_barrio_id
         ORDER BY i.route_position IS NULL, i.route_position, i.id"
    );
    $stmt->execute();
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) {
        $r['id']             = (int)$r['id'];
        $r['route_position'] = $r['route_position'] !== null ? (int)$r['route_position'] : null;
        $r['barrio_id']      = $r['barrio_id'] ? (int)$r['barrio_id'] : null;
        $r['latitude']       = $r['latitude']  !== null ? (float)$r['latitude']  : null;
        $r['longitude']      = $r['longitude'] !== null ? (float)$r['longitude'] : null;
    }
    unset($r);

    json_ok(['cubes' => $rows]);
}

// ─── PUT /admin/fill-route/order ─────────────────────────────────────────────
// Admin: save the complete route order as an ordered array of cube IDs.
// The array index + 1 becomes the route_position.
function handle_admin_save_fill_route(): void {
    require_method('PUT');
    require_auth();
    if (!has_permission('manage_barrios') && !has_permission('manage_equipment')) {
        json_error('Forbidden', 403);
    }
    verify_csrf();

    $b       = body();
    $ordered = $b['ordered_ids'] ?? [];   // array of item IDs in desired route order
    $unset   = $b['unset_ids']   ?? [];   // array of item IDs to remove from route

    if (!is_array($ordered)) json_error('ordered_ids must be an array');

    $pdo = db();
    $pdo->beginTransaction();
    try {
        foreach ($ordered as $position => $item_id) {
            $pdo->prepare(
                'UPDATE equipment_items SET route_position = ? WHERE id = ?'
            )->execute([$position + 1, (int)$item_id]);
        }
        foreach ($unset as $item_id) {
            $pdo->prepare(
                'UPDATE equipment_items SET route_position = NULL WHERE id = ?'
            )->execute([(int)$item_id]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['success' => true, 'saved' => count($ordered)]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _get_fill_credits(\PDO $pdo, int $barrio_id): array {
    $stmt = $pdo->prepare(
        "SELECT be.purchased, be.distributed
         FROM barrio_entitlements be
         JOIN consumable_types ct ON ct.id = be.type_id AND ct.key_name = 'water_fill'
         WHERE be.barrio_id = ?"
    );
    $stmt->execute([$barrio_id]);
    $row = $stmt->fetch();
    return $row ? ['purchased' => (int)$row['purchased'], 'distributed' => (int)$row['distributed']]
                : ['purchased' => 0, 'distributed' => 0];
}

function _get_pending_fills(\PDO $pdo, int $entity_id): int {
    $stmt = $pdo->prepare(
        "SELECT COALESCE(SUM(fills_requested - fills_completed), 0) AS pending
         FROM fill_requests
         WHERE entity_type = 'barrio' AND entity_id = ? AND status IN ('pending','partial')"
    );
    $stmt->execute([$entity_id]);
    return (int)$stmt->fetchColumn();
}

// A barrio's default location: only used when the barrio has exactly one
// storage_location with coordinates set — otherwise it's ambiguous, so no default.
function _get_barrio_location(\PDO $pdo, int $barrio_id): ?array {
    $stmt = $pdo->prepare(
        'SELECT latitude, longitude FROM storage_locations
         WHERE barrio_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    $stmt->execute([$barrio_id]);
    $rows = $stmt->fetchAll();
    if (count($rows) !== 1) return null;
    return ['latitude' => (float)$rows[0]['latitude'], 'longitude' => (float)$rows[0]['longitude']];
}

function _first_cube_item_id(\PDO $pdo, int $barrio_id): ?int {
    $stmt = $pdo->prepare(
        "SELECT i.id FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id AND t.category = 'water_cube'
         WHERE i.current_barrio_id = ? AND i.status = 'checked-out'
         ORDER BY i.route_position IS NULL, i.route_position
         LIMIT 1"
    );
    $stmt->execute([$barrio_id]);
    $id = $stmt->fetchColumn();
    return $id !== false ? (int)$id : null;
}

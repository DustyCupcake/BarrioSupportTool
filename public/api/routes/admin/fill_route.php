<?php
declare(strict_types=1);

// Admin route management for the water-fill truck run — split out of
// fill_requests.php. See also:
//   ../fill_requests.php   — core fill lifecycle (handle_fill_route serves
//                             the truck's own ordered stop list at runtime)
//   admin/fill_requests.php — credit sales, admin request/status board

// ─── GET /admin/fill-route/cubes ─────────────────────────────────────────────
// Admin: list all water cube items for route ordering.
function handle_admin_fill_route_cubes(): void {
    require_method('GET');
    require_auth();
    if (!has_permission('manage_groups') && !has_permission('manage_equipment')) {
        json_error('Forbidden', 403);
    }

    $stmt = db()->prepare(
        "SELECT i.id, i.qr_code, i.route_position, i.status, i.latitude, i.longitude,
                CONCAT(t.name, ' #', i.item_number) AS cube_label,
                g.id AS barrio_id, g.name AS barrio_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id AND t.category = 'water_cube'
         LEFT JOIN groups g     ON g.id = i.holder_id AND i.holder_type = 'group'
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
    if (!has_permission('manage_groups') && !has_permission('manage_equipment')) {
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

// ─── POST /admin/fill-route/apply-barrio-locations ───────────────────────────
// Admin: backfill GPS coordinates on water cubes that are already checked out
// to a group but have no coordinates yet, using that group's storage location
// (only when the group has exactly one — same rule the checkout flow uses).
// Never overwrites a cube that already has coordinates.
function handle_admin_apply_barrio_locations(): void {
    require_method('POST');
    require_auth();
    if (!has_permission('manage_groups') && !has_permission('manage_equipment')) {
        json_error('Forbidden', 403);
    }
    verify_csrf();

    $pdo = db();

    $stmt = $pdo->prepare(
        "SELECT i.id, i.holder_id
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id AND t.category = 'water_cube'
         WHERE i.holder_type = 'group' AND i.holder_id IS NOT NULL AND i.latitude IS NULL"
    );
    $stmt->execute();
    $cubes = $stmt->fetchAll();

    $applied         = 0;
    $skipped         = 0;
    $group_loc_cache = []; // group_id -> location array | null, via get_group_location()

    foreach ($cubes as $cube) {
        $group_id = (int)$cube['holder_id'];

        if (!array_key_exists($group_id, $group_loc_cache)) {
            $group_loc_cache[$group_id] = get_group_location($pdo, $group_id);
        }

        $loc = $group_loc_cache[$group_id];
        if ($loc === null) { $skipped++; continue; }

        $pdo->prepare('UPDATE equipment_items SET latitude = ?, longitude = ? WHERE id = ?')
            ->execute([$loc['latitude'], $loc['longitude'], $cube['id']]);
        $applied++;
    }

    json_ok([
        'applied'    => $applied,
        'skipped'    => $skipped,
        'candidates' => count($cubes),
    ]);
}

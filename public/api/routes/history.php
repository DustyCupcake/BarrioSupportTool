<?php
declare(strict_types=1);

function handle_history(): void {
    require_method('GET');
    require_auth();

    $limit  = min((int)($_GET['limit'] ?? 100), 500);
    $offset = max((int)($_GET['offset'] ?? 0), 0);
    $type   = $_GET['type'] ?? null;
    $bid    = (int)($_GET['barrio_id'] ?? 0);

    // Determine which sources to include
    $include_equip = !$type || in_array($type, ['checkout', 'checkin'], true);
    $include_dist  = !$type || $type === 'distribute';

    $parts        = [];
    $count_params = [];
    $data_params  = [];

    if ($include_equip) {
        $equip_where  = [];
        $equip_params = [];
        if (in_array($type, ['checkout', 'checkin'], true)) {
            $equip_where[]  = 't.type = ?';
            $equip_params[] = $type;
        }
        if ($bid > 0) {
            $equip_where[]  = 't.barrio_id = ?';
            $equip_params[] = $bid;
        }
        $ew = $equip_where ? 'WHERE ' . implode(' AND ', $equip_where) : '';

        $parts[]      = "SELECT t.id, t.type, t.is_offline_entry, t.occurred_at, t.notes,
                CONCAT(et.name, ' #', i.item_number) AS item_name,
                i.qr_code AS item_qr,
                b.name AS barrio_name,
                t.user_name_cache AS performed_by_name,
                NULL AS quantity
         FROM transactions t
         JOIN equipment_items i  ON i.id = t.item_id
         JOIN equipment_types et ON et.id = i.equipment_type_id
         LEFT JOIN barrios b     ON b.id = t.barrio_id
         $ew";
        $count_params = array_merge($count_params, $equip_params);
        $data_params  = array_merge($data_params,  $equip_params);
    }

    if ($include_dist) {
        $dist_where  = [];
        $dist_params = [];
        if ($bid > 0) {
            $dist_where[]  = 'd.barrio_id = ?';
            $dist_params[] = $bid;
        }
        $dw = $dist_where ? 'WHERE ' . implode(' AND ', $dist_where) : '';

        $parts[]      = "SELECT d.id, 'distribute' AS type, 0 AS is_offline_entry,
                d.occurred_at, d.notes,
                ct.name AS item_name,
                NULL AS item_qr,
                b.name AS barrio_name,
                d.user_name_cache AS performed_by_name,
                d.quantity
         FROM distribution_events d
         JOIN consumable_types ct ON ct.id = d.type_id
         JOIN barrios b           ON b.id  = d.barrio_id
         $dw";
        $count_params = array_merge($count_params, $dist_params);
        $data_params  = array_merge($data_params,  $dist_params);
    }

    if (!$parts) {
        json_ok(['total' => 0, 'log' => []]);
        return;
    }

    $union = implode(' UNION ALL ', $parts);

    $countStmt = db()->prepare("SELECT COUNT(*) FROM ($union) AS combined");
    $countStmt->execute($count_params);
    $total = (int)$countStmt->fetchColumn();

    $stmt = db()->prepare(
        "SELECT * FROM ($union) AS combined
         ORDER BY occurred_at DESC
         LIMIT ? OFFSET ?"
    );
    $stmt->execute(array_merge($data_params, [$limit, $offset]));
    $rows = $stmt->fetchAll();

    foreach ($rows as &$row) {
        $row['id']               = (int)$row['id'];
        $row['is_offline_entry'] = (bool)$row['is_offline_entry'];
        if ($row['quantity'] !== null) $row['quantity'] = (int)$row['quantity'];
    }
    unset($row);

    json_ok(['total' => $total, 'log' => $rows]);
}

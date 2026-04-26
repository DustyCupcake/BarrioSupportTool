<?php
declare(strict_types=1);

function handle_history(): void {
    require_method('GET');
    require_auth();

    $limit  = min((int)($_GET['limit'] ?? 100), 500);
    $offset = max((int)($_GET['offset'] ?? 0), 0);
    $type   = $_GET['type'] ?? null;
    $bid    = (int)($_GET['barrio_id'] ?? 0);

    $where  = [];
    $params = [];

    if (in_array($type, ['checkout', 'checkin'], true)) {
        $where[]  = 't.type = ?';
        $params[] = $type;
    }
    if ($bid > 0) {
        $where[]  = 't.barrio_id = ?';
        $params[] = $bid;
    }

    $whereSQL = $where ? 'WHERE ' . implode(' AND ', $where) : '';

    $countStmt = db()->prepare("SELECT COUNT(*) FROM transactions t $whereSQL");
    $countStmt->execute($params);
    $total = (int)$countStmt->fetchColumn();

    $stmt = db()->prepare(
        "SELECT t.id, t.type, t.is_offline_entry, t.occurred_at, t.notes,
                CONCAT(et.name, ' #', i.item_number) AS item_name,
                i.qr_code AS item_qr,
                b.name AS barrio_name,
                t.user_name_cache AS performed_by_name
         FROM transactions t
         JOIN equipment_items i  ON i.id = t.item_id
         JOIN equipment_types et ON et.id = i.equipment_type_id
         LEFT JOIN barrios b     ON b.id = t.barrio_id
         $whereSQL
         ORDER BY t.occurred_at DESC
         LIMIT ? OFFSET ?"
    );
    $stmt->execute(array_merge($params, [$limit, $offset]));
    $rows = $stmt->fetchAll();

    foreach ($rows as &$row) {
        $row['id']               = (int)$row['id'];
        $row['is_offline_entry'] = (bool)$row['is_offline_entry'];
    }
    unset($row);

    json_ok(['total' => $total, 'log' => $rows]);
}

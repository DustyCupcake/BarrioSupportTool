<?php
declare(strict_types=1);

function handle_lookup(): void {
    require_method('GET');
    require_auth();

    $qr = trim($_GET['qr'] ?? '');
    if ($qr === '') json_error('qr parameter required');

    $stmt = db()->prepare(
        'SELECT i.id, i.qr_code, i.status, i.notes,
                t.name AS type_name, t.category,
                b.id AS barrio_id, b.name AS barrio_name,
                CONCAT(t.name, " #", i.item_number) AS display_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN barrios b ON b.id = i.current_barrio_id
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$qr]);
    $item = $stmt->fetch();

    if (!$item) json_error('Item not found', 404);

    json_ok([
        'id'           => (int)$item['id'],
        'qr_code'      => $item['qr_code'],
        'name'         => $item['display_name'],
        'category'     => $item['category'],
        'status'       => $item['status'],
        'current_barrio' => $item['barrio_id']
            ? ['id' => (int)$item['barrio_id'], 'name' => $item['barrio_name']]
            : null,
    ]);
}

function handle_inventory(): void {
    require_method('GET');
    require_auth();

    $status_filter = $_GET['status'] ?? null;
    $where = '';
    $params = [];
    if (in_array($status_filter, ['available', 'checked-out', 'retired'], true)) {
        $where = 'WHERE i.status = ?';
        $params[] = $status_filter;
    } else {
        $where = "WHERE i.status != 'retired'";
    }

    $rows = db()->prepare(
        "SELECT i.id, i.qr_code, i.status,
                CONCAT(t.name, ' #', i.item_number) AS name,
                t.category,
                b.name AS current_barrio
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN barrios b ON b.id = i.current_barrio_id
         $where
         ORDER BY t.name, i.item_number"
    );
    $rows->execute($params);
    $items = $rows->fetchAll();

    $available   = 0;
    $checked_out = 0;
    foreach ($items as $it) {
        if ($it['status'] === 'available')    $available++;
        if ($it['status'] === 'checked-out')  $checked_out++;
    }

    // Cast ids
    foreach ($items as &$it) {
        $it['id'] = (int)$it['id'];
    }
    unset($it);

    json_ok([
        'stats' => ['available' => $available, 'checked_out' => $checked_out],
        'items' => $items,
    ]);
}

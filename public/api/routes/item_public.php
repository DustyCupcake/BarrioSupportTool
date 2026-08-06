<?php
declare(strict_types=1);

/**
 * Public (no-auth) endpoint for basic item information.
 * Used by the /item landing page when someone scans an equipment QR code.
 * Returns only non-sensitive data: name, type, status label, and whether
 * it is a water voucher (so the page can redirect appropriately).
 */
function handle_item_info(): void {
    require_method('GET');

    $qr = trim($_GET['qr'] ?? '');
    if ($qr === '') {
        json_ok(['found' => false]);
        return;
    }

    $stmt = db()->prepare(
        'SELECT i.status, i.holder_type, i.holder_id, t.secure_qr, t.is_crate, t.deployment_destination,
                t.category,
                CONCAT(t.name, \' #\', i.item_number) AS display_name,
                t.name AS type_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$qr]);
    $item = $stmt->fetch();

    if (!$item) {
        json_ok(['found' => false]);
        return;
    }

    $status_label = match($item['status']) {
        'checked-out', 'activated', 'used' => 'out',
        'retired'                           => 'retired',
        default                             => 'available',
    };

    json_ok([
        'found'                  => true,
        'name'                   => $item['display_name'],
        'type_name'              => $item['type_name'],
        'category'               => $item['category'],
        'is_voucher'             => (bool) $item['secure_qr'],
        'is_crate'               => (bool) $item['is_crate'],
        'deployment_destination' => $item['deployment_destination'],
        'status'                 => $status_label,
        'current_group_id'       => ($item['holder_type'] === 'group' && $item['holder_id']) ? (int)$item['holder_id'] : null,
    ]);
}

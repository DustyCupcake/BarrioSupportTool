<?php
declare(strict_types=1);

function handle_list_locations(): void {
    require_method('GET');
    require_permission('manage_equipment');

    $rows = db()->query(
        'SELECT sl.id, sl.name, sl.description, sl.latitude, sl.longitude, sl.qr_code, sl.created_at,
                sl.barrio_id, b.name AS barrio_name,
                (SELECT COUNT(*) FROM equipment_items WHERE current_location_id = sl.id) AS item_count
         FROM storage_locations sl
         LEFT JOIN barrios b ON b.id = sl.barrio_id
         ORDER BY sl.name'
    )->fetchAll();

    foreach ($rows as &$r) {
        $r['id']         = (int)$r['id'];
        $r['item_count'] = (int)$r['item_count'];
        $r['latitude']   = $r['latitude']  !== null ? (float)$r['latitude']  : null;
        $r['longitude']  = $r['longitude'] !== null ? (float)$r['longitude'] : null;
        $r['barrio_id']  = $r['barrio_id'] !== null ? (int)$r['barrio_id']   : null;
    }
    unset($r);

    json_ok(['locations' => $rows]);
}

function handle_create_location(): void {
    require_method('POST');
    require_permission('manage_equipment');
    verify_csrf();

    $b           = body();
    $name        = trim($b['name'] ?? '');
    $description = trim($b['description'] ?? '');
    $latitude    = isset($b['latitude'])  && $b['latitude']  !== '' ? (float)$b['latitude']  : null;
    $longitude   = isset($b['longitude']) && $b['longitude'] !== '' ? (float)$b['longitude'] : null;
    $barrio_id   = isset($b['barrio_id']) && $b['barrio_id'] !== '' ? (int)$b['barrio_id']   : null;

    if ($name === '') json_error('name required');
    if ($barrio_id !== null) _require_barrio_exists($barrio_id);

    $qr_code = bin2hex(random_bytes(12));

    try {
        $stmt = db()->prepare(
            'INSERT INTO storage_locations (name, description, latitude, longitude, qr_code, barrio_id) VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$name, $description ?: null, $latitude, $longitude, $qr_code, $barrio_id]);
        $id = (int)db()->lastInsertId();
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name already exists', 409);
        throw $e;
    }

    json_ok(['id' => $id, 'name' => $name, 'description' => $description ?: null,
             'latitude' => $latitude, 'longitude' => $longitude, 'qr_code' => $qr_code,
             'barrio_id' => $barrio_id], 201);
}

function _require_barrio_exists(int $barrio_id): void {
    $stmt = db()->prepare('SELECT 1 FROM barrios WHERE id = ?');
    $stmt->execute([$barrio_id]);
    if (!$stmt->fetchColumn()) json_error('Barrio not found', 404);
}

function handle_update_location(): void {
    require_method('PUT');
    require_permission('manage_equipment');
    verify_csrf();

    $b           = body();
    $id          = (int)($b['id'] ?? $_GET['id'] ?? 0);
    $name        = trim($b['name'] ?? '');
    $description = trim($b['description'] ?? '');
    $latitude    = array_key_exists('latitude',  $b)
        ? ($b['latitude']  !== null && $b['latitude']  !== '' ? (float)$b['latitude']  : null)
        : 'unset';
    $longitude   = array_key_exists('longitude', $b)
        ? ($b['longitude'] !== null && $b['longitude'] !== '' ? (float)$b['longitude'] : null)
        : 'unset';
    $barrio_id   = array_key_exists('barrio_id', $b)
        ? ($b['barrio_id'] !== null && $b['barrio_id'] !== '' ? (int)$b['barrio_id'] : null)
        : 'unset';

    if (!$id || $name === '') json_error('id and name required');
    if ($barrio_id !== 'unset' && $barrio_id !== null) _require_barrio_exists($barrio_id);

    $sets   = ['name = ?', 'description = ?'];
    $params = [$name, $description ?: null];
    if ($latitude  !== 'unset') { $sets[] = 'latitude = ?';  $params[] = $latitude; }
    if ($longitude !== 'unset') { $sets[] = 'longitude = ?'; $params[] = $longitude; }
    if ($barrio_id !== 'unset') { $sets[] = 'barrio_id = ?'; $params[] = $barrio_id; }
    $params[] = $id;

    try {
        $stmt = db()->prepare('UPDATE storage_locations SET ' . implode(', ', $sets) . ' WHERE id = ?');
        $stmt->execute($params);
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'Duplicate')) json_error('Name already exists', 409);
        throw $e;
    }

    if ($stmt->rowCount() === 0) json_error('Location not found', 404);
    json_ok(['success' => true]);
}

function handle_delete_location(): void {
    require_method('DELETE');
    require_permission('manage_equipment');
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? $_GET['id'] ?? 0);
    if (!$id) json_error('id required');

    $stmt = db()->prepare('DELETE FROM storage_locations WHERE id = ?');
    $stmt->execute([$id]);

    if ($stmt->rowCount() === 0) json_error('Location not found', 404);
    json_ok(['success' => true]);
}

function handle_location_qr_sheet(): void {
    require_method('GET');
    require_permission('manage_equipment');

    $rows = db()->query(
        'SELECT id, name, description, qr_code FROM storage_locations ORDER BY name'
    )->fetchAll();

    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host   = $_SERVER['HTTP_HOST'];

    $use_lib = file_exists(__DIR__ . '/../../../assets/vendor/phpqrcode/qrlib.php');
    if ($use_lib) {
        require_once __DIR__ . '/../../../assets/vendor/phpqrcode/qrlib.php';
    }

    $cards = '';
    foreach ($rows as $loc) {
        $scan_url = $scheme . '://' . $host . '/scan?qr=' . rawurlencode($loc['qr_code']);

        if ($use_lib) {
            ob_start();
            QRcode::png($scan_url, false, QR_ECLEVEL_H, 6, 1);
            $png = ob_get_clean();
            $src = 'data:image/png;base64,' . base64_encode($png);
        } else {
            $src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' . urlencode($scan_url);
        }

        $name_esc = htmlspecialchars($loc['name'], ENT_QUOTES, 'UTF-8');
        $desc_esc = $loc['description'] ? htmlspecialchars($loc['description'], ENT_QUOTES, 'UTF-8') : '';

        $cards .= '<div class="loc-card">'
            . '<img class="loc-qr" src="' . $src . '" alt="QR for ' . $name_esc . '">'
            . '<div class="loc-name">' . $name_esc . '</div>'
            . ($desc_esc ? '<div class="loc-desc">' . $desc_esc . '</div>' : '')
            . '<div class="loc-code" style="font-family:monospace;font-size:10px;color:#999">' . htmlspecialchars($loc['qr_code'], ENT_QUOTES, 'UTF-8') . '</div>'
            . '</div>';
    }

    if (!$cards) {
        $cards = '<p style="text-align:center;color:#666">No storage locations defined yet.</p>';
    }

    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');

    echo '<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Storage Location QR Codes</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; background: #fff; }
.toolbar {
    display: flex; gap: 1rem; padding: 1rem;
    background: #f5f5f5; border-bottom: 1px solid #ddd; align-items: center;
}
.toolbar button {
    padding: .5rem 1.25rem; border: 1px solid #999; border-radius: 4px;
    background: #fff; cursor: pointer; font-size: .9rem;
}
.toolbar button:hover { background: #e8e8e8; }
.grid {
    display: flex; flex-wrap: wrap; gap: 1cm;
    padding: 1cm; justify-content: flex-start;
}
.loc-card {
    width: 6cm; border: 1px solid #ccc; border-radius: 4px;
    padding: .5cm; text-align: center; page-break-inside: avoid;
}
.loc-qr { width: 4.5cm; height: 4.5cm; display: block; margin: 0 auto .3cm; }
.loc-name { font-size: 13pt; font-weight: bold; margin-bottom: .2cm; word-break: break-word; }
.loc-desc { font-size: 9pt; color: #555; margin-bottom: .2cm; word-break: break-word; }
@media print { .toolbar { display: none; } .grid { padding: .5cm; } }
</style>
</head>
<body>
<div class="toolbar">
    <button onclick="window.print()">Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
</div>
<div class="grid">' . $cards . '</div>
</body>
</html>';
    exit;
}

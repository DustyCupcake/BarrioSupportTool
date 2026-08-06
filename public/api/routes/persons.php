<?php
declare(strict_types=1);

// Look up a person by their QR token — used during checkout scanning
function handle_person_info(): void {
    require_method('GET');
    require_auth();

    $qr = trim($_GET['qr'] ?? '');
    if ($qr === '') json_error('qr required', 400);

    $stmt = db()->prepare(
        'SELECT id, display_name, qr_token FROM users WHERE qr_token = ? AND is_active = 1'
    );
    $stmt->execute([$qr]);
    $person = $stmt->fetch();

    if (!$person) json_error('Person not found', 404);

    $stmt = db()->prepare(
        'SELECT ei.id, ei.qr_code, ei.dept_label,
                CONCAT(et.name, \' #\', ei.item_number) AS name,
                et.category
         FROM equipment_items ei
         JOIN equipment_types et ON et.id = ei.equipment_type_id
         WHERE ei.holder_type = \'person\' AND ei.holder_id = ?
         ORDER BY et.name, ei.item_number'
    );
    $stmt->execute([(int)$person['id']]);
    $items = $stmt->fetchAll();

    foreach ($items as &$it) $it['id'] = (int)$it['id'];
    unset($it);

    json_ok([
        'person'    => ['id' => (int)$person['id'], 'display_name' => $person['display_name']],
        'items_out' => $items,
    ]);
}

// Generates a themed QR as an inline SVG string.
// Uses QRencode::encode() to get the binary matrix directly (no GD/image needed),
// then emits <rect> elements in a viewBox-scaled SVG.
// $fg_hex / $bg_hex are 6-char hex strings without '#' (e.g. "1a1a18").
function qr_generate_svg(string $data, string $fg_hex = '1a1a18', string $bg_hex = 'ffffff'): string {
    // Returns array of strings, one per row; each char is '0' (light) or '1' (dark)
    $frame  = QRencode::factory(QR_ECLEVEL_H)->encode($data);
    $size   = count($frame);
    $margin = 4; // quiet-zone in modules
    $total  = $size + $margin * 2;

    $fg_safe = htmlspecialchars('#' . $fg_hex, ENT_QUOTES);
    $bg_safe = htmlspecialchars('#' . $bg_hex, ENT_QUOTES);

    $rects = '';
    foreach ($frame as $y => $row) {
        $len = strlen($row);
        for ($x = 0; $x < $len; $x++) {
            if ($row[$x] === '1') {
                $rx = $x + $margin;
                $ry = $y + $margin;
                $rects .= "<rect x=\"{$rx}\" y=\"{$ry}\" width=\"1\" height=\"1\"/>";
            }
        }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg"'
         . " viewBox=\"0 0 {$total} {$total}\""
         . ' shape-rendering="crispEdges">'
         . "<rect width=\"{$total}\" height=\"{$total}\" fill=\"{$bg_safe}\"/>"
         . "<g fill=\"{$fg_safe}\">{$rects}</g>"
         . '</svg>';
}

// Returns the QR as an inline SVG string in JSON for themed display.
// Accepts ?fg=1a1a18&bg=ffffff (hex without #) to match the caller's theme.
function handle_my_qr_img(): void {
    require_method('GET');
    $user = require_auth();

    $qr_token = $user['qr_token'] ?? null;
    if (!$qr_token) {
        $qr_token = ensure_user_qr_token((int)$user['id']);
    }

    $scheme   = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host     = $_SERVER['HTTP_HOST'];
    $scan_url = $scheme . '://' . $host . '/scan?qr=' . rawurlencode($qr_token);

    $use_lib = file_exists(__DIR__ . '/../../assets/vendor/phpqrcode/qrlib.php');
    if ($use_lib) {
        require_once __DIR__ . '/../../assets/vendor/phpqrcode/qrlib.php';
        // Sanitise caller-supplied hex colors (strip # and non-hex chars, fall back to safe defaults)
        $fg = preg_replace('/[^0-9a-fA-F]/', '', $_GET['fg'] ?? '1a1a18');
        $bg = preg_replace('/[^0-9a-fA-F]/', '', $_GET['bg'] ?? 'ffffff');
        if (strlen($fg) !== 6) $fg = '1a1a18';
        if (strlen($bg) !== 6) $bg = 'ffffff';

        $svg = qr_generate_svg($scan_url, $fg, $bg);
        json_ok(['svg' => $svg, 'name' => $user['display_name']]);
    } else {
        // Fallback: external PNG (no theming)
        $src = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=' . urlencode($scan_url);
        json_ok(['src' => $src, 'name' => $user['display_name']]);
    }
}

// Returns the authenticated user's own QR token as a printable page
function handle_my_qr(): void {
    require_method('GET');
    $user = require_auth();

    $qr_token = $user['qr_token'] ?? null;
    if (!$qr_token) {
        $qr_token = ensure_user_qr_token((int)$user['id']);
    }

    $scheme   = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host     = $_SERVER['HTTP_HOST'];
    $scan_url = $scheme . '://' . $host . '/scan?qr=' . rawurlencode($qr_token);

    $use_lib = file_exists(__DIR__ . '/../../assets/vendor/phpqrcode/qrlib.php');
    if ($use_lib) {
        require_once __DIR__ . '/../../assets/vendor/phpqrcode/qrlib.php';
        ob_start();
        QRcode::png($scan_url, false, QR_ECLEVEL_H, 10, 2);
        $png = ob_get_clean();
        $src = 'data:image/png;base64,' . base64_encode($png);
    } else {
        $src = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' . urlencode($scan_url);
    }

    $name_esc = htmlspecialchars($user['display_name'], ENT_QUOTES, 'UTF-8');
    $link_esc = htmlspecialchars($scan_url, ENT_QUOTES, 'UTF-8');

    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');

    echo '<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>My QR — ' . $name_esc . '</title>
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
.page {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: 3rem 2rem; gap: 1.25rem;
}
.person-name { font-size: 2rem; font-weight: bold; }
.person-label { font-size: 1rem; color: #555; }
.qr-img { width: 10cm; height: 10cm; display: block; }
.deep-link { font-size: 11pt; color: #555; font-family: monospace; word-break: break-all; text-align: center; }
@media print { .toolbar { display: none; } .page { padding: 1cm; } }
</style>
</head>
<body>
<div class="toolbar">
    <button onclick="window.print()">Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
</div>
<div class="page">
    <div class="person-name">' . $name_esc . '</div>
    <div class="person-label">Personal QR</div>
    <img class="qr-img" src="' . $src . '" alt="QR code for ' . $name_esc . '">
    <div class="deep-link">' . $link_esc . '</div>
</div>
</body>
</html>';
    exit;
}

// Returns equipment currently checked out to the authenticated user
function handle_my_items(): void {
    require_method('GET');
    $user = require_auth();

    if ($user['is_shift'] || !$user['id']) {
        json_ok(['items' => []]);
        return;
    }

    $stmt = db()->prepare(
        'SELECT ei.id, ei.qr_code, ei.dept_label, ei.current_location_id,
                CONCAT(et.name, " #", ei.item_number) AS name,
                et.category,
                sl.name AS location_name
         FROM equipment_items ei
         JOIN equipment_types et ON et.id = ei.equipment_type_id
         LEFT JOIN storage_locations sl ON sl.id = ei.current_location_id
         WHERE ei.holder_type = \'person\' AND ei.holder_id = ?
         ORDER BY et.name, ei.item_number'
    );
    $stmt->execute([(int)$user['id']]);
    $items = $stmt->fetchAll();

    foreach ($items as &$it) {
        $it['id']                 = (int)$it['id'];
        $it['current_location_id'] = $it['current_location_id'] ? (int)$it['current_location_id'] : null;
    }
    unset($it);

    json_ok(['items' => $items]);
}

// Search staff by name — used in checkout person-selection step
function handle_person_search(): void {
    require_method('GET');
    require_auth();

    $q = trim($_GET['q'] ?? '');
    if ($q === '') {
        json_ok(['persons' => []]);
        return;
    }

    $like  = '%' . $q . '%';
    $stmt  = db()->prepare(
        'SELECT id, display_name, qr_token FROM users
         WHERE is_active = 1 AND display_name LIKE ?
         ORDER BY display_name LIMIT 20'
    );
    $stmt->execute([$like]);
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) $r['id'] = (int)$r['id'];
    unset($r);

    json_ok(['persons' => $rows]);
}

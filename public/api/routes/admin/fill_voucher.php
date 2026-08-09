<?php
declare(strict_types=1);

// Compact multi-per-page print sheet of a group's physical water-fill voucher
// QR — deliberately keyed off groups.fill_voucher_code, NOT qr_code. Scanning
// this code only ever resolves the group for a fill request (via GET
// /scan/lookup or POST /fill-requests' entity_qr); it is never written into
// shift_tokens.token, so it can't be used to start that group's self-service
// session the way qr_code can. See handle_scan_lookup() in scan.php and
// handle_create_fill_request() in fill_requests.php.
function handle_fill_voucher_sheet(): void {
    require_method('GET');
    require_permission('manage_groups');

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('Missing group id', 400);

    $count = (int)($_GET['count'] ?? 6);
    $count = max(1, min(24, $count));

    $stmt = db()->prepare('SELECT id, name, fill_voucher_code FROM groups WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    $group = $stmt->fetch();
    if (!$group) json_error('Group not found', 404);

    $code = $group['fill_voucher_code'];
    if (empty($code)) {
        $code = bin2hex(random_bytes(12));
        db()->prepare('UPDATE groups SET fill_voucher_code = ? WHERE id = ?')->execute([$code, $id]);
    }

    $scheme    = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host      = $_SERVER['HTTP_HOST'];
    $deep_link = $scheme . '://' . $host . '/scan?qr=' . rawurlencode($code);

    $use_lib = file_exists(__DIR__ . '/../../../assets/vendor/phpqrcode/qrlib.php');
    if ($use_lib) {
        require_once __DIR__ . '/../../../assets/vendor/phpqrcode/qrlib.php';
        ob_start();
        QRcode::png($deep_link, false, QR_ECLEVEL_H, 8, 2);
        $png = ob_get_clean();
        $src = 'data:image/png;base64,' . base64_encode($png);
    } else {
        $src = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' . urlencode($deep_link);
    }

    $name_esc = htmlspecialchars($group['name'], ENT_QUOTES, 'UTF-8');

    $card = '<div class="voucher-card">'
        . '<div class="voucher-label">Water Fill Voucher</div>'
        . '<img class="voucher-img" src="' . $src . '" alt="Fill voucher QR for ' . $name_esc . '">'
        . '<div class="voucher-name">' . $name_esc . '</div>'
        . '<div class="voucher-note">Present to staff to request a fill</div>'
        . '</div>' . "\n";
    $cards = str_repeat($card, $count);

    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');

    echo '<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fill Vouchers — ' . $name_esc . '</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; background: #fff; }
.toolbar {
    display: flex;
    gap: 1rem;
    padding: 1rem;
    background: #f5f5f5;
    border-bottom: 1px solid #ddd;
    align-items: center;
}
.toolbar button {
    padding: .5rem 1.25rem;
    border: 1px solid #999;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    font-size: .9rem;
}
.toolbar button:hover { background: #e8e8e8; }
.toolbar span { color: #666; font-size: .85rem; }
.grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    padding: 1cm;
    gap: .3cm;
}
.voucher-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: .6cm .4cm;
    border: 1px dashed #bbb;
    page-break-inside: avoid;
    break-inside: avoid;
    text-align: center;
}
.voucher-label {
    font-size: 9pt;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: #666;
    margin-bottom: .2cm;
}
.voucher-img { width: 3cm; height: 3cm; display: block; margin-bottom: .2cm; }
.voucher-name { font-size: 11pt; font-weight: bold; }
.voucher-note { font-size: 8pt; color: #777; margin-top: .1cm; }
@media print {
    .toolbar { display: none; }
    .grid { padding: .5cm; }
}
</style>
</head>
<body>
<div class="toolbar">
    <button onclick="window.print()">Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
    <span>' . $count . ' voucher' . ($count !== 1 ? 's' : '') . ' — ' . $name_esc . '</span>
</div>
<div class="grid">
' . $cards . '</div>
</body>
</html>';

    exit;
}

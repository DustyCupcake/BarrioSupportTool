<?php
declare(strict_types=1);

function handle_qr_sheet(): void {
    require_method('GET');
    require_admin();

    $type_id = (int)($_GET['type_id'] ?? 0);
    $where   = $type_id ? 'WHERE i.equipment_type_id = ? AND i.status != "retired"' : "WHERE i.status != 'retired'";
    $params  = $type_id ? [$type_id] : [];

    $stmt = db()->prepare(
        "SELECT i.qr_code, i.item_number, t.secure_qr,
                t.name AS type_name,
                CONCAT(t.name, ' #', i.item_number) AS display_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         $where
         ORDER BY t.name, i.item_number"
    );
    $stmt->execute($params);
    $items = $stmt->fetchAll();

    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');

    if (empty($items)) {
        echo '<p style="font-family:sans-serif;padding:2rem">No items found.</p>';
        exit;
    }

    // Use phpqrcode library if installed, otherwise fall back to an external API.
    $use_lib = file_exists(__DIR__ . '/../../../../vendor/phpqrcode/qrlib.php');
    if ($use_lib) {
        require_once __DIR__ . '/../../../../vendor/phpqrcode/qrlib.php';
    }

    $count = count($items);
    $cards = '';

    foreach ($items as $item) {
        $qr_value = htmlspecialchars($item['qr_code'], ENT_QUOTES, 'UTF-8');
        $name_esc = htmlspecialchars($item['display_name'], ENT_QUOTES, 'UTF-8');

        if ($use_lib) {
            ob_start();
            QRcode::png($item['qr_code'], false, QR_ECLEVEL_M, 6, 2);
            $png = ob_get_clean();
            $src = 'data:image/png;base64,' . base64_encode($png);
        } else {
            // Requires internet access at print time
            $src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' . urlencode($item['qr_code']);
        }

        $img = '<img src="' . $src . '" alt="QR ' . $qr_value . '" width="160" height="160">';

        if ($item['secure_qr']) {
            // Split voucher: two identical halves with a tear line between them
            $cards .= '<div class="card card-split">'
                . '<div class="card-half">' . $img
                . '<div class="label">' . $name_esc . '</div>'
                . '<div class="code">' . $qr_value . '</div>'
                . '</div>'
                . '<div class="split-line">✂</div>'
                . '<div class="card-half">' . $img
                . '<div class="label">' . $name_esc . '</div>'
                . '<div class="code">' . $qr_value . '</div>'
                . '</div>'
                . '</div>' . "\n";
        } else {
            $cards .= '<div class="card">'
                . $img
                . '<div class="label">' . $name_esc . '</div>'
                . '<div class="code">' . $qr_value . '</div>'
                . '</div>' . "\n";
        }
    }

    echo '<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>QR Code Sheet</title>
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
    grid-template-columns: repeat(4, 1fr);
    padding: 1cm;
}

.card {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: .5cm;
    border: 1px solid #eee;
    page-break-inside: avoid;
    break-inside: avoid;
}
.card img { width: 2.5cm; height: 2.5cm; display: block; }
.label {
    margin-top: .3cm;
    font-size: 9pt;
    font-weight: bold;
    text-align: center;
    line-height: 1.2;
}
.code {
    font-size: 8pt;
    color: #555;
    font-family: monospace;
    margin-top: .1cm;
}

.card-split {
    padding: 0;
}
.card-half {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: .3cm .5cm;
}
.split-line {
    display: flex;
    align-items: center;
    gap: .2cm;
    padding: 0 .3cm;
    color: #bbb;
    font-size: 9pt;
}
.split-line::before,
.split-line::after {
    content: '';
    flex: 1;
    border-top: 1.5px dashed #bbb;
}

@media print {
    .toolbar { display: none; }
    .grid { padding: .5cm; }
    .card { border-color: #ddd; }
}
</style>
</head>
<body>
<div class="toolbar">
    <button onclick="window.print()">Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
    <span>' . $count . ' item' . ($count !== 1 ? 's' : '') . '</span>
</div>
<div class="grid">
' . $cards . '</div>
</body>
</html>';

    exit;
}

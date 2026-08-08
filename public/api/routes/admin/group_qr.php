<?php
declare(strict_types=1);

function handle_group_qr(): void {
    require_method('GET');
    require_permission('manage_groups');

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) {
        json_error('Missing group id', 400);
    }

    $stmt = db()->prepare('SELECT id, name, qr_code FROM groups WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    $group = $stmt->fetch();

    if (!$group) {
        json_error('Group not found', 404);
    }

    // Ensure qr_code exists (backfill if missing from pre-migration rows)
    if (empty($group['qr_code'])) {
        $qr_code = bin2hex(random_bytes(12));
        db()->prepare('UPDATE groups SET qr_code = ? WHERE id = ?')->execute([$qr_code, $group['id']]);
        $group['qr_code'] = $qr_code;
    }

    $scheme    = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host      = $_SERVER['HTTP_HOST'];
    $deep_link = $scheme . '://' . $host . '/scan?qr=' . rawurlencode($group['qr_code']);

    $use_lib = file_exists(__DIR__ . '/../../../assets/vendor/phpqrcode/qrlib.php');
    if ($use_lib) {
        require_once __DIR__ . '/../../../assets/vendor/phpqrcode/qrlib.php';
        ob_start();
        QRcode::png($deep_link, false, QR_ECLEVEL_H, 10, 2);
        $png = ob_get_clean();
        $src = 'data:image/png;base64,' . base64_encode($png);
    } else {
        $src = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' . urlencode($deep_link);
    }

    $name_esc = htmlspecialchars($group['name'], ENT_QUOTES, 'UTF-8');
    $link_esc = htmlspecialchars($deep_link, ENT_QUOTES, 'UTF-8');

    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');

    echo '<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Group QR — ' . $name_esc . '</title>
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
.page {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem 2rem;
    gap: 1.25rem;
}
.barrio-name {
    font-size: 2rem;
    font-weight: bold;
    letter-spacing: .02em;
}
.qr-img { width: 10cm; height: 10cm; display: block; }
.deep-link {
    font-size: 11pt;
    color: #555;
    font-family: monospace;
    word-break: break-all;
    text-align: center;
}
@media print {
    .toolbar { display: none; }
    .page { padding: 1cm; }
}
</style>
</head>
<body>
<div class="toolbar">
    <button onclick="window.print()">Print / Save as PDF</button>
    <button onclick="window.close()">Close</button>
</div>
<div class="page">
    <div class="barrio-name">' . $name_esc . '</div>
    <img class="qr-img" src="' . $src . '" alt="QR code for ' . $name_esc . '">
    <div class="deep-link">' . $link_esc . '</div>
</div>
</body>
</html>';

    exit;
}

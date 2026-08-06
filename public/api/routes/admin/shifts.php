<?php
declare(strict_types=1);

function handle_list_shifts(): void {
    require_method('GET');
    $user = require_permission('manage_shifts');

    $where  = '';
    $params = [];

    // dept_admin: scope to own depts
    if (!has_permission('manage_departments')) {
        $placeholders = implode(',', array_fill(0, count($user['dept_ids']), '?'));
        $where        = $placeholders ? "WHERE s.dept_id IN ($placeholders)" : 'WHERE 1=0';
        $params       = $user['dept_ids'];
    }

    $stmt = db()->prepare(
        "SELECT s.id, s.name, s.dept_id, d.name AS dept_name,
                s.group_id, g.name AS group_name,
                s.permissions, s.active_from, s.active_until, s.created_at,
                COUNT(st.id) AS token_count,
                SUM(st.used_at IS NOT NULL) AS tokens_used
         FROM shifts s
         LEFT JOIN departments d ON d.id = s.dept_id
         LEFT JOIN groups g ON g.id = s.group_id
         LEFT JOIN shift_tokens st ON st.shift_id = s.id
         $where
         GROUP BY s.id
         ORDER BY s.active_from DESC"
    );
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) {
        $r['id']          = (int)$r['id'];
        $r['token_count'] = (int)$r['token_count'];
        $r['tokens_used'] = (int)$r['tokens_used'];
        $r['permissions'] = json_decode($r['permissions'], true) ?: [];
    }
    unset($r);

    json_ok(['shifts' => $rows]);
}

function handle_create_shift(): void {
    require_method('POST');
    $user = require_permission('manage_shifts');
    verify_csrf();

    $b           = body();
    $name        = trim($b['name'] ?? '');
    $dept_id     = isset($b['dept_id'])  ? (int)$b['dept_id']  : null;
    $group_id    = isset($b['group_id']) ? (int)$b['group_id'] : null;
    $permissions = $b['permissions'] ?? [];
    $active_from = trim($b['active_from'] ?? '');
    $active_until = trim($b['active_until'] ?? '');

    if ($name === '' || empty($permissions) || $active_from === '' || $active_until === '') {
        json_error('name, permissions, active_from, active_until required');
    }

    foreach ($permissions as $p) {
        if (!in_array($p, $user['permissions'], true)) {
            json_error("Cannot grant a permission you don't have: $p");
        }
    }

    // dept_admin can only create shifts for their own depts
    if (!has_permission('manage_departments') && $dept_id) {
        if (!in_array($dept_id, $user['dept_ids'], true)) {
            json_error('Forbidden', 403);
        }
    }

    db()->prepare(
        'INSERT INTO shifts (name, dept_id, group_id, permissions, active_from, active_until, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)'
    )->execute([$name, $dept_id, $group_id, json_encode($permissions), $active_from, $active_until, $user['id']]);

    $id = (int)db()->lastInsertId();
    json_ok(['id' => $id], 201);
}

function handle_update_shift(): void {
    require_method('PUT');
    $user = require_permission('manage_shifts');
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? 0);
    if (!$id) json_error('id required');

    $sets   = [];
    $params = [];

    foreach (['name', 'active_from', 'active_until'] as $f) {
        if (isset($b[$f]) && trim($b[$f]) !== '') {
            $sets[]   = "$f = ?";
            $params[] = trim($b[$f]);
        }
    }
    if (isset($b['permissions']) && is_array($b['permissions'])) {
        $cur_stmt = db()->prepare('SELECT permissions FROM shifts WHERE id = ?');
        $cur_stmt->execute([$id]);
        $cur_row       = $cur_stmt->fetch();
        $current_perms = $cur_row ? (json_decode($cur_row['permissions'], true) ?: []) : [];

        // Only newly-added permissions need to be ones the editor actually holds —
        // permissions already on the shift (e.g. granted by a higher-privileged admin) may persist.
        foreach (array_diff($b['permissions'], $current_perms) as $p) {
            if (!in_array($p, $user['permissions'], true)) {
                json_error("Cannot grant a permission you don't have: $p");
            }
        }
        $sets[]   = 'permissions = ?';
        $params[] = json_encode(array_values($b['permissions']));
    }
    if (isset($b['dept_id'])) {
        $sets[]   = 'dept_id = ?';
        $params[] = $b['dept_id'] ? (int)$b['dept_id'] : null;
    }
    if (isset($b['group_id'])) {
        $sets[]   = 'group_id = ?';
        $params[] = $b['group_id'] ? (int)$b['group_id'] : null;
    }

    if (empty($sets)) json_error('Nothing to update');

    $params[] = $id;
    db()->prepare('UPDATE shifts SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
    json_ok(['success' => true]);
}

function handle_delete_shift(): void {
    require_method('DELETE');
    require_permission('manage_shifts');
    verify_csrf();

    $b  = body();
    $id = (int)($b['id'] ?? 0);
    if (!$id) json_error('id required');

    $used_stmt = db()->prepare(
        'SELECT COUNT(*) FROM shift_tokens WHERE shift_id = ? AND used_at IS NOT NULL'
    );
    $used_stmt->execute([$id]);
    $used = (int)$used_stmt->fetchColumn();

    if ($used > 0) {
        json_error('Cannot delete shift: tokens have been used', 409);
    }

    db()->prepare('DELETE FROM shifts WHERE id = ?')->execute([$id]);
    json_ok(['success' => true]);
}

function handle_create_shift_tokens(): void {
    require_method('POST');
    $user = require_permission('manage_shifts');
    verify_csrf();

    $b            = body();
    $shift_id     = (int)($b['shift_id'] ?? 0);
    $count        = max(1, min(200, (int)($b['count'] ?? 1)));
    $label_prefix = trim($b['label_prefix'] ?? '');

    if (!$shift_id) json_error('shift_id required');

    // Verify shift exists and user has access
    $shift_chk = db()->prepare('SELECT id FROM shifts WHERE id = ?');
    $shift_chk->execute([$shift_id]);
    $shift = $shift_chk->fetch();
    if (!$shift) json_error('Shift not found', 404);

    $pdo   = db();
    $stmt  = $pdo->prepare(
        'INSERT INTO shift_tokens (shift_id, token, label) VALUES (?, ?, ?)'
    );
    $tokens = [];
    for ($i = 1; $i <= $count; $i++) {
        $token = bin2hex(random_bytes(32));
        $label = $label_prefix !== '' ? "$label_prefix $i" : null;
        $stmt->execute([$shift_id, $token, $label]);
        $tokens[] = ['id' => (int)$pdo->lastInsertId(), 'token' => $token, 'label' => $label];
    }

    json_ok(['tokens' => $tokens], 201);
}

function handle_list_shift_tokens(): void {
    require_method('GET');
    require_permission('manage_shifts');

    $shift_id = (int)($_GET['shift_id'] ?? 0);
    if (!$shift_id) json_error('shift_id required');

    $stmt = db()->prepare(
        'SELECT id, token, label, used_at FROM shift_tokens WHERE shift_id = ? ORDER BY id'
    );
    $stmt->execute([$shift_id]);
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) $r['id'] = (int)$r['id'];
    unset($r);

    json_ok(['tokens' => $rows]);
}

function handle_shift_qr_sheet(): void {
    require_method('GET');
    require_permission('manage_shifts');

    $shift_id = (int)($_GET['shift_id'] ?? 0);
    if (!$shift_id) json_error('shift_id required');

    $shift_stmt = db()->prepare(
        'SELECT s.*, d.name AS dept_name FROM shifts s
         LEFT JOIN departments d ON d.id = s.dept_id
         WHERE s.id = ?'
    );
    $shift_stmt->execute([$shift_id]);
    $shift = $shift_stmt->fetch();

    if (!$shift) json_error('Shift not found', 404);

    $tok_stmt = db()->prepare(
        'SELECT id, token, label FROM shift_tokens WHERE shift_id = ? ORDER BY id'
    );
    $tok_stmt->execute([$shift_id]);
    $tokens = $tok_stmt->fetchAll();

    if (empty($tokens)) {
        header('Content-Type: text/html; charset=utf-8');
        echo '<p style="font-family:sans-serif;padding:2rem">No tokens for this shift.</p>';
        exit;
    }

    $use_lib = file_exists(__DIR__ . '/../../../assets/vendor/phpqrcode/qrlib.php');
    if ($use_lib) {
        require_once __DIR__ . '/../../../assets/vendor/phpqrcode/qrlib.php';
    }

    $scheme   = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $base_url = $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
    $count    = count($tokens);
    $cards    = '';

    $shift_name_esc = htmlspecialchars($shift['name'], ENT_QUOTES, 'UTF-8');
    $active_esc     = htmlspecialchars(
        substr($shift['active_from'], 0, 16) . ' – ' . substr($shift['active_until'], 11, 5),
        ENT_QUOTES, 'UTF-8'
    );

    foreach ($tokens as $tok) {
        $url       = $base_url . '/shift?token=' . rawurlencode($tok['token']);
        $label_esc = htmlspecialchars($tok['label'] ?? ('Slot ' . $tok['id']), ENT_QUOTES, 'UTF-8');

        if ($use_lib) {
            ob_start();
            QRcode::png($url, false, QR_ECLEVEL_H, 6, 2);
            $png = ob_get_clean();
            $src = 'data:image/png;base64,' . base64_encode($png);
        } else {
            $src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' . urlencode($url);
        }

        $cards .= '<div class="card">'
            . '<img src="' . $src . '" alt="Shift QR" width="160" height="160">'
            . '<div class="shift-name">' . $shift_name_esc . '</div>'
            . '<div class="slot">' . $label_esc . '</div>'
            . '<div class="time">' . $active_esc . '</div>'
            . '</div>' . "\n";
    }

    header('Content-Type: text/html; charset=utf-8');
    echo '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Shift QR Codes — ' . $shift_name_esc . '</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; background: #fff; }
.toolbar { display:flex; gap:1rem; padding:1rem; background:#f5f5f5; border-bottom:1px solid #ddd; align-items:center; }
.toolbar button { padding:.5rem 1.25rem; border:1px solid #999; border-radius:4px; background:#fff; cursor:pointer; }
.toolbar button:hover { background:#e8e8e8; }
.toolbar span { color:#666; font-size:.85rem; }
.grid { display:grid; grid-template-columns:repeat(4,1fr); padding:1cm; gap:.5cm; }
.card { display:flex; flex-direction:column; align-items:center; padding:.5cm; border:1px solid #eee; page-break-inside:avoid; break-inside:avoid; }
.card img { width:2.5cm; height:2.5cm; display:block; }
.shift-name { margin-top:.3cm; font-size:9pt; font-weight:bold; text-align:center; }
.slot { font-size:8.5pt; color:#333; text-align:center; margin-top:.1cm; }
.time { font-size:7pt; color:#777; text-align:center; margin-top:.1cm; }
@media print { .toolbar { display:none; } .grid { padding:.5cm; } }
</style></head><body>
<div class="toolbar">
<button onclick="window.print()">Print / Save as PDF</button>
<button onclick="window.close()">Close</button>
<span>' . $count . ' QR code' . ($count !== 1 ? 's' : '') . ' — ' . $shift_name_esc . '</span>
</div>
<div class="grid">' . $cards . '</div></body></html>';
    exit;
}

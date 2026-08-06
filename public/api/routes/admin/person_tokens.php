<?php
declare(strict_types=1);

function handle_list_person_tokens(): void {
    require_method('GET');
    require_permission('manage_users');

    $stmt = db()->prepare(
        'SELECT pt.id, pt.token, pt.label, pt.display_name, pt.claimed_at, pt.created_at,
                pt.user_id,
                COUNT(ei.id) AS active_items
         FROM person_tokens pt
         LEFT JOIN equipment_items ei ON ei.holder_type = \'person\' AND ei.holder_id = pt.user_id
         GROUP BY pt.id
         ORDER BY pt.created_at DESC, pt.id DESC'
    );
    $stmt->execute();
    $rows = $stmt->fetchAll();

    foreach ($rows as &$r) {
        $r['id']           = (int)$r['id'];
        $r['user_id']      = $r['user_id'] ? (int)$r['user_id'] : null;
        $r['active_items'] = (int)$r['active_items'];
        $r['claimed']      = $r['claimed_at'] !== null;
    }
    unset($r);

    json_ok(['tokens' => $rows]);
}

function handle_generate_person_tokens(): void {
    require_method('POST');
    require_permission('manage_users');
    verify_csrf();

    $b            = body();
    $count        = max(1, min(500, (int)($b['count'] ?? 1)));
    $label_prefix = trim($b['label_prefix'] ?? '');

    // Find the current max label number to continue sequences across calls
    $existing_max = 0;
    if ($label_prefix !== '') {
        $max_stmt = db()->prepare(
            'SELECT label FROM person_tokens WHERE label LIKE ? ORDER BY id DESC LIMIT 500'
        );
        $max_stmt->execute([$label_prefix . ' %']);
        $existing = $max_stmt->fetchAll(PDO::FETCH_COLUMN);
        foreach ($existing as $lbl) {
            $num = (int)substr($lbl, strlen($label_prefix) + 1);
            if ($num > $existing_max) $existing_max = $num;
        }
    }

    $pdo    = db();
    $stmt   = $pdo->prepare('INSERT INTO person_tokens (token, label) VALUES (?, ?)');
    $tokens = [];

    for ($i = 1; $i <= $count; $i++) {
        $token = bin2hex(random_bytes(32));
        $label = $label_prefix !== '' ? $label_prefix . ' ' . ($existing_max + $i) : null;
        $stmt->execute([$token, $label]);
        $tokens[] = [
            'id'    => (int)$pdo->lastInsertId(),
            'token' => $token,
            'label' => $label,
        ];
    }

    json_ok(['tokens' => $tokens], 201);
}

function handle_delete_person_token(): void {
    require_method('DELETE');
    require_permission('manage_users');
    verify_csrf();

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('id required', 400);

    $stmt = db()->prepare(
        'SELECT pt.id, pt.user_id, pt.claimed_at, COUNT(ei.id) AS active_items
         FROM person_tokens pt
         LEFT JOIN equipment_items ei ON ei.holder_type = \'person\' AND ei.holder_id = pt.user_id
         WHERE pt.id = ?
         GROUP BY pt.id'
    );
    $stmt->execute([$id]);
    $tok = $stmt->fetch();
    if (!$tok) json_error('Token not found', 404);

    if ((int)$tok['active_items'] > 0) {
        json_error('Cannot unclaim: person has items checked out', 409);
    }

    $pdo = db();
    $pdo->beginTransaction();
    try {
        // Deactivate the minimal user account (if person-only, no transaction history outside items)
        if ($tok['user_id'] && $tok['claimed_at'] !== null) {
            $history_stmt = $pdo->prepare(
                "SELECT COUNT(*) FROM transactions WHERE holder_type = 'person' AND holder_id = ?"
            );
            $history_stmt->execute([$tok['user_id']]);
            $history_count = (int)$history_stmt->fetchColumn();

            if ($history_count === 0) {
                // No history: safe to deactivate completely
                $pdo->prepare('UPDATE users SET is_active = 0 WHERE id = ?')
                    ->execute([$tok['user_id']]);
            }
            // If history exists, just unlink from the token (the user record stays)
        }

        // Reset the token back to unclaimed
        $pdo->prepare(
            'UPDATE person_tokens SET user_id = NULL, display_name = NULL, claimed_at = NULL WHERE id = ?'
        )->execute([$id]);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['success' => true]);
}

function handle_person_token_qr_sheet(): void {
    require_method('GET');
    require_permission('manage_users');

    // Optional filter: only unclaimed
    $unclaimed_only = !empty($_GET['unclaimed']);

    $sql = 'SELECT id, token, label, display_name, claimed_at FROM person_tokens';
    if ($unclaimed_only) $sql .= ' WHERE claimed_at IS NULL';
    $sql .= ' ORDER BY id';

    $stmt = db()->prepare($sql);
    $stmt->execute();
    $tokens = $stmt->fetchAll();

    if (empty($tokens)) {
        header('Content-Type: text/html; charset=utf-8');
        echo '<p style="font-family:sans-serif;padding:2rem">No person badges to display.</p>';
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

    foreach ($tokens as $tok) {
        $url       = $base_url . '/person.html?token=' . rawurlencode($tok['token']);
        $label_esc = htmlspecialchars($tok['label'] ?? ('Badge #' . $tok['id']), ENT_QUOTES, 'UTF-8');
        $status    = $tok['claimed_at'] !== null
            ? htmlspecialchars($tok['display_name'], ENT_QUOTES, 'UTF-8')
            : 'Unclaimed';
        $status_class = $tok['claimed_at'] !== null ? 'claimed' : 'unclaimed';

        if ($use_lib) {
            ob_start();
            QRcode::png($url, false, QR_ECLEVEL_H, 6, 2);
            $png = ob_get_clean();
            $src = 'data:image/png;base64,' . base64_encode($png);
        } else {
            $src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' . urlencode($url);
        }

        $cards .= '<div class="card">'
            . '<img src="' . $src . '" alt="Badge QR" width="160" height="160">'
            . '<div class="label">' . $label_esc . '</div>'
            . '<div class="status ' . $status_class . '">' . $status . '</div>'
            . '</div>' . "\n";
    }

    $title = $unclaimed_only ? 'Unclaimed Person Badges' : 'Person Badges';
    header('Content-Type: text/html; charset=utf-8');
    echo '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>' . htmlspecialchars($title, ENT_QUOTES, 'UTF-8') . '</title>
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
.label { margin-top:.3cm; font-size:9pt; font-weight:bold; text-align:center; }
.status { font-size:7.5pt; text-align:center; margin-top:.2cm; padding:.1cm .3cm; border-radius:3px; }
.unclaimed { color:#666; background:#f0f0f0; }
.claimed { color:#1a7a2e; background:#e6f4ea; }
@media print { .toolbar { display:none; } .grid { padding:.5cm; } }
</style></head><body>
<div class="toolbar">
<button onclick="window.print()">Print / Save as PDF</button>
<button onclick="window.close()">Close</button>
<span>' . $count . ' badge' . ($count !== 1 ? 's' : '') . '</span>
</div>
<div class="grid">' . $cards . '</div></body></html>';
    exit;
}

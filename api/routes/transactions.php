<?php
declare(strict_types=1);

function handle_checkout(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b         = body();
    $barrio_id = (int)($b['barrio_id'] ?? 0);
    $item_qrs  = $b['item_qrs'] ?? [];
    $force     = !empty($b['force']);

    if (!$barrio_id || empty($item_qrs) || !is_array($item_qrs)) {
        json_error('barrio_id and item_qrs required');
    }

    // Validate barrio exists
    $barrio = db()->prepare('SELECT id FROM barrios WHERE id = ?');
    $barrio->execute([$barrio_id]);
    if (!$barrio->fetch()) json_error('Barrio not found', 404);

    $results = [];
    $now     = date('Y-m-d H:i:s');

    $pdo = db();
    $pdo->beginTransaction();

    try {
        foreach ($item_qrs as $qr) {
            $qr   = (string)$qr;
            $stmt = $pdo->prepare(
                'SELECT id, status, current_barrio_id FROM equipment_items WHERE qr_code = ? FOR UPDATE'
            );
            $stmt->execute([$qr]);
            $item = $stmt->fetch();

            if (!$item) {
                $results[] = ['qr' => $qr, 'success' => false, 'error' => 'not_found'];
                continue;
            }

            if ($item['status'] === 'checked-out' && !$force) {
                // Get barrio name for error context
                $bn = $pdo->prepare('SELECT name FROM barrios WHERE id = ?');
                $bn->execute([$item['current_barrio_id']]);
                $b_row = $bn->fetch();
                $results[] = [
                    'qr'             => $qr,
                    'success'        => false,
                    'error'          => 'already_checked_out',
                    'current_barrio' => $b_row['name'] ?? null,
                ];
                continue;
            }

            $pdo->prepare(
                'UPDATE equipment_items SET status = "checked-out", current_barrio_id = ? WHERE id = ?'
            )->execute([$barrio_id, $item['id']]);

            $pdo->prepare(
                'INSERT INTO transactions (type, item_id, barrio_id, performed_by, user_name_cache, occurred_at)
                 VALUES ("checkout", ?, ?, ?, ?, ?)'
            )->execute([$item['id'], $barrio_id, $user['id'], $user['display_name'], $now]);

            $results[] = ['qr' => $qr, 'success' => true];
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['results' => $results]);
}

function handle_checkin(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b       = body();
    $item_qr = trim($b['item_qr'] ?? '');

    if ($item_qr === '') json_error('item_qr required');

    $stmt = db()->prepare('SELECT id, status FROM equipment_items WHERE qr_code = ?');
    $stmt->execute([$item_qr]);
    $item = $stmt->fetch();

    if (!$item) json_error('Item not found', 404);

    if ($item['status'] !== 'checked-out') {
        json_ok(['success' => false, 'error' => 'not_checked_out']);
    }

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $pdo->prepare(
            'UPDATE equipment_items SET status = "available", current_barrio_id = NULL WHERE id = ?'
        )->execute([$item['id']]);

        $pdo->prepare(
            'INSERT INTO transactions (type, item_id, barrio_id, performed_by, user_name_cache, occurred_at)
             VALUES ("checkin", ?, NULL, ?, ?, NOW())'
        )->execute([$item['id'], $user['id'], $user['display_name']]);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        json_error('Database error: ' . $e->getMessage(), 500);
    }

    json_ok(['success' => true]);
}

<?php
declare(strict_types=1);

function handle_sync(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b      = body();
    $events = $b['events'] ?? [];

    if (!is_array($events) || empty($events)) {
        json_error('events array required');
    }

    $processed = 0;
    $rejected  = [];
    $pdo       = db();

    foreach ($events as $ev) {
        $client_id   = (string)($ev['client_id'] ?? '');
        $type        = $ev['type'] ?? '';
        $item_qr     = trim($ev['item_qr'] ?? '');
        $barrio_id   = isset($ev['barrio_id']) ? (int)$ev['barrio_id'] : null;
        $occurred_at = $ev['occurred_at'] ?? null;

        if (!in_array($type, ['checkout', 'checkin'], true) || $item_qr === '' || !$occurred_at) {
            $rejected[] = ['client_id' => $client_id, 'reason' => 'invalid_event'];
            continue;
        }

        // Validate date
        $dt = DateTime::createFromFormat('Y-m-d\TH:i:s', substr($occurred_at, 0, 19));
        if (!$dt) {
            $rejected[] = ['client_id' => $client_id, 'reason' => 'invalid_date'];
            continue;
        }
        $occurred_str = $dt->format('Y-m-d H:i:s');

        $item_stmt = $pdo->prepare('SELECT id, status FROM equipment_items WHERE qr_code = ?');
        $item_stmt->execute([$item_qr]);
        $item = $item_stmt->fetch();

        if (!$item) {
            $rejected[] = ['client_id' => $client_id, 'reason' => 'item_not_found'];
            continue;
        }

        $pdo->beginTransaction();
        try {
            if ($type === 'checkout' && $barrio_id) {
                $pdo->prepare(
                    'UPDATE equipment_items SET status = "checked-out", current_barrio_id = ? WHERE id = ?'
                )->execute([$barrio_id, $item['id']]);

                $pdo->prepare(
                    'INSERT INTO transactions
                     (type, item_id, barrio_id, performed_by, user_name_cache, is_offline_entry, occurred_at)
                     VALUES ("checkout", ?, ?, ?, ?, 1, ?)'
                )->execute([$item['id'], $barrio_id, $user['id'], $user['display_name'], $occurred_str]);
            } elseif ($type === 'checkin') {
                $pdo->prepare(
                    'UPDATE equipment_items SET status = "available", current_barrio_id = NULL WHERE id = ?'
                )->execute([$item['id']]);

                $pdo->prepare(
                    'INSERT INTO transactions
                     (type, item_id, barrio_id, performed_by, user_name_cache, is_offline_entry, occurred_at)
                     VALUES ("checkin", ?, NULL, ?, ?, 1, ?)'
                )->execute([$item['id'], $user['id'], $user['display_name'], $occurred_str]);
            } else {
                $pdo->rollBack();
                $rejected[] = ['client_id' => $client_id, 'reason' => 'invalid_type'];
                continue;
            }

            $pdo->commit();
            $processed++;
        } catch (Throwable $e) {
            $pdo->rollBack();
            $rejected[] = ['client_id' => $client_id, 'reason' => 'db_error'];
        }
    }

    json_ok(['processed' => $processed, 'rejected' => $rejected]);
}

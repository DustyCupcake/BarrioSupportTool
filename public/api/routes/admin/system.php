<?php
declare(strict_types=1);

/**
 * System-level admin operations: new-event creation and optional reset tasks.
 */

function handle_system_reset(): void {
    require_method('POST');
    require_permission('manage_equipment');
    verify_csrf();

    $body = body();

    $event_name = trim($body['event_name'] ?? '');
    $event_date = trim($body['event_date'] ?? '') ?: null;
    $ops        = $body['operations'] ?? [];

    if ($event_name === '') {
        json_error('event_name is required');
    }

    if ($event_date !== null && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $event_date)) {
        json_error('event_date must be YYYY-MM-DD');
    }

    $db = db();
    $db->beginTransaction();

    try {
        // Deactivate any currently active event
        $db->exec('UPDATE events SET is_active = 0 WHERE is_active = 1');

        // Create and activate the new event
        $stmt = $db->prepare(
            'INSERT INTO events (name, event_date, is_active) VALUES (?, ?, 1)'
        );
        $stmt->execute([$event_name, $event_date]);
        $event_id = (int)$db->lastInsertId();

        $counts = [];

        // Release all equipment including department level
        if (!empty($ops['release_all'])) {
            $stmt = $db->prepare(
                'UPDATE equipment_items
                 SET status = \'available\',
                     owning_dept_id = NULL,
                     dept_label     = NULL,
                     holder_type    = NULL,
                     holder_id      = NULL
                 WHERE status != \'retired\''
            );
            $stmt->execute();
            $counts['equipment_released'] = $stmt->rowCount();

        // Release group/person level only — keep dept assignments (return to dept-held state).
        // Items with no owning dept (borrowed straight from the production pool) have no
        // dept-held state to return to, so those go fully available instead.
        } elseif (!empty($ops['release_barrio'])) {
            $stmt = $db->prepare(
                'UPDATE equipment_items
                 SET holder_type = \'department\', holder_id = owning_dept_id
                 WHERE holder_type IN (\'group\',\'person\') AND owning_dept_id IS NOT NULL'
            );
            $stmt->execute();
            $released = $stmt->rowCount();

            $stmt2 = $db->prepare(
                'UPDATE equipment_items
                 SET status = \'available\', holder_type = NULL, holder_id = NULL, dept_label = NULL
                 WHERE holder_type IN (\'group\',\'person\') AND owning_dept_id IS NULL'
            );
            $stmt2->execute();
            $counts['equipment_released'] = $released + $stmt2->rowCount();
        }

        // Reset group arrival/departure statuses (arrival-tracking groups only)
        if (!empty($ops['reset_barrios'])) {
            $stmt = $db->prepare(
                'UPDATE groups
                 SET arrival_status   = \'expected\',
                     arrived_at       = NULL,
                     arrived_by       = NULL,
                     arrived_by_name  = NULL,
                     orientation_done = 0,
                     departed_at      = NULL,
                     departed_by      = NULL,
                     departed_by_name = NULL
                 WHERE enable_arrival_tracking = 1'
            );
            $stmt->execute();
            $counts['barrios_reset'] = $stmt->rowCount();
        }

        // Clear consumable distributions
        if (!empty($ops['clear_distributions'])) {
            $stmt = $db->prepare('UPDATE group_entitlements SET distributed = 0');
            $stmt->execute();
            $counts['entitlements_cleared'] = $stmt->rowCount();

            $stmt2 = $db->prepare('DELETE FROM distribution_events');
            $stmt2->execute();
            $counts['distribution_events_deleted'] = $stmt2->rowCount();
        }

        // Cancel pending/in-progress fill requests
        if (!empty($ops['clear_fill_queue'])) {
            $stmt = $db->prepare(
                'DELETE FROM fill_requests WHERE status IN (\'pending\', \'partial\')'
            );
            $stmt->execute();
            $counts['fill_requests_cleared'] = $stmt->rowCount();
        }

        // Clear notes from all equipment items
        if (!empty($ops['clear_item_notes'])) {
            $stmt = $db->prepare(
                'UPDATE equipment_items SET notes = NULL WHERE notes IS NOT NULL'
            );
            $stmt->execute();
            $counts['items_notes_cleared'] = $stmt->rowCount();
        }

        // Expire all active volunteer shift sessions
        if (!empty($ops['expire_shifts'])) {
            $stmt = $db->prepare(
                'UPDATE shifts SET active_until = NOW()
                 WHERE active_until > NOW()'
            );
            $stmt->execute();
            $counts['shifts_expired'] = $stmt->rowCount();
        }

        $db->commit();

    } catch (Throwable $e) {
        $db->rollBack();
        throw $e;
    }

    json_ok([
        'event'  => ['id' => $event_id, 'name' => $event_name, 'event_date' => $event_date],
        'counts' => $counts,
    ]);
}

function handle_active_event(): void {
    require_method('GET');

    $stmt = db()->prepare('SELECT id, name, event_date FROM events WHERE is_active = 1 LIMIT 1');
    $stmt->execute();
    $event = $stmt->fetch() ?: null;

    json_ok(['event' => $event]);
}

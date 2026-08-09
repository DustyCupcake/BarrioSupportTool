<?php
declare(strict_types=1);

// Direction-claims locking for the water-fill truck route — split out of
// fill_requests.php. One truck crew claims a direction (asc/desc) for their
// run; a second crew can't claim the same direction until it's released or
// the claim goes stale (12h). See fill_requests.php for the fill lifecycle
// these claims exist to coordinate.

// ─── GET /fill/direction-status ──────────────────────────────────────────────
// Returns which directions are currently claimed by active fill truck sessions.
// Claims older than 12 h are considered stale and ignored.
function handle_direction_status(): void {
    require_method('GET');
    require_auth();
    // Truck crews need this to pick an unclaimed direction; the read-only
    // fill-status board also surfaces it for visibility, without granting
    // fill_truck's write access to anything.
    if (!has_permission('fill_truck') && !has_permission('view_fill_status')) {
        json_error('Forbidden', 403);
    }

    $stmt = db()->prepare(
        "SELECT direction, user_name, claimed_at
         FROM fill_run_claims
         WHERE released = 0
           AND claimed_at > DATE_SUB(NOW(), INTERVAL 12 HOUR)
         ORDER BY claimed_at ASC"
    );
    $stmt->execute();
    $claims = $stmt->fetchAll();

    json_ok(['claims' => $claims]);
}

// ─── POST /fill/claim-direction ───────────────────────────────────────────────
// Claim a route direction for this shift session.
function handle_claim_direction(): void {
    require_method('POST');
    $user = require_auth();
    require_permission('fill_truck');
    verify_csrf();

    $b         = body();
    $direction = in_array($b['direction'] ?? '', ['asc', 'desc'], true)
        ? $b['direction'] : null;
    if (!$direction) json_error('direction must be asc or desc');

    $pdo = db();

    // Named advisory lock serializes concurrent claim attempts for the same
    // direction — without it, two crews claiming within the same instant could
    // both pass the "not already claimed" check before either has inserted.
    $lock_name = "fr_direction_{$direction}";
    $got_lock  = (bool)$pdo->query('SELECT GET_LOCK(' . $pdo->quote($lock_name) . ', 5)')->fetchColumn();
    if (!$got_lock) {
        json_error('Direction claim is being processed by someone else — try again', 409);
    }

    // Check if this direction is already claimed by another active session
    $stmt = $pdo->prepare(
        "SELECT id, user_name FROM fill_run_claims
         WHERE direction = ? AND released = 0
           AND claimed_at > DATE_SUB(NOW(), INTERVAL 12 HOUR)
         LIMIT 1"
    );
    $stmt->execute([$direction]);
    $existing = $stmt->fetch();

    if ($existing) {
        $pdo->query('SELECT RELEASE_LOCK(' . $pdo->quote($lock_name) . ')');
        json_error(
            'Direction already claimed by ' . ($existing['user_name'] ?? 'another shift'),
            409
        );
    }

    $display  = $user['display_name'] ?? 'Fill crew';
    $user_id  = isset($user['id']) ? (int)$user['id'] : null;
    $now      = date('Y-m-d H:i:s');

    $pdo->prepare(
        'INSERT INTO fill_run_claims (direction, user_name, user_id, claimed_at)
         VALUES (?, ?, ?, ?)'
    )->execute([$direction, $display, $user_id, $now]);

    $claim_id = (int)$pdo->lastInsertId();

    $pdo->query('SELECT RELEASE_LOCK(' . $pdo->quote($lock_name) . ')');

    json_ok(['success' => true, 'direction' => $direction, 'claim_id' => $claim_id]);
}

// ─── POST /fill/release-direction ────────────────────────────────────────────
// Release a claimed direction (end of run or logout).
function handle_release_direction(): void {
    require_method('POST');
    require_auth();
    require_permission('fill_truck');
    verify_csrf();

    $b        = body();
    $claim_id = (int)($b['claim_id'] ?? 0);
    if (!$claim_id) json_error('claim_id required');

    $now = date('Y-m-d H:i:s');
    db()->prepare(
        "UPDATE fill_run_claims SET released = 1, released_at = ? WHERE id = ? AND released = 0"
    )->execute([$now, $claim_id]);

    json_ok(['success' => true]);
}

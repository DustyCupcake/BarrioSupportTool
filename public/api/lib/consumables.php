<?php
declare(strict_types=1);

// The water_fill consumable type's real credit ledger must only ever be
// written by the truck confirm/adhoc-fill flow in fill_requests.php — never
// by the generic per-type distribution endpoints (arrival form, CSV import's
// distributed writes, admin barrio-distribute). Callers use this to exclude
// water_fill's type_id from whatever generic list of types they're about to
// write group_entitlements.distributed for.
function water_fill_type_id(\PDO $pdo): ?int {
    $stmt = $pdo->prepare('SELECT id FROM consumable_types WHERE key_name = ?');
    $stmt->execute(['water_fill']);
    $id = $stmt->fetchColumn();
    return $id !== false ? (int)$id : null;
}

// Shared by the core fill-request flow (fill_requests.php) and the admin
// credit-sale/status-board endpoints (routes/admin/fill_requests.php) — kept
// here rather than duplicated, since only the one route file matching the
// current request gets required (see the dispatch loop in index.php).
function get_fill_credits(\PDO $pdo, int $group_id): array {
    $stmt = $pdo->prepare(
        "SELECT ge.purchased, ge.distributed
         FROM group_entitlements ge
         JOIN consumable_types ct ON ct.id = ge.type_id AND ct.key_name = 'water_fill'
         WHERE ge.group_id = ?"
    );
    $stmt->execute([$group_id]);
    $row = $stmt->fetch();
    return $row ? ['purchased' => (int)$row['purchased'], 'distributed' => (int)$row['distributed']]
                : ['purchased' => 0, 'distributed' => 0];
}

function get_pending_fill_requests(\PDO $pdo, int $group_id): int {
    $stmt = $pdo->prepare(
        "SELECT COALESCE(SUM(fills_requested - fills_completed), 0) AS pending
         FROM fill_requests
         WHERE group_id = ? AND status IN ('pending','partial')"
    );
    $stmt->execute([$group_id]);
    return (int)$stmt->fetchColumn();
}

<?php
declare(strict_types=1);

// A group's default location: only used when the group has exactly one
// storage_location with coordinates set — otherwise it's ambiguous, so no default.
function get_group_location(\PDO $pdo, int $group_id): ?array {
    $stmt = $pdo->prepare(
        'SELECT latitude, longitude FROM storage_locations
         WHERE group_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    $stmt->execute([$group_id]);
    $rows = $stmt->fetchAll();
    if (count($rows) !== 1) return null;
    return ['latitude' => (float)$rows[0]['latitude'], 'longitude' => (float)$rows[0]['longitude']];
}

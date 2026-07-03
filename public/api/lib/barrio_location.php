<?php
declare(strict_types=1);

// A barrio's default location: only used when the barrio has exactly one
// storage_location with coordinates set — otherwise it's ambiguous, so no default.
function get_barrio_location(\PDO $pdo, int $barrio_id): ?array {
    $stmt = $pdo->prepare(
        'SELECT latitude, longitude FROM storage_locations
         WHERE barrio_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    $stmt->execute([$barrio_id]);
    $rows = $stmt->fetchAll();
    if (count($rows) !== 1) return null;
    return ['latitude' => (float)$rows[0]['latitude'], 'longitude' => (float)$rows[0]['longitude']];
}

<?php
declare(strict_types=1);

// GET /map-overlay — returns the current site map overlay GeoJSON for
// rendering on the Fill Route maps. Any authenticated session (including
// fill_truck shift sessions) can read this; it's a read-only reference layer.
function handle_get_map_overlay(): void {
    require_method('GET');
    require_auth();

    $stmt = db()->prepare('SELECT geojson FROM map_overlays ORDER BY id DESC LIMIT 1');
    $stmt->execute();
    $row = $stmt->fetch();

    if (!$row) { json_ok(['present' => false]); return; }

    $geojson = json_decode($row['geojson'], true);
    json_ok(['present' => true, 'geojson' => $geojson]);
}

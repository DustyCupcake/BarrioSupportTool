<?php
declare(strict_types=1);

require_once __DIR__ . '/../../lib/kml_parser.php';

function _map_overlay_require_access(): array {
    $user = require_auth();
    if (!has_permission('manage_barrios') && !has_permission('manage_equipment')) {
        json_error('Forbidden', 403);
    }
    return $user;
}

// GET /admin/map-overlay — status only (no geojson payload).
function handle_admin_get_map_overlay(): void {
    require_method('GET');
    _map_overlay_require_access();

    $stmt = db()->prepare(
        'SELECT mo.name, mo.feature_count, mo.created_at, u.display_name AS uploaded_by_name
         FROM map_overlays mo
         LEFT JOIN users u ON u.id = mo.uploaded_by
         ORDER BY mo.id DESC LIMIT 1'
    );
    $stmt->execute();
    $row = $stmt->fetch();

    if (!$row) { json_ok(['present' => false]); return; }

    json_ok([
        'present'         => true,
        'name'            => $row['name'],
        'feature_count'   => (int)$row['feature_count'],
        'created_at'      => $row['created_at'],
        'uploaded_by_name' => $row['uploaded_by_name'],
    ]);
}

// POST /admin/map-overlay — multipart upload of a .kmz or .kml file.
// Replaces any existing overlay (singleton).
function handle_admin_upload_map_overlay(): void {
    require_method('POST');
    $user = _map_overlay_require_access();
    verify_csrf();

    if (empty($_FILES['file']['tmp_name']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
        json_error('No file uploaded', 422);
    }

    $file     = $_FILES['file'];
    $origName = (string)($file['name'] ?? 'site-map');
    $ext      = strtolower(pathinfo($origName, PATHINFO_EXTENSION));

    if (!in_array($ext, ['kmz', 'kml'], true)) {
        json_error('File must be a .kmz or .kml', 422);
    }

    if ($ext === 'kmz') {
        $kml = _map_overlay_extract_kml_from_kmz($file['tmp_name']);
    } else {
        if ((int)$file['size'] > KML_MAX_BYTES) json_error('KML file is too large', 422);
        $kml = file_get_contents($file['tmp_name']);
        if ($kml === false) json_error('Could not read uploaded file', 500);
    }

    try {
        $geojson = parse_kml_to_geojson($kml);
    } catch (Throwable $e) {
        json_error('Could not parse file: ' . $e->getMessage(), 422);
    }

    $featureCount = count($geojson['features']);
    $geojsonText  = json_encode($geojson, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $pdo->exec('DELETE FROM map_overlays');
        $ins = $pdo->prepare(
            'INSERT INTO map_overlays (name, geojson, feature_count, uploaded_by)
             VALUES (?, ?, ?, ?)'
        );
        $ins->execute([$origName, $geojsonText, $featureCount, $user['id']]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    json_ok(['name' => $origName, 'feature_count' => $featureCount]);
}

// DELETE /admin/map-overlay — clears the current overlay.
function handle_admin_delete_map_overlay(): void {
    require_method('DELETE');
    _map_overlay_require_access();
    verify_csrf();

    db()->exec('DELETE FROM map_overlays');
    json_ok(['deleted' => true]);
}

function _map_overlay_extract_kml_from_kmz(string $tmpPath): string {
    $zip = new ZipArchive();
    if ($zip->open($tmpPath) !== true) {
        json_error('Could not open KMZ file', 422);
    }

    $kmlIndex = -1;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = $zip->getNameIndex($i);
        if ($name !== false && preg_match('/\.kml$/i', $name)) {
            $kmlIndex = $i;
            break;
        }
    }

    if ($kmlIndex === -1) {
        $zip->close();
        json_error('KMZ file does not contain a .kml document', 422);
    }

    $stat = $zip->statIndex($kmlIndex);
    if ($stat && $stat['size'] > KML_MAX_BYTES) {
        $zip->close();
        json_error('KML document inside KMZ is too large', 422);
    }

    $kml = $zip->getFromIndex($kmlIndex);
    $zip->close();

    if ($kml === false) {
        json_error('Could not read KML document from KMZ', 422);
    }

    return $kml;
}

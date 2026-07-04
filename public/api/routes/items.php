<?php
declare(strict_types=1);

function handle_lookup(): void {
    require_method('GET');
    require_auth();

    $qr = trim($_GET['qr'] ?? '');
    if ($qr === '') json_error('qr parameter required');

    $stmt = db()->prepare(
        'SELECT i.id, i.qr_code, i.status, i.notes, i.equipment_type_id,
                i.dept_label, i.current_dept_id, i.current_barrio_id, i.current_artist_id, i.current_person_id,
                i.current_location_id,
                i.latitude AS item_lat, i.longitude AS item_lng,
                i.home_location_id AS item_home_loc_id,
                i.require_home_location AS item_require_home,
                i.require_any_location AS item_require_any,
                i.spec_values, i.photo,
                t.name AS type_name, t.category, t.secure_qr, t.borrowable, t.is_crate, t.deployment_destination,
                t.home_location_id AS type_home_loc_id,
                t.require_home_location AS type_require_home,
                t.require_any_location AS type_require_any,
                b.id AS barrio_id, b.name AS barrio_name,
                d.id AS dept_id, d.name AS dept_name,
                a.id AS artist_id, a.name AS artist_name,
                p.id AS person_id, p.display_name AS person_name,
                cl.name AS current_location_name,
                hl.id AS eff_home_loc_id, hl.name AS home_location_name,
                hl.latitude AS home_lat, hl.longitude AS home_lng,
                CONCAT(t.name, " #", i.item_number) AS display_name
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN barrios b ON b.id = i.current_barrio_id
         LEFT JOIN departments d ON d.id = i.current_dept_id
         LEFT JOIN artists a ON a.id = i.current_artist_id
         LEFT JOIN users p ON p.id = i.current_person_id
         LEFT JOIN storage_locations cl ON cl.id = i.current_location_id
         LEFT JOIN storage_locations hl ON hl.id = COALESCE(i.home_location_id, t.home_location_id)
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$qr]);
    $item = $stmt->fetch();

    if (!$item) json_error('Item not found', 404);

    $borrowable = (bool)($item['borrowable'] ?? false);
    $eligibility = $borrowable
        ? check_borrow_eligible((int)$item['id'], (int)$item['equipment_type_id'])
        : ['eligible' => false, 'reason' => 'not_borrowable'];

    // Resolve effective location requirements
    $eff_require_home = $item['item_require_home'] !== null
        ? (bool)$item['item_require_home']
        : (bool)$item['type_require_home'];
    $eff_require_any  = $item['item_require_any'] !== null
        ? (bool)$item['item_require_any']
        : (bool)$item['type_require_any'];

    // Load spec fields for this item's type
    $sf_stmt = db()->prepare(
        'SELECT id, field_key, label, field_type, unit, options, sort_order
         FROM equipment_type_spec_fields WHERE equipment_type_id = ? ORDER BY sort_order'
    );
    $sf_stmt->execute([(int)$item['equipment_type_id']]);
    $spec_fields = [];
    foreach ($sf_stmt->fetchAll() as $f) {
        $spec_fields[] = [
            'id'         => (int)$f['id'],
            'field_key'  => $f['field_key'],
            'label'      => $f['label'],
            'field_type' => $f['field_type'],
            'unit'       => $f['unit'],
            'options'    => $f['options'] ? json_decode($f['options'], true) : null,
            'sort_order' => (int)$f['sort_order'],
        ];
    }

    json_ok([
        'id'                   => (int)$item['id'],
        'qr_code'              => $item['qr_code'],
        'name'                 => $item['display_name'],
        'category'             => $item['category'],
        'status'               => $item['status'],
        'secure_qr'            => (bool)$item['secure_qr'],
        'equipment_type_id'    => (int)$item['equipment_type_id'],
        'dept_label'           => $item['dept_label'],
        'current_dept'         => $item['dept_id']
            ? ['id' => (int)$item['dept_id'], 'name' => $item['dept_name']]
            : null,
        'current_barrio'       => $item['barrio_id']
            ? ['id' => (int)$item['barrio_id'], 'name' => $item['barrio_name']]
            : null,
        'current_artist'       => $item['artist_id']
            ? ['id' => (int)$item['artist_id'], 'name' => $item['artist_name']]
            : null,
        'current_person'       => $item['person_id']
            ? ['id' => (int)$item['person_id'], 'name' => $item['person_name']]
            : null,
        'current_location'     => $item['current_location_id']
            ? ['id' => (int)$item['current_location_id'], 'name' => $item['current_location_name']]
            : null,
        'latitude'             => $item['item_lat']  !== null ? (float)$item['item_lat']  : null,
        'longitude'            => $item['item_lng']  !== null ? (float)$item['item_lng']  : null,
        'home_location'        => $item['eff_home_loc_id']
            ? ['id'        => (int)$item['eff_home_loc_id'],
               'name'      => $item['home_location_name'],
               'latitude'  => $item['home_lat']  !== null ? (float)$item['home_lat']  : null,
               'longitude' => $item['home_lng']  !== null ? (float)$item['home_lng']  : null]
            : null,
        'require_home_location' => $eff_require_home,
        'require_any_location'  => $eff_require_any,
        'borrowable'           => $borrowable,
        'borrow_eligible'      => $eligibility['eligible'],
        'borrow_reason'        => $eligibility['reason'],
        'spec_fields'          => $spec_fields,
        'spec_values'            => $item['spec_values'] ? json_decode($item['spec_values'], true) : (object)[],
        'photo'                  => $item['photo'],
        'is_crate'               => (bool)$item['is_crate'],
        'deployment_destination' => $item['deployment_destination'],
    ]);
}

function handle_inventory(): void {
    require_method('GET');
    require_auth();

    $status_filter = $_GET['status'] ?? null;
    $where = '';
    $params = [];
    if (in_array($status_filter, ['available', 'checked-out', 'retired'], true)) {
        $where = 'WHERE i.status = ?';
        $params[] = $status_filter;
    } else {
        $where = "WHERE i.status != 'retired'";
    }

    $rows = db()->prepare(
        "SELECT i.id, i.qr_code, i.status, i.dept_label,
                i.equipment_type_id, i.spec_values, i.photo,
                CONCAT(t.name, ' #', i.item_number) AS name,
                t.category,
                d.name AS current_dept,
                b.name AS current_barrio,
                a.name AS current_artist
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         LEFT JOIN departments d ON d.id = i.current_dept_id
         LEFT JOIN barrios b ON b.id = i.current_barrio_id
         LEFT JOIN artists a ON a.id = i.current_artist_id
         $where
         ORDER BY t.name, i.item_number"
    );
    $rows->execute($params);
    $items = $rows->fetchAll();

    $available   = 0;
    $checked_out = 0;
    foreach ($items as $it) {
        if ($it['status'] === 'available')    $available++;
        if ($it['status'] === 'checked-out')  $checked_out++;
    }

    foreach ($items as &$it) {
        $it['id']               = (int)$it['id'];
        $it['equipment_type_id'] = (int)$it['equipment_type_id'];
        $it['spec_values']      = $it['spec_values'] ? json_decode($it['spec_values'], true) : (object)[];
    }
    unset($it);

    // Spec schemas keyed by equipment_type_id for client-side filter rendering
    $sf_all = db()->query(
        'SELECT equipment_type_id, field_key, label, field_type, unit, options, sort_order
         FROM equipment_type_spec_fields ORDER BY equipment_type_id, sort_order'
    )->fetchAll();
    $spec_schemas = [];
    foreach ($sf_all as $f) {
        $tid = (int)$f['equipment_type_id'];
        $spec_schemas[$tid][] = [
            'field_key'  => $f['field_key'],
            'label'      => $f['label'],
            'field_type' => $f['field_type'],
            'unit'       => $f['unit'],
            'options'    => $f['options'] ? json_decode($f['options'], true) : null,
        ];
    }

    json_ok([
        'stats'        => ['available' => $available, 'checked_out' => $checked_out],
        'items'        => $items,
        'spec_schemas' => $spec_schemas,
    ]);
}

function handle_upload_item_photo(): void {
    require_method('POST');
    require_permission('manage_equipment');
    verify_csrf();

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('item id required');

    // Verify item exists
    $chk = db()->prepare('SELECT id FROM equipment_items WHERE id = ?');
    $chk->execute([$id]);
    if (!$chk->fetch()) json_error('Item not found', 404);

    if (empty($_FILES['photo']) || $_FILES['photo']['error'] !== UPLOAD_ERR_OK) {
        $err = $_FILES['photo']['error'] ?? -1;
        json_error('No file uploaded or upload error: ' . $err);
    }

    $file = $_FILES['photo'];
    $mime = mime_content_type($file['tmp_name']);
    if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], true)) {
        json_error('Only image files are accepted');
    }

    $dir = __DIR__ . '/../../storage/item_photos/';
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }

    // Always save as jpg; resize if GD available
    $dest_rel = 'storage/item_photos/' . $id . '.jpg';
    $dest     = __DIR__ . '/../../' . $dest_rel;

    if (function_exists('imagecreatefromstring')) {
        $src_data = file_get_contents($file['tmp_name']);
        $src_img  = imagecreatefromstring($src_data);
        if ($src_img !== false) {
            $orig_w = imagesx($src_img);
            $orig_h = imagesy($src_img);
            $max    = 1600;
            if ($orig_w > $max || $orig_h > $max) {
                $ratio = min($max / $orig_w, $max / $orig_h);
                $new_w = (int)round($orig_w * $ratio);
                $new_h = (int)round($orig_h * $ratio);
                $dst_img = imagecreatetruecolor($new_w, $new_h);
                imagecopyresampled($dst_img, $src_img, 0, 0, 0, 0, $new_w, $new_h, $orig_w, $orig_h);
                imagedestroy($src_img);
                $src_img = $dst_img;
            }
            imagejpeg($src_img, $dest, 85);
            imagedestroy($src_img);
        } else {
            move_uploaded_file($file['tmp_name'], $dest);
        }
    } else {
        move_uploaded_file($file['tmp_name'], $dest);
    }

    $stmt = db()->prepare('UPDATE equipment_items SET photo = ? WHERE id = ?');
    $stmt->execute([$dest_rel, $id]);

    json_ok(['photo' => $dest_rel]);
}

/**
 * Public — full deployment history for an item, plus the currently active event.
 */
function handle_item_deployments(): void {
    require_method('GET');

    $qr = trim($_GET['qr'] ?? '');
    if ($qr === '') json_error('qr required');

    $db = db();

    // Resolve item
    $stmt = $db->prepare('SELECT id FROM equipment_items WHERE qr_code = ?');
    $stmt->execute([$qr]);
    $item = $stmt->fetch();
    if (!$item) json_error('Item not found', 404);
    $item_id = (int)$item['id'];

    // Active event (for the log-deployment form)
    $stmt = $db->prepare('SELECT id, name, event_date FROM events WHERE is_active = 1 LIMIT 1');
    $stmt->execute();
    $active_event = $stmt->fetch() ?: null;

    // All deployments for this item, newest event first
    $stmt = $db->prepare(
        'SELECT d.id, d.notes, d.latitude, d.longitude, d.logged_at,
                u.display_name AS logged_by_name,
                e.id AS event_id, e.name AS event_name, e.event_date
         FROM item_deployments d
         JOIN events e ON e.id = d.event_id
         LEFT JOIN users u ON u.id = d.logged_by
         WHERE d.item_id = ?
         ORDER BY COALESCE(e.event_date, \'0000-01-01\') DESC, d.logged_at DESC'
    );
    $stmt->execute([$item_id]);
    $rows = $stmt->fetchAll();

    // All photos for this item (general + deployment-linked), keyed by deployment_id
    $stmt = $db->prepare(
        'SELECT id, deployment_id, path, caption, uploaded_at
         FROM item_photos
         WHERE item_id = ?
         ORDER BY uploaded_at ASC'
    );
    $stmt->execute([$item_id]);
    $photos_by_dep = [];
    foreach ($stmt->fetchAll() as $p) {
        $key = $p['deployment_id'] ?? 'general';
        $photos_by_dep[$key][] = [
            'id'          => (int)$p['id'],
            'path'        => $p['path'],
            'caption'     => $p['caption'],
            'uploaded_at' => $p['uploaded_at'],
        ];
    }

    $deployments = array_map(fn($d) => [
        'id'           => (int)$d['id'],
        'event_id'     => (int)$d['event_id'],
        'event_name'   => $d['event_name'],
        'event_date'   => $d['event_date'],
        'notes'        => $d['notes'],
        'latitude'     => $d['latitude'] !== null ? (float)$d['latitude'] : null,
        'longitude'    => $d['longitude'] !== null ? (float)$d['longitude'] : null,
        'logged_by'    => $d['logged_by_name'],
        'logged_at'    => $d['logged_at'],
        'photos'       => $photos_by_dep[(int)$d['id']] ?? [],
    ], $rows);

    json_ok([
        'item_id'      => $item_id,
        'active_event' => $active_event,
        'general_photos' => $photos_by_dep['general'] ?? [],
        'deployments'  => $deployments,
    ]);
}

/**
 * Auth — log or update a deployment for the currently active event.
 * Upserts by (item_id, event_id) so re-scanning is always safe.
 */
function handle_log_deployment(): void {
    require_method('POST');
    require_permission('checkout_equipment');
    verify_csrf();

    $body = body();
    $qr    = trim($body['qr'] ?? '');
    $notes = trim($body['notes'] ?? '') ?: null;
    $lat   = isset($body['latitude'])  ? (float)$body['latitude']  : null;
    $lng   = isset($body['longitude']) ? (float)$body['longitude'] : null;

    if ($qr === '') json_error('qr required');

    $db = db();

    // Resolve item
    $stmt = $db->prepare('SELECT id FROM equipment_items WHERE qr_code = ?');
    $stmt->execute([$qr]);
    $item = $stmt->fetch();
    if (!$item) json_error('Item not found', 404);

    // Require an active event
    $stmt = $db->prepare('SELECT id, name FROM events WHERE is_active = 1 LIMIT 1');
    $stmt->execute();
    $event = $stmt->fetch();
    if (!$event) json_error('No active event — ask a production admin to start one', 409);

    $item_id  = (int)$item['id'];
    $event_id = (int)$event['id'];
    $user_id  = $_SESSION['user_id'] ?? null;

    // Upsert: insert or update notes/geo if already logged for this event
    $stmt = $db->prepare(
        'INSERT INTO item_deployments (item_id, event_id, notes, latitude, longitude, logged_by, logged_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
             notes     = VALUES(notes),
             latitude  = VALUES(latitude),
             longitude = VALUES(longitude),
             logged_by = VALUES(logged_by),
             logged_at = NOW()'
    );
    $stmt->execute([$item_id, $event_id, $notes, $lat, $lng, $user_id]);

    // Fetch the resulting deployment id
    $stmt = $db->prepare(
        'SELECT id FROM item_deployments WHERE item_id = ? AND event_id = ?'
    );
    $stmt->execute([$item_id, $event_id]);
    $dep = $stmt->fetch();

    json_ok([
        'deployment_id' => (int)$dep['id'],
        'event'         => ['id' => $event_id, 'name' => $event['name']],
    ]);
}

/**
 * Auth — upload a photo linked to a deployment (or as a general item photo).
 * Accepts: multipart with 'photo' file and 'deployment_id' (optional).
 * Item is identified via 'item_id' POST field.
 */
function handle_upload_deployment_photo(): void {
    require_method('POST');
    require_permission('checkout_equipment');
    verify_csrf();

    $item_id      = (int)($_POST['item_id']      ?? 0);
    $deployment_id = isset($_POST['deployment_id']) ? (int)$_POST['deployment_id'] : null;

    if (!$item_id) json_error('item_id required');

    $db = db();

    // Verify item
    $stmt = $db->prepare('SELECT id FROM equipment_items WHERE id = ?');
    $stmt->execute([$item_id]);
    if (!$stmt->fetch()) json_error('Item not found', 404);

    // Verify deployment belongs to item (if provided)
    if ($deployment_id !== null) {
        $stmt = $db->prepare('SELECT id FROM item_deployments WHERE id = ? AND item_id = ?');
        $stmt->execute([$deployment_id, $item_id]);
        if (!$stmt->fetch()) json_error('Deployment not found for this item', 404);
    }

    if (empty($_FILES['photo']) || $_FILES['photo']['error'] !== UPLOAD_ERR_OK) {
        json_error('No file uploaded or upload error: ' . ($_FILES['photo']['error'] ?? -1));
    }

    $file = $_FILES['photo'];
    $mime = mime_content_type($file['tmp_name']);
    if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], true)) {
        json_error('Only image files are accepted');
    }

    $dir = __DIR__ . '/../../../storage/item_photos/';
    if (!is_dir($dir)) mkdir($dir, 0755, true);

    // Insert photo row first to get the id for the filename
    $user_id = $_SESSION['user_id'] ?? null;
    $stmt = $db->prepare(
        'INSERT INTO item_photos (item_id, deployment_id, path, uploaded_by) VALUES (?, ?, \'\', ?)'
    );
    $stmt->execute([$item_id, $deployment_id, $user_id]);
    $photo_id = (int)$db->lastInsertId();

    $dest_rel = 'storage/item_photos/photo_' . $photo_id . '.jpg';
    $dest     = __DIR__ . '/../../../' . $dest_rel;

    if (function_exists('imagecreatefromstring')) {
        $src_data = file_get_contents($file['tmp_name']);
        $src_img  = imagecreatefromstring($src_data);
        if ($src_img !== false) {
            $orig_w = imagesx($src_img);
            $orig_h = imagesy($src_img);
            $max    = 1600;
            if ($orig_w > $max || $orig_h > $max) {
                $ratio   = min($max / $orig_w, $max / $orig_h);
                $new_w   = (int)round($orig_w * $ratio);
                $new_h   = (int)round($orig_h * $ratio);
                $dst_img = imagecreatetruecolor($new_w, $new_h);
                imagecopyresampled($dst_img, $src_img, 0, 0, 0, 0, $new_w, $new_h, $orig_w, $orig_h);
                imagedestroy($src_img);
                $src_img = $dst_img;
            }
            imagejpeg($src_img, $dest, 85);
            imagedestroy($src_img);
        } else {
            move_uploaded_file($file['tmp_name'], $dest);
        }
    } else {
        move_uploaded_file($file['tmp_name'], $dest);
    }

    $stmt = $db->prepare('UPDATE item_photos SET path = ? WHERE id = ?');
    $stmt->execute([$dest_rel, $photo_id]);

    json_ok(['photo_id' => $photo_id, 'path' => $dest_rel]);
}

/**
 * Public — get the current contents manifest for a crate item.
 */
function handle_get_manifest(): void {
    require_method('GET');

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('id required');

    $db = db();

    // Verify item exists and is a crate type
    $stmt = $db->prepare(
        'SELECT i.id, t.is_crate, t.deployment_destination
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         WHERE i.id = ?'
    );
    $stmt->execute([$id]);
    $item = $stmt->fetch();
    if (!$item) json_error('Item not found', 404);
    if (!$item['is_crate']) json_error('Item is not a crate', 404);

    $stmt = $db->prepare(
        'SELECT id, content_name, quantity, notes, sort_order
         FROM crate_manifest WHERE item_id = ? ORDER BY sort_order, id'
    );
    $stmt->execute([$id]);
    $rows = array_map(fn($r) => [
        'id'           => (int)$r['id'],
        'content_name' => $r['content_name'],
        'quantity'     => (int)$r['quantity'],
        'notes'        => $r['notes'],
        'sort_order'   => (int)$r['sort_order'],
    ], $stmt->fetchAll());

    json_ok([
        'item_id'                => $id,
        'deployment_destination' => $item['deployment_destination'],
        'manifest'               => $rows,
    ]);
}

/**
 * Auth — replace the contents manifest for a crate item.
 * Full replace: all existing rows are deleted, submitted rows inserted.
 */
function handle_save_manifest(): void {
    require_method('PUT');
    require_permission('checkout_equipment');
    verify_csrf();

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('id required');

    $b    = body();
    $rows = $b['rows'] ?? [];
    if (!is_array($rows)) json_error('rows must be an array');
    if (count($rows) > 200) json_error('Maximum 200 rows allowed');

    $db = db();

    // Verify item is a crate
    $stmt = $db->prepare(
        'SELECT i.id FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         WHERE i.id = ? AND t.is_crate = 1'
    );
    $stmt->execute([$id]);
    if (!$stmt->fetch()) json_error('Crate item not found', 404);

    $db->beginTransaction();
    try {
        $db->prepare('DELETE FROM crate_manifest WHERE item_id = ?')->execute([$id]);

        if (!empty($rows)) {
            $ins = $db->prepare(
                'INSERT INTO crate_manifest (item_id, content_name, quantity, notes, sort_order)
                 VALUES (?, ?, ?, ?, ?)'
            );
            foreach ($rows as $i => $r) {
                $name = trim($r['content_name'] ?? '');
                $qty  = max(1, (int)($r['quantity'] ?? 1));
                $notes = isset($r['notes']) && trim($r['notes']) !== '' ? trim($r['notes']) : null;
                $sort  = (int)($r['sort_order'] ?? $i);
                if ($name === '') continue;
                $ins->execute([$id, $name, $qty, $notes, $sort]);
            }
        }
        $db->commit();
    } catch (Throwable $e) {
        $db->rollBack();
        throw $e;
    }

    json_ok(['saved' => true]);
}

/**
 * Auth — delete a gallery photo by id.
 */
function handle_delete_item_photo_gallery(): void {
    require_method('DELETE');
    require_permission('manage_equipment');
    verify_csrf();

    $id = (int)($_GET['id'] ?? 0);
    if (!$id) json_error('id required');

    $stmt = db()->prepare('SELECT path FROM item_photos WHERE id = ?');
    $stmt->execute([$id]);
    $photo = $stmt->fetch();
    if (!$photo) json_error('Photo not found', 404);

    $stmt = db()->prepare('DELETE FROM item_photos WHERE id = ?');
    $stmt->execute([$id]);

    // Best-effort file removal
    $abs = __DIR__ . '/../../../' . $photo['path'];
    if (is_file($abs)) @unlink($abs);

    json_ok(['deleted' => true]);
}

// ─── POST /items/location ─────────────────────────────────────────────────────
// Update the current GPS position of an item. Writes equipment_items.latitude/longitude
// AND appends an item_deployments row for history.
//
// Two ways to be authorized:
//   - update_item_location: can set the location of any item
//   - request_fills: a barrio-identify session (see handle_barrio_identify) can set
//     the location of a water cube currently checked out to its own barrio only
function handle_update_item_location(): void {
    require_method('POST');
    $user = require_auth();
    verify_csrf();

    $b         = body();
    $qr        = trim($b['qr'] ?? '');
    $latitude  = isset($b['latitude'])  ? (float)$b['latitude']  : null;
    $longitude = isset($b['longitude']) ? (float)$b['longitude'] : null;

    if ($qr === '' || $latitude === null || $longitude === null) {
        json_error('qr, latitude, and longitude required');
    }

    $stmt = db()->prepare(
        'SELECT i.id, i.current_barrio_id, t.category
         FROM equipment_items i
         JOIN equipment_types t ON t.id = i.equipment_type_id
         WHERE i.qr_code = ?'
    );
    $stmt->execute([$qr]);
    $item = $stmt->fetch();
    if (!$item) json_error('Item not found', 404);

    $can_set_own_cube = has_permission('request_fills')
        && $item['category'] === 'water_cube'
        && !empty($user['barrio_id'])
        && (int)$item['current_barrio_id'] === (int)$user['barrio_id'];

    if (!has_permission('update_item_location') && !$can_set_own_cube) {
        json_error('Forbidden', 403);
    }

    $item_id = (int)$item['id'];
    $db      = db();

    // Update current position on the item
    $stmt = $db->prepare('UPDATE equipment_items SET latitude = ?, longitude = ? WHERE id = ?');
    $stmt->execute([$latitude, $longitude, $item_id]);

    // Append to deployment history if there is an active event
    $stmt = $db->prepare('SELECT id FROM events WHERE is_active = 1 LIMIT 1');
    $stmt->execute();
    $event = $stmt->fetch();
    if ($event) {
        $stmt = $db->prepare(
            'INSERT INTO item_deployments (item_id, event_id, latitude, longitude, logged_by, logged_at)
             VALUES (?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
                 latitude  = VALUES(latitude),
                 longitude = VALUES(longitude),
                 logged_by = VALUES(logged_by),
                 logged_at = NOW()'
        );
        $stmt->execute([$item_id, (int)$event['id'], $latitude, $longitude, $user['id'] ?? null]);
    }

    json_ok(['success' => true]);
}

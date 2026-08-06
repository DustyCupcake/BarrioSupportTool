<?php
declare(strict_types=1);

// Shared helpers for the equipment_items/transactions holder model
// (holder_type ENUM('department','group','person') + holder_id, replacing
// the old current_dept_id/current_barrio_id/current_artist_id/current_person_id
// four-column design). See migrate_groups_holder_model.sql for the full
// rationale and the DB trigger that enforces holder_type/status consistency.

// Update an item's holder + status (+ optional location) in one statement.
// Covers the common case; call sites with extra fields (dept_label, latitude/
// longitude, home_location, etc.) still issue their own UPDATE alongside/instead.
function set_item_holder(
    PDO $pdo,
    int $item_id,
    ?string $holder_type,
    ?int $holder_id,
    string $status,
    ?int $location_id = null
): void {
    $stmt = $pdo->prepare(
        'UPDATE equipment_items
         SET status = ?, holder_type = ?, holder_id = ?, current_location_id = COALESCE(?, current_location_id)
         WHERE id = ?'
    );
    $stmt->execute([$status, $holder_type, $holder_id, $location_id, $item_id]);
}

// Assign an item to a new holder as part of a checkout (status becomes
// "checked-out"). Shared by handle_checkout / handle_sub_checkout /
// handle_person_checkout / handle_sub_person_checkout in transactions.php —
// this is the exact state-mutation logic that used to be duplicated (and
// independently patched) four times.
//
// $coalesce_owning_dept: true preserves any existing owning_dept_id and only
//   fills it in if currently NULL (sub-checkout tiers); false force-sets it,
//   including to NULL (plain production checkout / production->person).
// $coalesce_dept_label: true keeps the existing label unless a new one is
//   given; false always overwrites (plain production checkout).
function assign_item_holder(
    PDO $pdo,
    int $item_id,
    string $holder_type,
    int $holder_id,
    ?int $owning_dept_id,
    bool $coalesce_owning_dept,
    ?string $dept_label,
    bool $coalesce_dept_label,
    ?float $latitude = null,
    ?float $longitude = null
): void {
    $sets   = ['status = "checked-out"', 'holder_type = ?', 'holder_id = ?'];
    $params = [$holder_type, $holder_id];

    $sets[]   = $coalesce_owning_dept ? 'owning_dept_id = COALESCE(owning_dept_id, ?)' : 'owning_dept_id = ?';
    $params[] = $owning_dept_id;

    $sets[]   = $coalesce_dept_label ? 'dept_label = COALESCE(?, dept_label)' : 'dept_label = ?';
    $params[] = $dept_label;

    if ($latitude !== null)  { $sets[] = 'latitude = COALESCE(?, latitude)';   $params[] = $latitude; }
    if ($longitude !== null) { $sets[] = 'longitude = COALESCE(?, longitude)'; $params[] = $longitude; }

    $params[] = $item_id;
    $pdo->prepare('UPDATE equipment_items SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($params);
}

// Matching transaction-log row for an assign_item_holder() / set_item_holder()
// call. $holder_type/$holder_id may be null (e.g. a checkin releasing an item
// fully to the production pool has no holder to record).
function insert_holder_transaction(
    PDO $pdo,
    string $type,
    int $item_id,
    ?int $dept_id,
    ?string $holder_type,
    ?int $holder_id,
    int $performed_by,
    string $user_name,
    ?string $occurred_at = null,
    bool $is_offline_entry = false,
    ?int $location_id = null
): void {
    $pdo->prepare(
        'INSERT INTO transactions
            (type, item_id, dept_id, holder_type, holder_id, location_id, performed_by, user_name_cache, is_offline_entry, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )->execute([
        $type, $item_id, $dept_id, $holder_type, $holder_id, $location_id,
        $performed_by, $user_name, $is_offline_entry ? 1 : 0, $occurred_at ?? date('Y-m-d H:i:s'),
    ]);
}

// Human-readable label for whoever currently holds an item, replacing the old
// 4-branch _item_location_label() pattern. $item_row must contain at least
// holder_type and holder_id (as read from equipment_items or transactions).
function item_holder_label(PDO $pdo, array $item_row): ?string {
    $holder_type = $item_row['holder_type'] ?? null;
    $holder_id   = $item_row['holder_id'] ?? null;

    if (!$holder_type || !$holder_id) return null;

    switch ($holder_type) {
        case 'department':
            $stmt = $pdo->prepare('SELECT name FROM departments WHERE id = ?');
            $stmt->execute([$holder_id]);
            $r = $stmt->fetch();
            return $r ? $r['name'] : 'unknown dept';
        case 'group':
            $stmt = $pdo->prepare('SELECT name FROM groups WHERE id = ?');
            $stmt->execute([$holder_id]);
            $r = $stmt->fetch();
            return $r ? $r['name'] : 'unknown group';
        case 'person':
            $stmt = $pdo->prepare('SELECT display_name FROM users WHERE id = ?');
            $stmt->execute([$holder_id]);
            $r = $stmt->fetch();
            return $r ? $r['display_name'] : 'unknown person';
        default:
            return null;
    }
}

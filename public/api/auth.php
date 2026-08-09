<?php
declare(strict_types=1);

// ─── Default permission sets per base role ────────────────────────────────────
const ROLE_PERMISSIONS = [
    'production_admin' => [
        'checkout_equipment','checkin_equipment',
        'sub_checkout','sub_checkin',
        'view_inventory','view_dept_inventory',
        'view_groups','manage_groups',
        'manage_equipment','manage_consumables',
        'manage_users','manage_departments',
        'create_invites','manage_orders','submit_orders',
        'label_equipment','manage_shifts',
        'request_fills','fill_truck','view_fill_status',
        'update_item_location',
    ],
    'production_staff' => [
        'checkout_equipment','checkin_equipment',
        'view_inventory','view_groups',
        'request_fills','view_fill_status',
        'update_item_location',
    ],
    'dept_admin' => [
        'sub_checkout','sub_checkin',
        'view_dept_inventory',
        'create_invites','submit_orders','label_equipment',
        'manage_dept_users',
        'update_item_location',
    ],
    'dept_staff' => [
        'view_dept_inventory','submit_orders',
    ],
    'person' => [
        'checkin_equipment','person_borrow',
    ],
    // Legacy aliases — mapped before permission resolution
    'admin'     => [],
    'staff'     => [],
    'validator' => [],
];

// ─── Extra permissions for members of a group-managing department ────────────
// Departments used to come in two hardcoded sub_entity flavors (barrio/artist)
// with separate permission bundles; barrios and artists are now both just
// "groups", so any department that manages groups grants the same bundle.
const GROUP_DEPT_PERMISSIONS = ['view_groups','manage_groups','sub_checkout','sub_checkin','label_equipment'];

// ─── Extra permissions for group_roles members (per-group, not per-dept) ─────
// Someone can be a group_roles member without any user_dept_roles membership
// at all (e.g. a group's own point person who isn't department staff). This
// only grants visibility, not dept-wide sub_checkout/sub_checkin — the
// permission model has no per-group scoping for mutating operations yet, so
// granting those here would give a group lead write access across their
// entire owning department. That's real follow-up work, not done in Phase 3.
const GROUP_ROLE_PERMISSIONS = [
    'group_lead'   => ['view_groups'],
    'group_member' => ['view_groups'],
];

function start_session(): void {
    if (session_status() === PHP_SESSION_NONE) {
        $lifetime = 3600 * 24 * 3;
        ini_set('session.gc_maxlifetime', (string) $lifetime);
        $sessionPath = dirname(__DIR__, 2) . '/sessions';
        if (!is_dir($sessionPath)) {
            mkdir($sessionPath, 0700, true);
        }
        session_save_path($sessionPath);
        session_set_cookie_params([
            'lifetime' => $lifetime,
            'path'     => '/',
            'secure'   => isset($_SERVER['HTTPS']),
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        session_start();
    }
}

function require_auth(): array {
    start_session();
    if (empty($_SESSION['user_id']) && empty($_SESSION['is_shift'])) {
        json_error('Unauthorized', 401);
    }
    return $_SESSION['_auth_cache'] ?? _build_auth_return();
}

function _build_auth_return(): array {
    $data = [
        'id'                 => $_SESSION['user_id'] ?? null,
        'username'           => $_SESSION['username'] ?? null,
        'display_name'       => $_SESSION['display_name'] ?? '',
        'role'               => $_SESSION['role'] ?? null,
        'dept_ids'           => $_SESSION['dept_ids'] ?? [],
        'dept_roles'         => $_SESSION['dept_roles'] ?? [],
        'dept_manages_groups' => $_SESSION['dept_manages_groups'] ?? (object)[],
        'group_ids'          => $_SESSION['group_ids'] ?? [],
        'permissions'        => $_SESSION['permissions'] ?? [],
        'language'           => $_SESSION['language'] ?? 'en',
        'is_shift'           => $_SESSION['is_shift'] ?? false,
        'is_person'          => $_SESSION['is_person'] ?? false,
        'shift_id'           => $_SESSION['shift_id'] ?? null,
        'shift_name'         => $_SESSION['shift_name'] ?? null,
        'group_id'           => $_SESSION['group_id'] ?? null,
        'qr_token'           => $_SESSION['qr_token'] ?? null,
    ];
    $_SESSION['_auth_cache'] = $data;
    return $data;
}

// Generate a QR token for a user if they don't have one yet
function ensure_user_qr_token(int $user_id): string {
    $stmt = db()->prepare('SELECT qr_token FROM users WHERE id = ?');
    $stmt->execute([$user_id]);
    $row = $stmt->fetch();
    if (!empty($row['qr_token'])) return $row['qr_token'];
    $token = bin2hex(random_bytes(16));
    db()->prepare('UPDATE users SET qr_token = ? WHERE id = ?')->execute([$token, $user_id]);
    return $token;
}

function has_permission(string $perm): bool {
    start_session();
    return in_array($perm, $_SESSION['permissions'] ?? [], true);
}

function require_permission(string $perm): array {
    $user = require_auth();
    if (!has_permission($perm)) {
        json_error('Forbidden', 403);
    }
    return $user;
}

// ─── Convenience gate functions ───────────────────────────────────────────────

function require_dept_access(int $dept_id): array {
    $user = require_auth();
    if (in_array('view_inventory', $user['permissions'], true)) return $user; // production level
    if (in_array($dept_id, $user['dept_ids'] ?? [], true)) return $user;
    json_error('Forbidden', 403);
}

// Gate for equipment-type/item catalog management (bulk create, type CRUD, QR sheets).
// Was previously misnamed require_manage_users() and checked the wrong permission
// (manage_users instead of manage_equipment) — invisible in practice because
// production_admin always holds both, but it meant a manage_equipment-only grant
// couldn't touch the catalog, and a manage_users-only grant could.
function require_manage_equipment(): array {
    return require_permission('manage_equipment');
}

// ─── Permission computation (called at login) ─────────────────────────────────

function compute_permissions(string $base_role, array $dept_memberships, array $perm_overrides, array $group_memberships = []): array {
    // Resolve legacy roles
    $effective_role = match($base_role) {
        'admin'     => 'production_admin',
        'staff'     => 'production_staff',
        'validator' => 'dept_staff',
        default     => $base_role,
    };

    $perms = ROLE_PERMISSIONS[$effective_role] ?? [];

    // For dept-level roles, add group-lending permissions if their department manages groups
    if (in_array($effective_role, ['dept_admin', 'dept_staff'], true)) {
        foreach ($dept_memberships as $m) {
            $dept_role = $m['role'];    // dept_admin or dept_staff

            if (!empty($m['manages_groups'])) {
                foreach (GROUP_DEPT_PERMISSIONS as $p) {
                    $perms[] = $p;
                }
            }

            if ($dept_role === 'dept_admin') {
                $perms[] = 'create_invites';
            }
        }
    }

    // Layer group_roles-derived permissions on top, same pattern as dept roles above
    foreach ($group_memberships as $m) {
        foreach (GROUP_ROLE_PERMISSIONS[$m['role']] ?? [] as $p) {
            $perms[] = $p;
        }
    }

    // Apply per-user overrides
    foreach ($perm_overrides as $o) {
        if ($o['granted']) {
            $perms[] = $o['permission'];
        } else {
            $perms = array_diff($perms, [$o['permission']]);
        }
    }

    return array_values(array_unique($perms));
}

// Check if the current session user is eligible to borrow a specific item.
// Returns ['eligible' => bool, 'reason' => string|null]
function check_borrow_eligible(int $item_id, int $type_id): array {
    start_session();

    // Production admin bypasses all restrictions
    if (has_permission('manage_equipment')) {
        return ['eligible' => true, 'reason' => null];
    }

    $user_id   = $_SESSION['user_id']  ?? null;
    $dept_ids  = $_SESSION['dept_ids'] ?? [];
    $is_shift  = $_SESSION['is_shift'] ?? false;

    // Shift sessions cannot borrow personal equipment
    $is_person = $_SESSION['is_person'] ?? false;
    if ($is_shift || (!$user_id && !$is_person)) {
        return ['eligible' => false, 'reason' => 'shift_session'];
    }

    // Check item-level rules first (more specific than type rules)
    $item_stmt = db()->prepare(
        'SELECT allowed_dept_id, allowed_user_id FROM equipment_borrow_rules WHERE item_id = ?'
    );
    $item_stmt->execute([$item_id]);
    $item_rules = $item_stmt->fetchAll();

    if ($item_rules) {
        return _matches_rules($item_rules, (int)$user_id, $dept_ids);
    }

    // Check type-level rules
    $type_stmt = db()->prepare(
        'SELECT allowed_dept_id, allowed_user_id FROM equipment_borrow_rules WHERE equipment_type_id = ?'
    );
    $type_stmt->execute([$type_id]);
    $type_rules = $type_stmt->fetchAll();

    if ($type_rules) {
        return _matches_rules($type_rules, (int)$user_id, $dept_ids);
    }

    // No rules: anyone with checkout or person_borrow permission can borrow
    $can_checkout = has_permission('checkout_equipment') || has_permission('sub_checkout')
                 || has_permission('person_borrow');
    return $can_checkout
        ? ['eligible' => true,  'reason' => null]
        : ['eligible' => false, 'reason' => 'no_permission'];
}

function _matches_rules(array $rules, int $user_id, array $dept_ids): array {
    foreach ($rules as $r) {
        if ($r['allowed_user_id'] && (int)$r['allowed_user_id'] === $user_id) {
            return ['eligible' => true, 'reason' => null];
        }
        if ($r['allowed_dept_id'] && in_array((int)$r['allowed_dept_id'], $dept_ids, true)) {
            return ['eligible' => true, 'reason' => null];
        }
    }
    return ['eligible' => false, 'reason' => 'restricted'];
}

// ─── CSRF ─────────────────────────────────────────────────────────────────────

function csrf_token(): string {
    start_session();
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

function verify_csrf(): void {
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (empty($token) || !hash_equals($_SESSION['csrf_token'] ?? '', $token)) {
        json_error('CSRF token invalid', 403);
    }
}

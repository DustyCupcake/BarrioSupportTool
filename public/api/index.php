<?php
declare(strict_types=1);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');
error_reporting(E_ALL);

require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/response.php';
require_once __DIR__ . '/auth.php';

// Naive DATETIME columns (shift windows, invite/token expiry, order deadlines) are entered
// and displayed as local wall-clock time — strtotime()/time() must agree on what "local" means.
$env = parse_ini_file(__DIR__ . '/../../.env') ?: [];
date_default_timezone_set($env['APP_TIMEZONE'] ?? 'UTC');

header('Content-Type: application/json; charset=utf-8');

set_exception_handler(function (Throwable $e): void {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $e->getMessage()]);
    exit;
});

// Allow same-origin AJAX from the public/ directory
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin) {
    header("Access-Control-Allow-Origin: $origin");
    header('Access-Control-Allow-Credentials: true');
    header('Access-Control-Allow-Headers: Content-Type, X-CSRF-Token');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
}
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Parse route from PATH_INFO or QUERY_STRING fallback
$path = $_SERVER['PATH_INFO'] ?? '';
if (empty($path) && isset($_GET['path'])) {
    $path = '/' . ltrim($_GET['path'], '/');
}
$path = rtrim($path, '/') ?: '/';
$method = $_SERVER['REQUEST_METHOD'];

// Route table
$routes = [
    // Auth
    ['POST', '/auth/register',       'routes/auth.php', 'handle_register'],
    ['POST', '/auth/login',          'routes/auth.php', 'handle_login'],
    ['POST', '/auth/logout',         'routes/auth.php', 'handle_logout'],
    ['GET',  '/auth/me',             'routes/auth.php', 'handle_me'],
    ['GET',  '/auth/csrf',           'routes/auth.php', 'handle_csrf'],
    ['POST', '/auth/language',       'routes/auth.php', 'handle_language'],
    ['GET',  '/auth/invite-info',    'routes/auth.php', 'handle_invite_info'],
    ['GET',  '/auth/shift-info',          'routes/auth.php', 'handle_shift_info'],
    ['POST', '/auth/shift-login',         'routes/auth.php', 'handle_shift_login'],
    ['GET',  '/auth/person-token-info',   'routes/auth.php', 'handle_person_token_info'],
    ['POST', '/auth/person-claim',        'routes/auth.php', 'handle_person_claim'],
    ['POST', '/auth/person-login',        'routes/auth.php', 'handle_person_login'],
    ['POST', '/auth/barrio-identify',     'routes/auth.php', 'handle_barrio_identify'],

    // Staff — inventory & equipment ops
    ['GET',  '/camps',               'routes/camps.php',        'handle_camps'],
    ['GET',  '/items/lookup',         'routes/items.php',        'handle_lookup'],
    ['POST', '/items/location',       'routes/items.php',        'handle_update_item_location'],
    ['POST', '/items/:id/photo',     'routes/items.php',        'handle_upload_item_photo'],
    ['GET',  '/items/deployments',   'routes/items.php',        'handle_item_deployments'],
    ['POST', '/items/deployments',   'routes/items.php',        'handle_log_deployment'],
    ['POST', '/items/deployment-photo', 'routes/items.php',     'handle_upload_deployment_photo'],
    ['DELETE', '/items/photos/:id',  'routes/items.php',        'handle_delete_item_photo_gallery'],
    ['GET',  '/items/:id/manifest',  'routes/items.php',        'handle_get_manifest'],
    ['PUT',  '/items/:id/manifest',  'routes/items.php',        'handle_save_manifest'],
    ['GET',  '/inventory',           'routes/items.php',        'handle_inventory'],
    ['POST', '/checkout',            'routes/transactions.php', 'handle_checkout'],
    ['POST', '/sub-checkout',        'routes/transactions.php', 'handle_sub_checkout'],
    ['POST', '/checkin',             'routes/transactions.php', 'handle_checkin'],
    ['PUT',  '/items/label',         'routes/transactions.php', 'handle_set_label'],
    ['POST', '/items/use',           'routes/transactions.php', 'handle_used'],
    ['POST', '/items/activate',      'routes/transactions.php', 'handle_activate'],
    ['POST', '/items/fill-confirm',  'routes/transactions.php', 'handle_fill_confirm'],

    // Public / unified scan
    ['GET',  '/scan/lookup',         'routes/scan.php',         'handle_scan_lookup'],
    ['GET',  '/voucher/status',      'routes/voucher.php',      'handle_voucher_status'],
    ['GET',  '/item/info',           'routes/item_public.php',  'handle_item_info'],
    ['GET',  '/water/cube-status',   'routes/fill_requests.php','handle_cube_status'],

    // Fill requests — noinfo staff, NWP reps, truck crew
    ['POST',   '/fill-requests',           'routes/fill_requests.php', 'handle_create_fill_request'],
    ['DELETE', '/fill-requests/:id',       'routes/fill_requests.php', 'handle_cancel_fill_request'],
    ['GET',    '/fill-route',              'routes/fill_requests.php', 'handle_fill_route'],
    ['POST',   '/fill/confirm',            'routes/fill_requests.php', 'handle_confirm_fill'],
    ['POST',   '/fill/confirm-adhoc',      'routes/fill_requests.php', 'handle_confirm_adhoc_fill'],
    ['POST',   '/fill/sanitize',           'routes/fill_requests.php', 'handle_sanitize'],
    ['GET',    '/barrios/:id/cubes',       'routes/fill_requests.php', 'handle_barrio_cubes'],

    // Persons & account
    ['GET',  '/person-info',         'routes/persons.php',      'handle_person_info'],
    ['GET',  '/persons',             'routes/persons.php',      'handle_person_search'],
    ['GET',  '/persons/my-items',    'routes/persons.php',      'handle_my_items'],
    ['POST', '/auth/change-password','routes/auth.php',         'handle_change_password'],
    ['POST', '/person-checkout',     'routes/transactions.php', 'handle_person_checkout'],
    ['POST', '/sub-person-checkout', 'routes/transactions.php', 'handle_sub_person_checkout'],

    // Storage locations (public lookup)
    ['GET',  '/locations/lookup',    'routes/locations.php',    'handle_location_lookup'],

    // History & sync
    ['GET',  '/history',             'routes/history.php',      'handle_history'],
    ['POST', '/sync/offline-queue',  'routes/sync.php',         'handle_sync'],

    // Departments
    ['GET',  '/departments',         'routes/departments.php',  'handle_list_departments'],
    ['GET',  '/departments/:id',     'routes/departments.php',  'handle_get_department'],

    // Artists
    ['GET',  '/artists',             'routes/artists.php',      'handle_list_artists'],
    ['GET',  '/artists/:id',         'routes/artists.php',      'handle_get_artist'],

    // Dept equipment orders
    ['GET',  '/dept-orders',         'routes/orders.php',       'handle_get_dept_orders'],
    ['PUT',  '/dept-orders',         'routes/orders.php',       'handle_save_dept_orders'],

    // Barrio lifecycle
    ['GET',  '/barrios',             'routes/barrios.php',      'handle_list_barrios'],
    ['GET',  '/barrios/:id',         'routes/barrios.php',      'handle_get_barrio'],
    ['POST', '/barrio-arrival',      'routes/barrios.php',      'handle_barrio_arrival'],
    ['POST', '/barrio-departure',    'routes/barrios.php',      'handle_barrio_departure'],

    // Consumables & entitlements
    ['GET',    '/consumable-types',              'routes/consumables.php', 'handle_list_consumable_types'],
    ['POST',   '/barrio-distribute',             'routes/consumables.php', 'handle_barrio_distribute'],
    ['GET',    '/admin/consumable-types',        'routes/consumables.php', 'handle_admin_consumable_types'],
    ['POST',   '/admin/consumable-types',        'routes/consumables.php', 'handle_admin_consumable_types'],
    ['PUT',    '/admin/consumable-types',        'routes/consumables.php', 'handle_admin_consumable_types'],
    ['DELETE', '/admin/consumable-types',        'routes/consumables.php', 'handle_admin_consumable_types'],
    ['PUT',    '/admin/barrio-entitlements',     'routes/consumables.php', 'handle_admin_barrio_entitlements'],
    ['PUT',    '/admin/barrio-equipment-orders', 'routes/consumables.php', 'handle_admin_equipment_orders'],
    ['POST',   '/admin/barrios/import-csv',      'routes/consumables.php', 'handle_import_csv'],

    // Admin — departments
    ['GET',    '/admin/departments',             'routes/admin/departments.php', 'handle_list_departments_admin'],
    ['POST',   '/admin/departments',             'routes/admin/departments.php', 'handle_create_department'],
    ['PUT',    '/admin/departments',             'routes/admin/departments.php', 'handle_update_department'],
    ['DELETE', '/admin/departments',             'routes/admin/departments.php', 'handle_delete_department'],
    ['GET',    '/admin/dept-members',            'routes/admin/departments.php', 'handle_dept_members'],
    ['PUT',    '/admin/dept-roles',              'routes/admin/departments.php', 'handle_set_dept_role'],

    // Admin — dept orders aggregate
    ['GET',    '/admin/dept-orders',             'routes/orders.php',            'handle_all_dept_orders'],
    ['GET',    '/admin/barrio-orders-aggregate', 'routes/orders.php',            'handle_barrio_orders_aggregate'],

    // Admin — artists
    ['GET',    '/admin/artists',                 'routes/admin/artists.php',     'handle_list_artists_admin'],
    ['POST',   '/admin/artists',                 'routes/admin/artists.php',     'handle_create_artist'],
    ['PUT',    '/admin/artists',                 'routes/admin/artists.php',     'handle_update_artist'],
    ['DELETE', '/admin/artists',                 'routes/admin/artists.php',     'handle_delete_artist'],
    ['POST',   '/admin/artists/import-csv',      'routes/admin/artists.php',     'handle_import_artists_csv'],

    // Admin — barrios
    ['GET',    '/admin/barrios',                 'routes/admin/barrios.php',     'handle_list'],
    ['POST',   '/admin/barrios',                 'routes/admin/barrios.php',     'handle_create'],
    ['PUT',    '/admin/barrios',                 'routes/admin/barrios.php',     'handle_update'],
    ['DELETE', '/admin/barrios',                 'routes/admin/barrios.php',     'handle_delete'],
    ['POST',   '/admin/barrios/import-locations-csv', 'routes/admin/barrios.php', 'handle_import_locations_csv'],

    // Admin — shifts
    ['GET',    '/admin/shifts',                  'routes/admin/shifts.php',      'handle_list_shifts'],
    ['POST',   '/admin/shifts',                  'routes/admin/shifts.php',      'handle_create_shift'],
    ['PUT',    '/admin/shifts',                  'routes/admin/shifts.php',      'handle_update_shift'],
    ['DELETE', '/admin/shifts',                  'routes/admin/shifts.php',      'handle_delete_shift'],
    ['POST',   '/admin/shifts/tokens',           'routes/admin/shifts.php',      'handle_create_shift_tokens'],
    ['GET',    '/admin/shifts/tokens',           'routes/admin/shifts.php',      'handle_list_shift_tokens'],
    ['GET',    '/admin/shifts/qr-sheet',         'routes/admin/shifts.php',      'handle_shift_qr_sheet'],

    // Admin — invite tokens
    ['GET',    '/admin/invite-tokens',           'routes/admin/invite.php',      'handle_list_invites'],
    ['POST',   '/admin/invite-tokens',           'routes/admin/invite.php',      'handle_create_invite'],
    ['DELETE', '/admin/invite-tokens',           'routes/admin/invite.php',      'handle_revoke_invite'],

    // Admin — equipment types & items
    ['GET',    '/admin/equipment-types',                                  'routes/admin/equipment.php',   'handle_list_types'],
    ['POST',   '/admin/equipment-types',                                  'routes/admin/equipment.php',   'handle_create_type'],
    ['PUT',    '/admin/equipment-types',                                  'routes/admin/equipment.php',   'handle_update_type'],
    ['DELETE', '/admin/equipment-types',                                  'routes/admin/equipment.php',   'handle_delete_type'],
    ['PUT',    '/admin/equipment-types/:id/spec-fields/reorder',          'routes/admin/equipment.php',   'handle_reorder_spec_fields'],
    ['GET',    '/admin/equipment-types/:id/spec-fields',                  'routes/admin/equipment.php',   'handle_list_spec_fields'],
    ['POST',   '/admin/equipment-types/:id/spec-fields',                  'routes/admin/equipment.php',   'handle_create_spec_field'],
    ['PUT',    '/admin/spec-fields/:id',                                  'routes/admin/equipment.php',   'handle_update_spec_field'],
    ['DELETE', '/admin/spec-fields/:id',                                  'routes/admin/equipment.php',   'handle_delete_spec_field'],
    ['GET',    '/admin/items',                   'routes/admin/equipment.php',   'handle_list_items'],
    ['POST',   '/admin/items',                   'routes/admin/equipment.php',   'handle_create_items'],
    ['POST',   '/admin/items/bulk-update',       'routes/admin/equipment.php',   'handle_bulk_update_items'],
    ['POST',   '/admin/items/import-status-csv', 'routes/admin/equipment.php',   'handle_import_status_csv'],
    ['PUT',    '/admin/items',                   'routes/admin/equipment.php',   'handle_update_item'],
    ['DELETE', '/admin/items',                   'routes/admin/equipment.php',   'handle_delete_item'],
    ['GET',    '/admin/items/qr-sheet',          'routes/admin/qr_sheet.php',    'handle_qr_sheet'],
    ['GET',    '/admin/barrio-qr',               'routes/admin/barrio_qr.php',   'handle_barrio_qr'],
    ['GET',    '/admin/dept-qr',                'routes/admin/dept_qr.php',     'handle_dept_qr'],
    ['GET',    '/my-qr',                        'routes/persons.php',           'handle_my_qr'],
    ['GET',    '/my-qr-img',                    'routes/persons.php',           'handle_my_qr_img'],

    // Fill direction claims (truck crew)
    ['GET',  '/fill/direction-status',   'routes/fill_requests.php', 'handle_direction_status'],
    ['POST', '/fill/claim-direction',    'routes/fill_requests.php', 'handle_claim_direction'],
    ['POST', '/fill/release-direction',  'routes/fill_requests.php', 'handle_release_direction'],

    // Admin — fill credits & route ordering
    ['POST', '/admin/sell-fill-credits', 'routes/fill_requests.php', 'handle_sell_fill_credits'],
    ['GET',  '/admin/fill-route/cubes',  'routes/fill_requests.php', 'handle_admin_fill_route_cubes'],
    ['PUT',  '/admin/fill-route/order',  'routes/fill_requests.php', 'handle_admin_save_fill_route'],
    ['POST', '/admin/fill-route/apply-barrio-locations', 'routes/fill_requests.php', 'handle_admin_apply_barrio_locations'],

    // Admin — storage locations
    ['GET',    '/admin/storage-locations',          'routes/admin/storage_locations.php', 'handle_list_locations'],
    ['POST',   '/admin/storage-locations',          'routes/admin/storage_locations.php', 'handle_create_location'],
    ['PUT',    '/admin/storage-locations/:id',      'routes/admin/storage_locations.php', 'handle_update_location'],
    ['DELETE', '/admin/storage-locations/:id',      'routes/admin/storage_locations.php', 'handle_delete_location'],
    ['GET',    '/admin/storage-locations/qr-sheet', 'routes/admin/storage_locations.php', 'handle_location_qr_sheet'],

    // Admin — person badge pool
    ['GET',    '/admin/person-tokens',              'routes/admin/person_tokens.php', 'handle_list_person_tokens'],
    ['POST',   '/admin/person-tokens',              'routes/admin/person_tokens.php', 'handle_generate_person_tokens'],
    ['DELETE', '/admin/person-tokens/:id',          'routes/admin/person_tokens.php', 'handle_delete_person_token'],
    ['GET',    '/admin/person-tokens/qr-sheet',     'routes/admin/person_tokens.php', 'handle_person_token_qr_sheet'],

    // Admin — borrow rules
    ['GET',    '/admin/borrow-rules',               'routes/admin/borrow_rules.php',  'handle_list_borrow_rules'],
    ['POST',   '/admin/borrow-rules',               'routes/admin/borrow_rules.php',  'handle_add_borrow_rule'],
    ['DELETE', '/admin/borrow-rules/:id',           'routes/admin/borrow_rules.php',  'handle_delete_borrow_rule'],

    // Admin — QR print templates
    ['GET',    '/admin/qr-templates',                        'routes/admin/qr_templates.php', 'handle_qrt_list'],
    ['POST',   '/admin/qr-templates',                        'routes/admin/qr_templates.php', 'handle_qrt_create'],
    ['DELETE', '/admin/qr-templates/:id',                    'routes/admin/qr_templates.php', 'handle_qrt_delete'],
    ['GET',    '/admin/qr-templates/:id/preview',            'routes/admin/qr_templates.php', 'handle_qrt_preview'],
    ['GET',    '/admin/qr-templates/:id/zones',              'routes/admin/qr_templates.php', 'handle_qrt_get_zones'],
    ['PUT',    '/admin/qr-templates/:id/zones',              'routes/admin/qr_templates.php', 'handle_qrt_save_zones'],
    ['POST',   '/admin/qr-templates/:id/generate',           'routes/admin/qr_templates.php', 'handle_qrt_generate'],
    ['POST',   '/admin/qr-templates/:id/replace-file',       'routes/admin/qr_templates.php', 'handle_qrt_replace_file'],
    ['POST',   '/admin/qr-templates/:id/duplicate',          'routes/admin/qr_templates.php', 'handle_qrt_duplicate'],

    // Admin — system reset / new event
    ['POST',   '/admin/system/reset',            'routes/admin/system.php',      'handle_system_reset'],
    ['GET',    '/admin/system/active-event',     'routes/admin/system.php',      'handle_active_event'],

    // Admin — users
    ['GET',    '/admin/users/search',            'routes/admin/users.php',       'handle_search'],
    ['GET',    '/admin/users',                   'routes/admin/users.php',       'handle_list'],
    ['POST',   '/admin/users',                   'routes/admin/users.php',       'handle_create'],
    ['PUT',    '/admin/users/permissions',       'routes/admin/users.php',       'handle_update_permissions'],
    ['PUT',    '/admin/users',                   'routes/admin/users.php',       'handle_update'],
    ['DELETE', '/admin/users',                   'routes/admin/users.php',       'handle_delete'],
    ['POST',   '/admin/users/reset-password',    'routes/admin/users.php',       'handle_reset_password'],
    ['GET',    '/admin/users/qr-sheet',          'routes/admin/users.php',       'handle_user_qr_sheet'],

    // Admin — system
    ['POST',   '/admin/system/reset',            'routes/admin/system.php',      'handle_reset'],
];

$matched = false;
foreach ($routes as [$rm, $rp, $file, $fn]) {
    // Support :id segment matching
    $pattern = preg_replace('#/:([^/]+)#', '/(?P<$1>[^/]+)', $rp);
    if ($method === $rm && preg_match("#^{$pattern}$#", $path, $m)) {
        // Put named capture groups into $_GET for convenience
        foreach ($m as $k => $v) {
            if (!is_int($k)) $_GET[$k] = $v;
        }
        require_once __DIR__ . '/' . $file;
        $fn();
        $matched = true;
        break;
    }
}

if (!$matched) {
    json_error('Not found', 404);
}

<?php
declare(strict_types=1);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');
error_reporting(E_ALL);

require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/response.php';
require_once __DIR__ . '/auth.php';

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
    ['POST', '/auth/register', 'routes/auth.php',              'handle_register'],
    ['POST', '/auth/login',    'routes/auth.php',              'handle_login'],
    ['POST', '/auth/logout',   'routes/auth.php',              'handle_logout'],
    ['GET',  '/auth/me',       'routes/auth.php',              'handle_me'],
    ['GET',  '/auth/csrf',     'routes/auth.php',              'handle_csrf'],

    // Staff
    ['GET',  '/camps',                  'routes/camps.php',         'handle_camps'],
    ['GET',  '/items/lookup',           'routes/items.php',         'handle_lookup'],
    ['GET',  '/inventory',              'routes/items.php',         'handle_inventory'],
    ['POST', '/checkout',               'routes/transactions.php',  'handle_checkout'],
    ['POST', '/checkin',                'routes/transactions.php',  'handle_checkin'],
    ['GET',  '/history',                'routes/history.php',       'handle_history'],
    ['POST', '/sync/offline-queue',     'routes/sync.php',          'handle_sync'],

    // Barrio lifecycle (arrival / departure)
    ['GET',  '/barrios',          'routes/barrios.php', 'handle_list_barrios'],
    ['GET',  '/barrios/:id',      'routes/barrios.php', 'handle_get_barrio'],
    ['POST', '/barrio-arrival',   'routes/barrios.php', 'handle_barrio_arrival'],
    ['POST', '/barrio-departure', 'routes/barrios.php', 'handle_barrio_departure'],

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

    // Admin — barrios
    ['GET',    '/admin/barrios',        'routes/admin/barrios.php', 'handle_list'],
    ['POST',   '/admin/barrios',        'routes/admin/barrios.php', 'handle_create'],
    ['PUT',    '/admin/barrios',        'routes/admin/barrios.php', 'handle_update'],
    ['DELETE', '/admin/barrios',        'routes/admin/barrios.php', 'handle_delete'],

    // Admin — equipment types & items
    ['GET',    '/admin/equipment-types',        'routes/admin/equipment.php', 'handle_list_types'],
    ['POST',   '/admin/equipment-types',        'routes/admin/equipment.php', 'handle_create_type'],
    ['PUT',    '/admin/equipment-types',        'routes/admin/equipment.php', 'handle_update_type'],
    ['DELETE', '/admin/equipment-types',        'routes/admin/equipment.php', 'handle_delete_type'],
    ['GET',    '/admin/items',                  'routes/admin/equipment.php', 'handle_list_items'],
    ['POST',   '/admin/items',                  'routes/admin/equipment.php', 'handle_create_items'],
    ['PUT',    '/admin/items',                  'routes/admin/equipment.php', 'handle_update_item'],
    ['DELETE', '/admin/items',                  'routes/admin/equipment.php', 'handle_delete_item'],
    ['GET',    '/admin/items/qr-sheet',         'routes/admin/qr_sheet.php',  'handle_qr_sheet'],
    ['GET',    '/admin/barrio-qr',             'routes/admin/barrio_qr.php', 'handle_barrio_qr'],

    // Admin — users
    ['GET',    '/admin/users',                  'routes/admin/users.php', 'handle_list'],
    ['POST',   '/admin/users',                  'routes/admin/users.php', 'handle_create'],
    ['PUT',    '/admin/users',                  'routes/admin/users.php', 'handle_update'],
    ['DELETE', '/admin/users',                  'routes/admin/users.php', 'handle_delete'],
    ['POST',   '/admin/users/reset-password',   'routes/admin/users.php', 'handle_reset_password'],
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

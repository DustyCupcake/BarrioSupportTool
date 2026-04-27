<?php
declare(strict_types=1);

function handle_camps(): void {
    require_method('GET');
    require_auth();

    $rows = db()->query('SELECT id, name, arrival_status FROM barrios WHERE 1 ORDER BY sort_order, name')->fetchAll();
    json_ok(['camps' => $rows]);
}

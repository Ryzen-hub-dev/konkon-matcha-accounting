<?php
require_once __DIR__ . '/core/response.php';
api_success([
    'service' => 'Matcha Accounting API',
    'status' => 'healthy',
    'time' => gmdate('c')
]);

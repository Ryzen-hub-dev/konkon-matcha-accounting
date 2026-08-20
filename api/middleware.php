<?php
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/core/jwt.php';
require_once __DIR__ . '/core/response.php';

$config = require __DIR__ . '/config.php';
$payload = auth_payload_from_request($config);
if (empty($payload)) {
    api_error('Unauthorized', 'UNAUTHORIZED', 401);
}

[$required, $tokenPermission] = ['', $_GET['permission'] ?? ''];
$required = $payload['required_permission'] ?? '';
if ($required === '' && $tokenPermission !== '') {
    $required = $tokenPermission;
}
if ($required !== '') {
    $permissions = $payload['permissions'] ?? [];
    if (!in_array($required, $permissions, true)) {
        api_error('Forbidden', 'FORBIDDEN', 403);
    }
}


<?php
require_once __DIR__ . '/core/cors.php';
require_once __DIR__ . '/core/response.php';
require_once __DIR__ . '/core/jwt.php';

$requestBody = request_body();

if (!isset($_SESSION)) {
    session_start();
}

$token = $requestBody['refreshToken'] ?? '';
$log = [
    'event' => 'logout',
    'token_hint' => is_string($token) ? substr($token, 0, 8) . '...' : '',
    'time' => gmdate('c'),
    'ip' => $_SERVER['REMOTE_ADDR'] ?? 'unknown'
];

if (!is_dir(__DIR__ . '/../logs')) {
    mkdir(__DIR__ . '/../logs', 0755, true);
}
file_put_contents(__DIR__ . '/../logs/audit.log', json_encode($log, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL, FILE_APPEND);

api_success(['ok' => true], 'Logout success');

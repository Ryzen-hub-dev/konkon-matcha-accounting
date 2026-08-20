<?php
require_once __DIR__ . '/cors.php';

function json_response(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function api_error(string $message, string $code = 'error', int $status = 400, array $extra = []): void
{
    $payload = array_merge([
        'success' => false,
        'message' => $message,
        'error' => [
            'code' => $code,
            'time' => gmdate('c')
        ]
    ], $extra);

    log_error($message);
    json_response($payload, $status);
}

function api_success($data, string $message = 'OK', int $status = 200): void
{
    $payload = [
        'success' => true,
        'message' => $message,
        'data' => $data
    ];

    json_response($payload, $status);
}

function request_body(): array
{
    $raw = file_get_contents('php://input');
    if (!$raw) {
        return [];
    }

    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function limit_rate_per_ip(string $endpointKey, int $limit = 30, int $windowSeconds = 60): void
{
    if (!isset($_SESSION)) {
        session_start();
    }

    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $key = $endpointKey . ':' . $ip;
    $now = time();

    if (!isset($_SESSION[$key])) {
        $_SESSION[$key] = ['count' => 0, 'start' => $now];
    }

    $entry = $_SESSION[$key];
    if (($now - $entry['start']) > $windowSeconds) {
        $entry = ['count' => 0, 'start' => $now];
    }

    $entry['count'] += 1;
    $_SESSION[$key] = $entry;

    if ($entry['count'] > $limit) {
        api_error('Rate limit exceeded', 'RATE_LIMIT', 429);
    }
}

function log_error(string $message): void
{
    $line = sprintf("[%s] %s [%s] %s\n", gmdate('c'), $_SERVER['REMOTE_ADDR'] ?? '-', $_SERVER['REQUEST_URI'] ?? '-', $message);
    @file_put_contents(__DIR__ . '/../logs/error.log', $line, FILE_APPEND);
}

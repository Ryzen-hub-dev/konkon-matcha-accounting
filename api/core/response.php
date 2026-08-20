<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

function json_response(array $payload, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function api_error(string $message, string $code = 'error', int $status = 400, array $extra = []): void {
    json_response(array_merge([
        'success' => false,
        'message' => $message,
        'error' => [
            'code' => $code,
            'time' => gmdate('c')
        ]
    ], $extra), $status);
}

function api_success($data, string $message = 'OK', int $status = 200): void {
    json_response([
        'success' => true,
        'message' => $message,
        'data' => $data
    ], $status);
}

function request_body(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) {
        return [];
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function limit_rate_per_ip(string $endpointKey, int $limit = 30, int $windowSeconds = 60): void {
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

    $entry['count'] = (int)$entry['count'] + 1;
    $_SESSION[$key] = $entry;

    if ($entry['count'] > $limit) {
        api_error('Rate limit exceeded', 'RATE_LIMIT', 429);
    }
}

function log_error(string $message): void {
    if (!is_dir(__DIR__ . '/../logs')) {
        @mkdir(__DIR__ . '/../logs', 0755, true);
    }
    $line = sprintf('[%s] %s [%s] %s' . PHP_EOL, gmdate('c'), $_SERVER['REMOTE_ADDR'] ?? '-', $_SERVER['REQUEST_URI'] ?? '-', $message);
    @file_put_contents(__DIR__ . '/../logs/error.log', $line, FILE_APPEND);
}

set_error_handler(function($severity, $message, $file, $line) {
    log_error("PHP Error: [$severity] $message in $file:$line");
});

set_exception_handler(function($ex) {
    log_error('Uncaught: ' . $ex->getMessage());
    api_error($ex->getMessage(), 'UNCAUGHT', 500);
});

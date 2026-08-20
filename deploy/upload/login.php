<?php
require_once __DIR__ . '/core/cors.php';
require_once __DIR__ . '/core/response.php';
require_once __DIR__ . '/core/jwt.php';

$config = require __DIR__ . '/config.php';
limit_rate_per_ip('login', 20, 60);
$body = request_body();

$username = trim((string)($body['username'] ?? ''));
$password = (string)($body['password'] ?? '');

if ($username === '' || $password === '') {
    api_error('Invalid credentials', 'INVALID_INPUT', 400);
}

$validUsers = [
    [
        'id' => '0001',
        'username' => 'admin',
        'password_hash' => password_hash('password', PASSWORD_ARGON2ID),
        'full_name' => 'System Administrator',
        'email' => 'admin@valaxscrub.rf.gd',
        'role' => 'Admin',
        'permissions' => ['dashboard.read', 'customer.read', 'inventory.read', 'pos.create']
    ]
];

$matched = null;
foreach ($validUsers as $u) {
    if (strtolower($u['username']) === strtolower($username) && password_verify($password, $u['password_hash'])) {
        $matched = $u;
        break;
    }
}

if (!$matched) {
    api_error('Invalid credentials', 'AUTH_FAILED', 401);
}

$tokenPayload = [
    'sub' => $matched['id'],
    'username' => $matched['username'],
    'fullname' => $matched['full_name'],
    'email' => $matched['email'],
    'role' => $matched['role'],
    'permissions' => $matched['permissions']
];

$accessToken = sign_jwt($tokenPayload, $config);
$refreshToken = bin2hex(random_bytes(32));

$loginLog = [
    'user_id' => $matched['id'],
    'username' => $matched['username'],
    'ip' => $_SERVER['REMOTE_ADDR'] ?? 'unknown',
    'ua' => $_SERVER['HTTP_USER_AGENT'] ?? '',
    'time' => gmdate('c')
];

if (!is_dir(__DIR__ . '/../logs')) {
    mkdir(__DIR__ . '/../logs', 0755, true);
}
file_put_contents(__DIR__ . '/../logs/login.log', json_encode($loginLog, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL, FILE_APPEND);

api_success([
    'accessToken' => $accessToken,
    'refreshToken' => $refreshToken,
    'expiresInSeconds' => 8 * 3600,
    'user' => [
        'userId' => $matched['id'],
        'username' => $matched['username'],
        'fullName' => $matched['full_name'],
        'email' => $matched['email'],
        'role' => $matched['role']
    ],
    'permissions' => $matched['permissions']
], 'Login success');

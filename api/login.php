<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(200);
    echo json_encode(['success' => true, 'message' => 'CORS preflight ok']);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Only POST is supported']);
    exit;
}

$raw = file_get_contents('php://input');
$data = json_decode($raw, true);
if (!is_array($data)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid JSON body']);
    exit;
}

$username = trim((string)($data['username'] ?? ''));
$password = (string)($data['password'] ?? '');

if ($username === '' || $password === '') {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Invalid credentials']);
    exit;
}

$hash = '$2y$10$7Wf9lDk0r2t4N8V2J7yJkO0e4z6e3D8k6xM1iX8iD4vV5b2a3n0mC';
if (strtolower($username) !== 'admin' || !password_verify($password, $hash)) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Invalid credentials']);
    exit;
}

// minimal response only; keeps login endpoint alive if jwt/json libs fail
$payload = [
    'accessToken' => 'demo-' . bin2hex(random_bytes(16)),
    'refreshToken' => bin2hex(random_bytes(16)),
    'expiresInSeconds' => 28800,
    'user' => [
        'userId' => '0001',
        'username' => 'admin',
        'fullName' => 'System Administrator',
        'email' => 'admin@valaxscrub.rf.gd',
        'role' => 'Admin'
    ],
    'permissions' => ['dashboard.read', 'customer.read', 'inventory.read', 'pos.create']
];

echo json_encode(['success' => true, 'message' => 'Login success', 'data' => $payload]);

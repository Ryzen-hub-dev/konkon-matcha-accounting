<?php

function base64url_encode(string $raw): string
{
    return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
}

function base64url_decode(string $value): string
{
    $padding = 4 - (strlen($value) % 4);
    if ($padding !== 4) {
        $value .= str_repeat('=', $padding);
    }

    return base64_decode(strtr($value, '-_', '+/'));
}

function sign_jwt(array $claims, array $config): string
{
    $issuedAt = time();
    $payload = [
        'iss' => $config['jwt_issuer'],
        'aud' => $config['jwt_audience'],
        'iat' => $issuedAt,
        'exp' => $issuedAt + 8 * 3600,
        'nbf' => $issuedAt,
        'jti' => bin2hex(random_bytes(16)),
    ];

    $payload = array_merge($payload, $claims);
    $encodedHeader = base64url_encode(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $encodedPayload = base64url_encode(json_encode($payload));
    $signature = base64url_encode(hash_hmac('sha256', "$encodedHeader.$encodedPayload", $config['jwt_secret'], true));

    return "$encodedHeader.$encodedPayload.$signature";
}

function verify_jwt(string $token, array $config): array
{
    $parts = explode('.', $token);
    if (count($parts) !== 3) {
        throw new RuntimeException('Invalid token format');
    }

    [$encodedHeader, $encodedPayload, $signature] = $parts;
    $expected = base64url_encode(hash_hmac('sha256', $encodedHeader . '.' . $encodedPayload, $config['jwt_secret'], true));
    if (!hash_equals($expected, $signature)) {
        throw new RuntimeException('Invalid token signature');
    }

    $payload = json_decode(base64url_decode($encodedPayload), true);
    if (!is_array($payload)) {
        throw new RuntimeException('Invalid token payload');
    }

    $now = time();
    if (!empty($payload['nbf']) && $now < (int)$payload['nbf']) {
        throw new RuntimeException('Token not active');
    }
    if (!empty($payload['exp']) && $now > (int)$payload['exp']) {
        throw new RuntimeException('Token expired');
    }

    return $payload;
}

function auth_payload_from_request(array $config): array
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/Bearer\s+(\S+)/', $header, $m)) {
        return [];
    }

    try {
        return verify_jwt($m[1], $config);
    } catch (\Throwable $ex) {
        return [];
    }
}

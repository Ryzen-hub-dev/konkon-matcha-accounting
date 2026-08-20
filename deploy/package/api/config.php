<?php
return [
    'app_name' => 'Matcha Accounting API',
    'env' => 'production',
    'timezone' => 'Asia/Singapore',
    'jwt_secret' => 'replace_with_your_long_random_secret',
    'jwt_issuer' => 'matcha-accounting',
    'jwt_audience' => 'matcha-accounting-clients',
    'db' => [
        'host' => 'sql302.infinityfree.com',
        'port' => 3306,
        'name' => 'if0_12345678_matcha',
        'user' => 'if0_12345678',
        'password' => 'replace_me',
        'charset' => 'utf8mb4'
    ]
];

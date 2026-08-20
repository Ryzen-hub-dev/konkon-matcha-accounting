<?php
require_once __DIR__ . '/../middleware.php';
require_once __DIR__ . '/../core/response.php';

$customers = [
    ['id' => 'CUST-1001', 'name' => 'ACME Trading', 'creditLimit' => 12000],
    ['id' => 'CUST-1002', 'name' => 'North Retail', 'creditLimit' => 5200],
    ['id' => 'CUST-1003', 'name' => 'Green Store', 'creditLimit' => 1000]
];

api_success($customers, 'customer list');

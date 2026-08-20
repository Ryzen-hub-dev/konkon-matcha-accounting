CREATE DATABASE IF NOT EXISTS matcha_accounting CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE matcha_accounting;

CREATE TABLE IF NOT EXISTS users (
    user_id CHAR(36) NOT NULL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    email VARCHAR(200) NULL,
    role ENUM('Admin','Manager','Cashier','Accountant','Staff') NOT NULL DEFAULT 'Staff',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS permissions (
    permission_id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(120) NOT NULL UNIQUE,
    description VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS role_permissions (
    role_name ENUM('Admin','Manager','Cashier','Accountant','Staff') NOT NULL,
    permission_code VARCHAR(120) NOT NULL,
    PRIMARY KEY (role_name, permission_code),
    CONSTRAINT fk_rp_perm FOREIGN KEY (permission_code) REFERENCES permissions(code)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
    log_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id CHAR(36) NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100) NULL,
    entity_id VARCHAR(120) NULL,
    details JSON NULL,
    ip_address VARCHAR(45) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_user_time (user_id, created_at),
    INDEX idx_audit_action_time (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customers (
    customer_id CHAR(36) NOT NULL PRIMARY KEY,
    customer_code VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(180) NOT NULL,
    credit_limit DECIMAL(15,2) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
    product_id CHAR(36) NOT NULL PRIMARY KEY,
    sku VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(180) NOT NULL,
    unit_price DECIMAL(15,2) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_transactions (
    transaction_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    product_id CHAR(36) NOT NULL,
    warehouse_id VARCHAR(80) NOT NULL DEFAULT 'MAIN',
    movement_type ENUM('IN','OUT','ADJUST') NOT NULL,
    quantity INT NOT NULL,
    reference_type VARCHAR(60) NULL,
    reference_id VARCHAR(120) NULL,
    created_by CHAR(36) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_stock_product_time (product_id, created_at),
    CONSTRAINT fk_st_product FOREIGN KEY (product_id) REFERENCES products(product_id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO permissions(code, description) VALUES
('dashboard.read', 'Read dashboard metrics'),
('customer.read', 'Read customer records'),
('customer.create', 'Create customer'),
('inventory.read', 'Read inventory'),
('inventory.adjust', 'Adjust inventory'),
('pos.create', 'Create sales transaction')
ON DUPLICATE KEY UPDATE description = VALUES(description);

INSERT INTO role_permissions(role_name, permission_code)
SELECT role_name, permission_code
FROM (
    SELECT 'Admin' AS role_name, code AS permission_code FROM permissions
) a
ON DUPLICATE KEY UPDATE permission_code = permission_code;

INSERT INTO users(user_id, username, password_hash, full_name, email, role)
VALUES
(UUID(), 'admin', '$2y$10$7Wf9lDk0r2t4N8V2J7yJkO0e4z6e3D8k6xM1iX8iD4vV5b2a3n0mC', 'System Administrator', 'admin@valaxscrub.rf.gd', 'Admin')
ON DUPLICATE KEY UPDATE full_name = full_name;

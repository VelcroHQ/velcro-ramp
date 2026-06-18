-- Velcro Ramp PHP Backend — MySQL Schema
-- Run this against your MySQL/MariaDB database before deploying.

CREATE TABLE IF NOT EXISTS `transactions` (
  `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `reference` VARCHAR(255) NOT NULL UNIQUE,
  `switch_reference` VARCHAR(255) DEFAULT NULL,
  `type` ENUM('OFFRAMP','ONRAMP') NOT NULL,
  `status` VARCHAR(50) DEFAULT 'AWAITING_DEPOSIT',
  `country` VARCHAR(10) NOT NULL,
  `currency` VARCHAR(10) NOT NULL,
  `asset` VARCHAR(50) NOT NULL,
  `channel` VARCHAR(50) DEFAULT 'BANK',
  `amount` DECIMAL(24,8) NOT NULL,
  `rate` DECIMAL(24,8) DEFAULT NULL,
  `fee_total` DECIMAL(24,8) DEFAULT NULL,
  `fee_platform` DECIMAL(24,8) DEFAULT NULL,
  `fee_developer` DECIMAL(24,8) DEFAULT NULL,
  `source_amount` DECIMAL(24,8) DEFAULT NULL,
  `source_currency` VARCHAR(10) DEFAULT NULL,
  `destination_amount` DECIMAL(24,8) DEFAULT NULL,
  `destination_currency` VARCHAR(10) DEFAULT NULL,
  `deposit_address` VARCHAR(255) DEFAULT NULL,
  `deposit_bank_name` VARCHAR(255) DEFAULT NULL,
  `deposit_account_number` VARCHAR(255) DEFAULT NULL,
  `deposit_account_name` VARCHAR(255) DEFAULT NULL,
  `deposit_note` TEXT DEFAULT NULL,
  `beneficiary` JSON DEFAULT NULL,
  `wallet_address` VARCHAR(255) DEFAULT NULL,
  `hash` VARCHAR(255) DEFAULT NULL,
  `explorer_url` VARCHAR(500) DEFAULT NULL,
  `callback_url` VARCHAR(500) DEFAULT NULL,
  `meta` JSON DEFAULT NULL,
  `email` VARCHAR(255) DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_reference` (`reference`),
  KEY `idx_switch_reference` (`switch_reference`),
  KEY `idx_type` (`type`),
  KEY `idx_status` (`status`),
  KEY `idx_country` (`country`),
  KEY `idx_email` (`email`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `otps` (
  `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `otp_key` VARCHAR(100) NOT NULL,
  `code` VARCHAR(20) NOT NULL,
  `expires_at` BIGINT UNSIGNED NOT NULL,
  `attempts` TINYINT UNSIGNED DEFAULT 0,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uniq_key` (`otp_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `paj_sessions` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `token` TEXT NOT NULL,
  `recipient` VARCHAR(255) DEFAULT NULL,
  `is_active` TINYINT(1) DEFAULT 1,
  `expires_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `withdrawal_states` (
  `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `last_withdrawal_at` BIGINT UNSIGNED DEFAULT 0,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed a single withdrawal-state row
INSERT IGNORE INTO `withdrawal_states` (`id`, `last_withdrawal_at`) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `action` VARCHAR(100) NOT NULL,
  `ip` VARCHAR(45) DEFAULT 'unknown',
  `user_agent` VARCHAR(500) DEFAULT 'unknown',
  `details` JSON DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_action` (`action`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
